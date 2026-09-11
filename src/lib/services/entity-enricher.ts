import { normalizePattern } from '@/lib/services/pattern-normalizer';
import { detectConflictSync } from '@/lib/services/entity-conflict-detector';
import type { EntityCandidate } from '@/lib/services/entity-detector';
import type { EntityContextWithGlAccount } from '@/lib/types/entity-context';
import { toConfidenceLabel } from '@/lib/types/reasoning';
import { serverT } from '@/lib/server-i18n';
import { roleIsValidForDirection } from '@/lib/services/direction-filter';
import { resolveEntity } from '@/memory/entity-resolution';
import { createAdapter, lookupTreatment, matchAuthorizedPattern } from '@/memory/classification-knowledge';
import type { ExtendedPrismaClient } from '@/lib/db';

// ========== TYPES ==========

export interface EnrichmentInput {
  companyId: string;
  prismaClient: ExtendedPrismaClient;
  contexts: EntityContextWithGlAccount[];
  glAccounts: Array<{
    id: string;
    name: string;
    code: string;
    accountType?: string;
  }>;
  rolePriorities?: Record<string, number>;
  knownSocioPatterns?: string[];
  /** I9 fix: when true, entity-context (SOCIO) takes precedence over merchant on conflict */
  entityFirstMode?: boolean;
  existingRules?: Array<{
    conditionValue: string | null;
    conditionType: string | null;
  }>;
}

export interface EnrichedCandidate extends EntityCandidate {
  hasContext: boolean;
  contextRole: string;
  suggestedAccountName: string;
  suggestedAccountCode: string;
  suggestedAccountId: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  explanation: string;
  directionWarning?: string | null;
}

export interface ScanEntry {
  count: number;
  sample: string;
  totalAmount: number;
  debitCount: number;
  creditCount: number;
}

export interface ScanPattern {
  id: string;
  description: string;
  rawDescription: string;
  occurrences: number;
  direction: string;
  averageAmount: number;
  suggestedAccount: string;
  suggestedAccountCode: string;
  suggestedAccountId: string;
  hasContext: boolean;
  contextRole: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  explanation: string;
  uncertaintyReasons?: string[];
}

// ========== T5a: RESOLVE CONTEXT ROLE ==========

export function resolveContextRole(
  candidate: EntityCandidate,
  description: string,
  input: EnrichmentInput,
): EntityContextWithGlAccount | null {
  const normalizedDesc = normalizePattern(description);
  const candidateNameLower = candidate.canonicalName.toLowerCase();

  // Filter matching contexts
  let matchingContexts = input.contexts.filter((ctx) => {
    const patternLower = ctx.pattern.toLowerCase();
    return (
      normalizedDesc.includes(patternLower) ||
      candidateNameLower.includes(patternLower) ||
      (candidateNameLower.length >= 3 && patternLower.includes(candidateNameLower))
    );
  });

  // SOCIO conflict detection: exclude SOCIO contexts when merchant + SOCIO INDN conflict
  // I9 fix: old hasSocioConflict() ignored entityFirstMode — now we check it.
  // When entityFirstMode=true, SOCIO wins (don't exclude). When false, merchant wins (exclude SOCIO).
  if (input.knownSocioPatterns?.length) {
    const syncResult = detectConflictSync(description, input.knownSocioPatterns, input.entityFirstMode ?? false);
    if (syncResult.conflict && !syncResult.socioWins) {
      // entityFirstMode is false (or not set) → rule-first → merchant wins → exclude SOCIO
      matchingContexts = matchingContexts.filter((ctx) => ctx.role.toUpperCase() !== 'SOCIO');
    }
  }

  if (matchingContexts.length === 0) return null;
  if (matchingContexts.length === 1) return matchingContexts[0] ?? null;

  // Multiple matches: sort by role priority (lower number = higher priority)
  const priorities = input.rolePriorities ?? {};
  return [...matchingContexts].sort((a, b) => {
    const prioA = priorities[a.role.toUpperCase()] ?? 99;
    const prioB = priorities[b.role.toUpperCase()] ?? 99;
    return prioA - prioB;
  })[0] ?? null;
}

