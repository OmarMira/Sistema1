import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { safeAuditLog } from './audit-service';
import { logger } from '@/lib/logger';
import { checkPromptInjection, addSystemDelimiter } from '@/lib/guardrails';
import { findContext } from '@/lib/services/entity-context-service';
import { ROLE_ACCOUNT_MAP } from '@/lib/constants/role-account-map';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { serverT } from '@/lib/server-i18n';
import { getAiConfig } from '@/lib/ai-config';
import { safeFetch } from '@/lib/security/safe-fetch';
import type { RuleCondition, AssistantConfig } from '@/lib/types/shared';
import { collectSignals } from './signal-collector';
import { decide } from './decision-engine';
import { resolveEntity } from '@/memory/entity-resolution';
import { createAdapter, lookupTreatment, matchAuthorizedPattern } from '@/memory/classification-knowledge';
import type { AuthorizedPatternMatch } from '@/memory/classification-knowledge';

export interface ConversationalParseResult {
  role: string;
  glAccountCode: string;
  glAccountId: string | null;
  suggestSubAccount: boolean;
  subAccountName: string | null;
  account: {
    code: string;
    name: string;
    accountType?: string;
    normalBalance?: string;
  };
  conditions?: RuleCondition[] | null;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  explanation: string;
  uncertaintyReasons: string[];
  proposedEntity?: {
    canonicalName: string;
    entityType: 'person' | 'company' | 'financial_product' | 'platform' | 'asset';
  } | null;
}