// ========== T5b: SUGGEST GL ACCOUNT ==========
// Post-cutover: source is KE treatment (resolveEntity → lookupTreatment).
// UNKNOWN / NOT_FOUND → null (no suggestion).
// ERROR → propagates as exception (distinguishable from absence of knowledge).

export async function suggestGlAccount(
  companyId: string,
  description: string,
  _context: EntityContextWithGlAccount | null,
  _direction: 'debit' | 'credit' | null,
  glAccounts: EnrichmentInput['glAccounts'],
  prismaClient: ExtendedPrismaClient,
): Promise<{ name: string; code: string; id: string } | null> {
  // Step 1: Entity Resolution
  const entityResolution = await resolveEntity(companyId, description);

  if (entityResolution.status === 'ERROR') {
    throw new Error(`KE entity resolution error: ${entityResolution.reason}`);
  }

  if (entityResolution.status === 'UNKNOWN') {
    return null;
  }

  // Step 2: Treatment Lookup
  const keAdapter = createAdapter(prismaClient, (fn) => prismaClient.$transaction(fn));
  const treatment = await lookupTreatment(keAdapter, companyId, entityResolution.entityId);

  if (treatment.status === 'ERROR') {
    throw new Error(`KE treatment lookup error: ${treatment.reason}`);
  }

  if (treatment.status === 'NOT_FOUND') {
    // Structural match of AUTHORIZED patterns (GENERALIZACIÓN-005 knowledge)
    // before giving up on a suggestion — informative read only, no authority.
    const structural = await matchAuthorizedPattern(
      keAdapter,
      companyId,
      entityResolution.entityId,
      description,
      _direction ?? 'any',
    );

    if (structural.kind === 'error') {
      // ERROR stays explicit — never degraded to "no suggestion"
      throw new Error(`KE structural match error: ${structural.reason}`);
    }
    if (structural.kind === 'ambiguous') {
      // Cannot suggest an undecided GL
      return null;
    }
    // NO_MATCH → null
    if (structural.kind === 'match') {
      const account = glAccounts.find((a) => a.id === structural.glAccountId);
      if (account) {
        return { name: account.name, code: account.code, id: account.id };
      }
      return null;
    }
    return null;
  }

  // Step 3: Resolve GL account from treatment
  const account = glAccounts.find((a) => a.id === treatment.glAccountId);
  if (account) {
    return {
      name: account.name,
      code: account.code,
      id: account.id,
    };
  }

  return null;
}

// ========== T5c: MAJORITY DIRECTION ==========

export function majorityDirection(
  candidate: EntityCandidate,
): 'debit' | 'credit' | null {
  const { creditPct, debitPct } = candidate.directionProfile;

  if (debitPct > 0.5) return 'debit';
  if (creditPct > 0.5) return 'credit';
  return null;
}



// ========== T5d: BUILD SCAN PATTERN ==========

export function buildScanPattern(
  enriched: EnrichedCandidate,
  entityKey: string,
  entry: ScanEntry,
): ScanPattern {
  const isDebit = entry.debitCount >= entry.creditCount;

  return {
    id: Buffer.from(entityKey).toString('base64').replace(/=/g, ''),
    description: entityKey,
    rawDescription: entry.sample,
    occurrences: entry.count,
    direction: isDebit ? 'debit' : 'credit',
    averageAmount: entry.totalAmount / entry.count,
    suggestedAccount: enriched.suggestedAccountName,
    suggestedAccountCode: enriched.suggestedAccountCode,
    suggestedAccountId: enriched.suggestedAccountId,
    hasContext: enriched.hasContext,
    contextRole: enriched.contextRole,
    confidence: enriched.confidence,
    confidenceLabel: enriched.confidenceLabel,
    explanation: enriched.explanation,
  };
}

// ========== T6: ENRICH CANDIDATES PIPELINE ==========

export async function enrichCandidates(
  candidates: EntityCandidate[],
  descriptions: Map<string, string>,
  input: EnrichmentInput,
  options?: {
    smartFrequency?: boolean;
    minOccurrences?: number;
  },
  locale?: string,
): Promise<EnrichedCandidate[]> {
  const result: EnrichedCandidate[] = [];

  for (const candidate of candidates) {
    const entityKey = candidate.canonicalName.toLowerCase();
    const description = descriptions.get(entityKey) ?? candidate.sampleDescriptions[0] ?? '';

    // Step 1: resolve context role
    const context = resolveContextRole(candidate, description, input);

    // Step 2: smartFrequency — adjust minOccurrences threshold
    let effectiveMinOccurrences = options?.minOccurrences ?? 1;
    if (options?.smartFrequency) {
      effectiveMinOccurrences = context ? 1 : (options?.minOccurrences ?? 2);
    }
    if (candidate.occurrences < effectiveMinOccurrences) continue;

    // Step 3: suggest GL account via KE treatment lookup
    const direction = majorityDirection(candidate);
    const suggested = await suggestGlAccount(
      input.companyId,
      description,
      context,
      direction,
      input.glAccounts,
      input.prismaClient,
    );

    // Step 4: compute confidence — multi-factor instead of binary 0.0/0.95
    const directionMatch = direction && context
      ? roleIsValidForDirection(context.role, candidate.directionProfile).valid
      : false;
    const occurrenceBoost = candidate.occurrences > 1 ? 0.05 : 0;
    const directionBoost = directionMatch ? 0.1 : 0;
    const contextBoost = context ? 0.3 : 0;
    const confidence = Math.min(contextBoost + directionBoost + occurrenceBoost + 0.5, 0.95);
    const confidenceLabel = toConfidenceLabel(confidence);
    const explanation = context
      ? serverT(locale, 'reasoning.entityContextHigh')
          .replace('{role}', context.role)
          .replace('{confidence}', String(Math.round(confidence * 100)))
      : serverT(locale, 'reasoning.sinClasificar')
          .replace('{reasons}', serverT(locale, 'reasoning.uncertaintyNoContext'));

    // Step 5: skip if an existing rule already covers this pattern
    if (hasExistingRule(candidate, description, input.existingRules)) continue;

    // Step 6: check role ↔ direction mismatch via canonical validator
    const roleToCheck = context?.role ?? '';
    const directionWarning = roleToCheck
      ? (() => {
          const result = roleIsValidForDirection(roleToCheck, candidate.directionProfile);
          if (!result.valid) return { warning: result.reason ?? `Direction mismatch for role ${roleToCheck}` };
          return null;
        })()
      : null;

    result.push({
      ...candidate,
      hasContext: context !== null,
      contextRole: context?.role ?? '',
      suggestedAccountName: suggested?.name ?? '',
      suggestedAccountCode: suggested?.code ?? '',
      suggestedAccountId: suggested?.id ?? '',
      confidence,
      confidenceLabel,
      explanation,
      directionWarning: directionWarning?.warning ?? null,
    });
  }

  return result;
}

/**
 * Check if an existing rule already covers this candidate's pattern.
 */
function hasExistingRule(
  candidate: EntityCandidate,
  sampleDescription: string,
  existingRules?: EnrichmentInput['existingRules'],
): boolean {
  if (!existingRules?.length) return false;

  const entName = candidate.canonicalName.toLowerCase().trim();
  const rawSample = sampleDescription.toLowerCase().trim();

  return existingRules.some((r) => {
    if (!r.conditionValue) return false;
    const cond = r.conditionValue.toLowerCase().trim();

    const nameMatch = entName.includes(cond) || cond.includes(entName);
    const rawMatch =
      r.conditionType === 'contains'
        ? rawSample.includes(cond) || cond.includes(rawSample)
        : r.conditionType === 'equals'
          ? rawSample === cond
          : r.conditionType === 'starts_with'
            ? rawSample.startsWith(cond)
            : r.conditionType === 'ends_with'
              ? rawSample.endsWith(cond)
              : false;

    return nameMatch || rawMatch;
  });
}