// ── Internal: read assistant config from disk ──
function readAssistantConfigSync(): AssistantConfig {
  try {
    const configPath = join(process.cwd(), 'rules/assistant-config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

// ── Layer 1: AI Parser ──
// Pure AI interaction layer: reads config, calls external chat API via fetch,
// returns parsed result or THROWS on failure (no silent fallback).
// Accepts optional deps for DI: fetch and readAssistantConfig.
export async function parseWithAI(
  pattern: string,
  userInput: string,
  deps: {
    apiKey: string;
    baseUrl: string;
    model: string;
    fetch?: typeof globalThis.fetch;
    readAssistantConfig?: () => AssistantConfig;
  },
): Promise<{
  role: string;
  glAccountCode: string;
  conditions?: RuleCondition[];
  suggestSubAccount: boolean;
  subAccountName: string | null;
  proposedEntity: {
    canonicalName: string;
    entityType: 'person' | 'company' | 'financial_product' | 'platform' | 'asset';
  } | null;
}> {
  const { apiKey, baseUrl, model } = deps;
  const fetchFn = deps.fetch ?? safeFetch;
  const getConfig = deps.readAssistantConfig ?? readAssistantConfigSync;

  if (!apiKey || !baseUrl || !model) {
    const err = new Error('AI not configured. Set it up in Settings → AI.') as Error & { code?: string };
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  // Prompt injection guardrails
  const patternCheck = checkPromptInjection(pattern);
  if (!patternCheck.passed) {
    logger.warn('PROMPT_INJECTION_BLOCKED', { reason: patternCheck.reason, pattern });
    throw new Error('Disallowed content detected in user input.');
  }

  const inputCheck = checkPromptInjection(userInput);
  if (!inputCheck.passed) {
    logger.warn('PROMPT_INJECTION_BLOCKED', { reason: inputCheck.reason, pattern });
    throw new Error('Disallowed content detected in user input.');
  }

  // Build model fallback list (preserving existing openrouter/free behavior)
  const modelsToTry = [model];
  if (model === 'openrouter/free') {
    modelsToTry.push('google/gemini-2.5-flash:free');
    modelsToTry.push('qwen/qwen-2.5-72b-instruct:free');
  }

  const assistantConfig = getConfig();
  const systemInstruction = addSystemDelimiter(assistantConfig.systemInstruction ?? '');

  for (const currentModel of modelsToTry) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout per model

    try {
      const response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        },
        body: JSON.stringify({
          model: currentModel,
          temperature: assistantConfig.temperature ?? 0.1,
          max_tokens: assistantConfig.maxTokens ?? 300,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemInstruction },
            {
              role: 'user',
              content: `Entity: "${pattern}"\nUser description: "${userInput}"\n\nReturn a JSON object with:\n- "role": the role of this entity (e.g. PROVEEDOR, CLIENTE, SOCIO, etc.)\n- "glAccountCode": the GL account code that best fits this transaction\n- "conditions": optional matching conditions array\n- "suggestSubAccount": true if this looks like a person who needs a sub-account\n- "subAccountName": the sub-account name if suggestSubAccount is true\n- "proposedEntity": if you can identify the real-world entity behind this description, return { "canonicalName": "the entity name", "entityType": "person|company|financial_product|platform|asset" }. If you cannot reasonably determine the identity, return null.\n\nReturn only the JSON object.`,
            },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`AI API returned status ${response.status}`);
      }

      const resData = await response.json();
      const content = resData.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('AI response missing content');
      }

      const parsed = JSON.parse(content);

      // Validate that we have the minimum required fields
      if (!parsed.role || !parsed.glAccountCode) {
        throw new Error('AI returned incomplete result');
      }

      // Validate proposedEntity if present
      let proposedEntity: {
        canonicalName: string;
        entityType: 'person' | 'company' | 'financial_product' | 'platform' | 'asset';
      } | null = null;
      if (
        parsed.proposedEntity &&
        typeof parsed.proposedEntity === 'object' &&
        typeof parsed.proposedEntity.canonicalName === 'string' &&
        parsed.proposedEntity.canonicalName.length > 0 &&
        ['person', 'company', 'financial_product', 'platform', 'asset'].includes(parsed.proposedEntity.entityType)
      ) {
        proposedEntity = {
          canonicalName: parsed.proposedEntity.canonicalName,
          entityType: parsed.proposedEntity.entityType,
        };
      }

      // Success — return parsed data
      return {
        role: parsed.role,
        glAccountCode: parsed.glAccountCode,
        conditions: parsed.conditions,
        suggestSubAccount: Boolean(parsed.suggestSubAccount),
        subAccountName: parsed.subAccountName ? String(parsed.subAccountName) : null,
        proposedEntity,
      };
    } catch (err: unknown) {
      clearTimeout(timeout);

      // If this was the last model attempt, re-throw so the facade can fallback
      if (currentModel === modelsToTry[modelsToTry.length - 1]) {
        throw err;
      }

      // Otherwise log and try the next model
      logger.warn(`[CONVERSATIONAL PARSE AI FAIL FOR MODEL ${currentModel}]`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error('All AI models failed');
}

// ── Layer 2: GL Account Resolver ──
// Pure DB resolution: queries glAccount by companyId + code.
// Returns enriched data or default fallback. Accepts optional deps for DI.
export async function resolveGLAccount(
  companyId: string,
  glAccountCode: string,
  deps?: {
    db?: typeof db;
  },
  locale?: string,
): Promise<{
  glAccountId: string | null;
  account: { code: string; name: string; accountType?: string; normalBalance?: string };
}> {
  const dbClient = deps?.db ?? db;
  const unclassifiedName = serverT(locale, 'accounts.unclassified');

  if (!glAccountCode) {
    return { glAccountId: null, account: { code: '', name: unclassifiedName } };
  }

  try {
    const acc = await dbClient.glAccount.findFirst({
      where: { companyId, code: glAccountCode, isActive: true },
    });

    if (acc) {
      return {
        glAccountId: acc.id,
        account: {
          code: acc.code,
          name: acc.name,
          accountType: acc.accountType,
          normalBalance: acc.normalBalance,
        },
      };
    }

    // Code not in DB — derive accountType from the thousand-range parent
    const num = parseInt(glAccountCode, 10);
    let hintType: string | undefined;
    let hintBalance: string | undefined;
    if (!isNaN(num)) {
      const rangeBase = String(Math.floor(num / 1000) * 1000);
      const parent = await dbClient.glAccount.findFirst({
        where: { companyId, code: rangeBase, isActive: true },
        select: { accountType: true, normalBalance: true },
      });
      hintType = parent?.accountType;
      hintBalance = parent?.normalBalance;
    }
    return {
      glAccountId: null,
      account: {
        code: glAccountCode,
        name: unclassifiedName,
        accountType: hintType,
        normalBalance: hintBalance,
      },
    };
  } catch (dbErr) {
    logger.warn('GL_ACCOUNT_QUERY_FAIL', { companyId, glAccountCode, error: String(dbErr) });
    return { glAccountId: null, account: { code: glAccountCode, name: unclassifiedName } };
  }
}

// ── Facade: parseConversationalContext ──
// Single-memory architecture: Entity Resolution → Treatment Lookup → AI/heuristic fallback.
// 1. resolveEntity → KNOWN/UNKNOWN/ERROR
// 2. If KNOWN: lookupTreatment → FOUND/NOT_FOUND/ERROR
// 3. FOUND → return KE treatment (no AI, no heuristic)
// 4. NOT_FOUND/UNKNOWN → AI/heuristic fallback
export async function parseConversationalContext(
  companyId: string,
  pattern: string,
  userInput: string,
  userId?: string,
  fetchFn?: typeof globalThis.fetch,
  prismaClient?: typeof db,
  direction?: 'debit' | 'credit',
  locale?: string,
): Promise<ConversationalParseResult> {
  // Unknown structural ambiguity (added when a structural match was ambiguous)
  // appended to fallback results so a KE verdict is never falsely attributed.
  let structuralAmbiguity: string[] = [];

  // Step 1: Entity Resolution via KE
  const entityResolution = await resolveEntity(companyId, pattern);

  // ERROR → no AI fallback, no heuristic fallback
  if (entityResolution.status === 'ERROR') {
    logger.error('[KE] Entity resolution error in conversational path', {
      companyId,
      pattern,
      reason: entityResolution.reason,
    });
    return {
      role: '',
      glAccountCode: '',
      glAccountId: null,
      suggestSubAccount: false,
      subAccountName: null,
      account: { code: '', name: serverT(locale, 'accounts.unclassified') },
      conditions: [{ field: 'description', operator: 'contains', value: pattern }],
      confidence: 0,
      confidenceLabel: 'low',
      explanation: `KE entity resolution error: ${entityResolution.reason}`,
      uncertaintyReasons: [`KE entity resolution error: ${entityResolution.reason}`],
    };
  }

  if (entityResolution.status === 'KNOWN') {
    // Step 2: Treatment Lookup via KE
    const keAdapter = createAdapter(prismaClient ?? db, (fn) => (prismaClient ?? db).$transaction(fn));
    let treatment;
    try {
      treatment = await lookupTreatment(keAdapter, companyId, entityResolution.entityId);
    } catch (error) {
      logger.error('[KE] Treatment lookup threw in conversational path', {
        companyId,
        entityId: entityResolution.entityId,
        error: String(error),
      });
      return {
        role: '',
        glAccountCode: '',
        glAccountId: null,
        suggestSubAccount: false,
        subAccountName: null,
        account: { code: '', name: serverT(locale, 'accounts.unclassified') },
        conditions: [{ field: 'description', operator: 'contains', value: pattern }],
        confidence: 0,
        confidenceLabel: 'low',
        explanation: `KE treatment lookup error: ${error instanceof Error ? error.message : String(error)}`,
        uncertaintyReasons: [`KE treatment lookup error`],
      };
    }

    if (treatment.status === 'ERROR') {
      logger.error('[KE] Treatment lookup error in conversational path', {
        companyId,
        entityId: entityResolution.entityId,
        reason: treatment.reason,
      });
      return {
        role: '',
        glAccountCode: '',
        glAccountId: null,
        suggestSubAccount: false,
        subAccountName: null,
        account: { code: '', name: serverT(locale, 'accounts.unclassified') },
        conditions: [{ field: 'description', operator: 'contains', value: pattern }],
        confidence: 0,
        confidenceLabel: 'low',
        explanation: `KE treatment lookup error: ${treatment.reason}`,
        uncertaintyReasons: [`KE treatment lookup error: ${treatment.reason}`],
      };
    }

    if (treatment.status === 'FOUND') {
      // KE hit — resolve GL account from treatment
      const glAccount = await (prismaClient ?? db).glAccount.findUnique({
        where: { id: treatment.glAccountId },
      });

      const glAccountId = glAccount?.id ?? null;
      const account = glAccount
        ? { code: glAccount.code, name: glAccount.name, accountType: glAccount.accountType, normalBalance: glAccount.normalBalance }
        : { code: '', name: serverT(locale, 'accounts.unclassified') };

      // Resolve role from EntityContext for display
      const existingContext = await findContext(companyId, pattern).catch(() => null);
      const role = existingContext?.role?.toUpperCase() ?? '';

      const suggestSubAccount = role === 'SOCIO';
      const subAccountName = suggestSubAccount
        ? pattern.trim().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        : null;

      return {
        role,
        glAccountCode: account?.code ?? '',
        glAccountId,
        suggestSubAccount,
        subAccountName,
        account: {
          code: account?.code ?? '',
          name: account?.name ?? '',
          accountType: account?.accountType ?? undefined,
          normalBalance: account?.normalBalance ?? undefined,
        },
        conditions: [{ field: 'description', operator: 'contains', value: pattern }],
        confidence: 0.95,
        confidenceLabel: 'high',
        explanation: `KE treatment found for entity ${entityResolution.entityId}`,
        uncertaintyReasons: [],
      };
    }

    // treatment.status === 'NOT_FOUND' → structural match of AUTHORIZED
    // patterns (GENERALIZACIÓN-005 knowledge) before AI/heuristic fallback.
    // Precedence preserved: exact treatment won unless NOT_FOUND.
    if (treatment.status === 'NOT_FOUND') {
      let structural: AuthorizedPatternMatch;
      try {
        structural = await matchAuthorizedPattern(
          keAdapter,
          companyId,
          entityResolution.entityId,
          pattern,
          direction ?? 'any',
        );
      } catch (structuralError) {
        logger.error('[KE] Structural match threw in conversational path', {
          companyId,
          entityId: entityResolution.entityId,
          error: String(structuralError),
        });
        return {
          role: '',
          glAccountCode: '',
          glAccountId: null,
          suggestSubAccount: false,
          subAccountName: null,
          account: { code: '', name: serverT(locale, 'accounts.unclassified') },
          conditions: [{ field: 'description', operator: 'contains', value: pattern }],
          confidence: 0,
          confidenceLabel: 'low',
          explanation: `KE structural match error: ${structuralError instanceof Error ? structuralError.message : String(structuralError)}`,
          uncertaintyReasons: [`KE structural match error`],
        };
      }

      if (structural.kind === 'match') {
        // Authorized learned treatment from a structural pattern — KE knowledge,
        // NOT AI, NOT heuristic. Source remains distinguishable from exact lookup.
        logger.info('[KE] Authorized structural pattern matched in conversational path', {
          companyId,
          entityId: entityResolution.entityId,
          authorizedPatternId: structural.authorizedPatternId,
        });
        const glAccount = await (prismaClient ?? db).glAccount.findUnique({
          where: { id: structural.glAccountId },
        });
        const glAccountId = glAccount?.id ?? null;
        const structuralAccount = glAccount
          ? { code: glAccount.code, name: glAccount.name, accountType: glAccount.accountType, normalBalance: glAccount.normalBalance }
          : { code: '', name: serverT(locale, 'accounts.unclassified') };

        // Resolve role from EntityContext for display only
        const existingContextForDisplay = await findContext(companyId, pattern).catch(() => null);
        const structuralRole = existingContextForDisplay?.role?.toUpperCase() ?? '';
        const suggestSubAccount = structuralRole === 'SOCIO';
        const subAccountName = suggestSubAccount
          ? pattern.trim().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
          : null;

        return {
          role: structuralRole,
          glAccountCode: structuralAccount?.code ?? '',
          glAccountId,
          suggestSubAccount,
          subAccountName,
          account: {
            code: structuralAccount?.code ?? '',
            name: structuralAccount?.name ?? '',
            accountType: structuralAccount?.accountType ?? undefined,
            normalBalance: structuralAccount?.normalBalance ?? undefined,
          },
          conditions: [{ field: 'description', operator: 'contains', value: pattern }],
          confidence: 0.95,
          confidenceLabel: 'high',
          explanation: `Authorized structural treatment applied (pattern ${structural.authorizedPatternId}, candidate ${structural.sourceCandidateId}) for entity ${entityResolution.entityId}`,
          uncertaintyReasons: [],
        };
      }

      if (structural.kind === 'error') {
        logger.error('[KE] Structural match error in conversational path', {
          companyId,
          entityId: entityResolution.entityId,
          reason: structural.reason,
        });
        return {
          role: '',
          glAccountCode: '',
          glAccountId: null,
          suggestSubAccount: false,
          subAccountName: null,
          account: { code: '', name: serverT(locale, 'accounts.unclassified') },
          conditions: [{ field: 'description', operator: 'contains', value: pattern }],
          confidence: 0,
          confidenceLabel: 'low',
          explanation: `KE structural match error: ${structural.reason}`,
          uncertaintyReasons: [`KE structural match error: ${structural.reason}`],
        };
      }

      if (structural.kind === 'ambiguous') {
        // No KE decision exists — ambiguity is explicit; AI/heuristic remains
        // the next pipeline authority, but NOTHING may present a KE verdict.
        logger.warn('[KE] Structural match ambiguous in conversational path', {
          companyId,
          entityId: entityResolution.entityId,
          matchedPatternIds: structural.matchedPatternIds,
        });
        structuralAmbiguity = [
          `Authorized structural match ambiguous (patterns: ${structural.matchedPatternIds.join(', ')}) — KE did not decide`,
        ];
      }

      // structural.kind === 'no_match' → fall through to legacy AI/heuristic
    }
  }

  // Entity UNKNOWN or treatment NOT_FOUND → AI/heuristic fallback
  const assistantConfig = readAssistantConfigSync() as any;
  const rawRules = assistantConfig?.heuristics?.rules ?? [];
  const flattenedRules = rawRules.map((r: any) => ({
    keywords: [...(r.keywords?.es ?? []), ...(r.keywords?.en ?? [])],
    role: r.role,
    glAccountCode: r.glAccountCode,
    direction: 'any' as const,
  }));
  const engineConfig = { heuristics: flattenedRules };
  const directionVal = direction ?? 'mixed';

  // Get EntityContext for role context (GL no longer used)
  const existingContext = await findContext(companyId, pattern).catch(() => null);

  // Try AI
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  try {
    const aiConfig = await getAiConfig();
    apiKey = aiConfig.apiKey;
    baseUrl = aiConfig.baseUrl;
    model = aiConfig.model;
  } catch {
    // AI not configured
  }

  let aiResponse: { role?: string; glAccountCode?: string; proposedEntity?: { canonicalName: string; entityType: 'person' | 'company' | 'financial_product' | 'platform' | 'asset' } | null } | null = null;

  if (apiKey && baseUrl && model) {
    try {
      const parsed = await parseWithAI(pattern, userInput, {
        apiKey,
        baseUrl,
        model,
        fetch: fetchFn,
      });

      if (userId) {
        safeAuditLog({
          companyId,
          userId,
          action: 'AI_EXTERNAL_RESPONSE_RECEIVED',
          entity: 'EntityContext',
          details: {
            pattern,
            userInput,
            aiResponse: parsed,
            model,
            timestamp: new Date().toISOString(),
          },
        }).catch((e) => logger.warn('[AI AUDIT LOG FAIL]', { error: String(e) }));
      }

      if (parsed) {
        const existingAccount = await (prismaClient ?? db).glAccount.findFirst({
          where: { companyId, code: String(parsed.glAccountCode).trim(), isActive: true },
        });
        if (existingAccount) {
          aiResponse = { role: parsed.role, glAccountCode: parsed.glAccountCode, proposedEntity: parsed.proposedEntity };
        } else {
          logger.warn('[AI SUGGESTED CODE NOT FOUND IN DB]', {
            code: parsed.glAccountCode,
            companyId,
          });
        }
      }
    } catch {
      // AI failed
    }
  }

  // Collect signals — EntityContext signal now has no GL authority
  const signals = collectSignals({
    entityContext: existingContext,
    userInput,
    direction: directionVal,
    assistantConfig: engineConfig,
    aiResponse,
  }, locale);

  const result = decide(signals, locale);

  if (result.selected) {
    let role = String(result.selected.role ?? '').toUpperCase().trim();
    let glAccountCode = String(result.selected.glAccountCode ?? '').trim();

    // ROLE_ACCOUNT_MAP fallback when no GL from signal
    if (!glAccountCode && existingContext) {
      const mapping = ROLE_ACCOUNT_MAP[role as EntityRole];
      if (mapping) {
        glAccountCode = direction === 'debit' ? mapping.debit
          : direction === 'credit' ? mapping.credit
          : mapping.fallback;
      }
    }

    let { glAccountId, account } = await resolveGLAccount(companyId, glAccountCode, {
      db: prismaClient,
    });

    // Auto-create known system accounts if missing
    if (!glAccountId) {
      const SYSTEM_ACCOUNTS: Record<
        string,
        { name: string; type: string; normalBalance: string; parentCode: string }
      > = {
        '3010': {
          name: "Partner Contributions / Capital",
          type: 'equity',
          normalBalance: 'credit',
          parentCode: '3000',
        },
        '3040': {
          name: "Owner's Draw / Partner Withdrawals",
          type: 'equity',
          normalBalance: 'debit',
          parentCode: '3000',
        },
      };

      const def = SYSTEM_ACCOUNTS[glAccountCode];
      if (def) {
        try {
          const client = prismaClient ?? db;
          const parent = await client.glAccount.findFirst({
            where: { companyId, code: def.parentCode, isActive: true },
          });
          const created = await client.glAccount.create({
            data: {
              companyId,
              code: glAccountCode,
              name: def.name,
              accountType: def.type,
              normalBalance: def.normalBalance,
              parentId: parent?.id ?? null,
              isActive: true,
            },
          });
          glAccountId = created.id;
          account = {
            code: created.code,
            name: created.name,
            accountType: created.accountType,
            normalBalance: created.normalBalance,
          };
          logger.info('[AUTO-CREATED SYSTEM ACCOUNT]', {
            code: glAccountCode,
            companyId,
            accountId: created.id,
          });
        } catch (createErr) {
          logger.warn('[FAILED TO AUTO-CREATE SYSTEM ACCOUNT]', {
            code: glAccountCode,
            companyId,
            error: String(createErr),
          });
        }
      }
    }

    const suggestSubAccount = role === 'SOCIO';
    const subAccountName = suggestSubAccount
      ? pattern
          .trim()
          .split(/\s+/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ')
      : null;

    const conditions: RuleCondition[] = [
      { field: 'description', operator: 'contains', value: pattern },
    ];

    return {
      role,
      glAccountCode,
      glAccountId,
      suggestSubAccount,
      subAccountName,
      account: {
        code: account.code,
        name: account.name,
        accountType: account.accountType ?? undefined,
        normalBalance: account.normalBalance ?? undefined,
      },
      conditions,
      confidence: result.confidence,
      confidenceLabel: result.confidenceLabel,
      explanation: result.explanation,
      uncertaintyReasons: [...result.uncertaintyReasons, ...structuralAmbiguity],
      proposedEntity: aiResponse?.proposedEntity ?? null,
    };
  }

  // SIN_CLASIFICAR — no signal with sufficient confidence
  return {
    role: '',
    glAccountCode: '',
    glAccountId: null,
    suggestSubAccount: false,
    subAccountName: null,
    account: { code: '', name: serverT(locale, 'accounts.unclassified') },
    conditions: [{ field: 'description', operator: 'contains', value: pattern }],
    confidence: 0,
    confidenceLabel: 'low',
    explanation: result.explanation,
    uncertaintyReasons: [...result.uncertaintyReasons, ...structuralAmbiguity],
    proposedEntity: aiResponse?.proposedEntity ?? null,
  };
}
