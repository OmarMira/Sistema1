import { readFile } from 'fs/promises';
import { join } from 'path';
import { loadConfig, extractComponents } from '@/lib/services/entity-detector';
import { getKnownSocioPatterns } from '@/lib/services/entity-classifier';
import { db } from '@/lib/db';
import type { RuleCondition } from '@/lib/types/shared';

export type Transaction = { description: string; amount: number };

export type Rule = {
  // V1 fields (optional, kept for backward compatibility)
  conditionType?: string | null; // e.g. "contains", "starts_with", "amount_greater"
  conditionValue?: string | number | null;
  // V2 field – array of condition objects
  conditions?: RuleCondition[] | null;
  // Direction of transaction
  transactionDirection?: string | null;
};

/**
 * Evaluate a single condition against a transaction.
 * Ensures consistent whitespace normalization: lowercase, trim, collapse multiple spaces.
 */
function evaluateCondition(tx: Transaction, cond: RuleCondition): boolean {
  if (!cond || typeof cond !== 'object') return false;
  const field = cond.field;
  const operator = cond.operator;
  const value = cond.value;

  if (!field) return false;

  const txValue = tx[field as keyof Transaction];
  if (txValue === undefined || txValue === null) return false;

  // Normalize: lowercase, trim, and collapse multiple spaces to single space
  const strTxVal = String(txValue).toLowerCase().trim().replace(/\s+/g, ' ');
  const strCondVal = String(value).toLowerCase().trim().replace(/\s+/g, ' ');

  // Empty conditions after normalization never match (skip silently)
  if (!strCondVal) return false;

  // Wildcard '*' matches any non-empty value
  if (strCondVal === '*') return strTxVal.length > 0;

  switch (operator) {
    case 'equals':
      if (field === 'amount') {
        return Math.abs(Number(txValue)) === Math.abs(Number(value));
      }
      return strTxVal === strCondVal;
    case 'contains':
      return strTxVal.includes(strCondVal);
    case 'starts_with':
      return strTxVal.startsWith(strCondVal);
    case 'ends_with':
      return strTxVal.endsWith(strCondVal);
    case 'greater_than':
    case 'greaterThan':
    case 'amount_greater':
      return Math.abs(Number(txValue)) > Math.abs(Number(value));
    case 'less_than':
    case 'lessThan':
    case 'amount_less':
      return Math.abs(Number(txValue)) < Math.abs(Number(value));
    default:
      return false;
  }
}

/**
 * Preload entity-first context for a company (known SOCIO patterns + entityFirstMode flag).
 * Call once per request to avoid repeated DB queries on every transaction.
 */
export async function loadEntityFirstContext(companyId: string): Promise<{
  knownSocioPatterns: string[];
  entityFirstMode: boolean;
}> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { entityFirstMode: true },
  });
  const entityFirstMode = company?.entityFirstMode ?? false;
  const knownSocioPatterns = entityFirstMode ? await getKnownSocioPatterns(companyId) : [];
  return { knownSocioPatterns, entityFirstMode };
}

/**
 * Entity-first pre-filter: checks if a transaction should be excluded from SOCIO rule matching
 * due to entity conflict (merchant at P1 + SOCIO name at P3/INDN).
 */
export function entityFirstCheck(
  tx: Transaction,
  knownSocioPatterns: string[],
  entityFirstMode: boolean,
): { skipSocioRules: boolean; reason?: string } {
  if (!entityFirstMode || knownSocioPatterns.length === 0) {
    return { skipSocioRules: false };
  }

  const config = loadConfig();
  const components = extractComponents(tx.description, config);

  if (components.merchant && components.indnName) {
    const isSocioInIndn = knownSocioPatterns.some((p) =>
      components.indnName!.toLowerCase().includes(p.toLowerCase()),
    );
    if (isSocioInIndn) {
      return {
        skipSocioRules: true,
        reason: `Merchant "${components.merchant}" detected at P1 with SOCIO name "${components.indnName}" in INDN: — excluding SOCIO rule match`,
      };
    }
  }

  return { skipSocioRules: false };
}

/**
 * Main exported helper – returns true if a transaction satisfies a rule.
 * Supports optional entity-first conflict pre-filter via knownSocioPatterns.
 */
export function transactionMatchesRule(
  tx: Transaction,
  rule: Rule,
  knownSocioPatterns: string[] = [],
  entityFirstMode: boolean = false,
): boolean {
  // Entity-first pre-filter: skip SOCIO rules when merchant + SOCIO INDN conflict detected
  if (entityFirstMode && knownSocioPatterns?.length) {
    const check = entityFirstCheck(tx, knownSocioPatterns, entityFirstMode);
    if (check.skipSocioRules) {
      const ruleConditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      const isSocioRule = ruleConditions.some(
        (c: RuleCondition) =>
          c.field === 'description' &&
          knownSocioPatterns.some((p: string) =>
            String(c.value).toLowerCase().includes(p.toLowerCase()),
          ),
      );
      // Legacy V1 fallback: check conditionValue against known patterns when conditions array is absent
      if (!isSocioRule && (!rule.conditions || rule.conditions.length === 0)) {
        const legacyMatch = knownSocioPatterns.some(p =>
          String(rule.conditionValue || '').toLowerCase().includes(p.toLowerCase()) ||
          (rule.conditionType || '').toLowerCase().includes(p.toLowerCase())
        );
        if (legacyMatch) return false;
      }
      if (isSocioRule) return false;
    }
  }

  // Direction validation
  if (rule.transactionDirection === 'debit' && tx.amount >= 0) return false;
  if (rule.transactionDirection === 'credit' && tx.amount < 0) return false;

  // V2 handling – array of conditions
  if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
    return rule.conditions.every((c) => evaluateCondition(tx, c));
  }

  // Legacy V1 handling
  if (rule.conditionType && rule.conditionValue !== undefined && rule.conditionValue !== null) {
    const field =
      rule.conditionType === 'amount_greater' || rule.conditionType === 'amount_less'
        ? 'amount'
        : 'description';
    return evaluateCondition(tx, {
      field: field as 'description' | 'amount',
      operator: rule.conditionType as RuleCondition['operator'],
      value: rule.conditionValue,
    });
  }

  return false;
}

interface CachedPriorities {
  data: Record<string, number>;
  timestamp: number;
}

let cachedRolePriorities: CachedPriorities | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ROLE_PRIORITIES_PATH = join(process.cwd(), 'rules/entity-roles.json');

/**
 * Load role priorities from entity-roles.json with async TTL cache (5-minute).
 * Uses fs.promises.readFile — does not block the event loop.
 */
export async function loadRolePriorities(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cachedRolePriorities && now - cachedRolePriorities.timestamp < CACHE_TTL_MS) {
    return cachedRolePriorities.data;
  }
  try {
    const content = await readFile(ROLE_PRIORITIES_PATH, 'utf-8');
    const roles = JSON.parse(content) as string[];
    const map: Record<string, number> = {};
    roles.forEach((role, index) => {
      map[role.toUpperCase()] = index + 1;
    });
    cachedRolePriorities = { data: map, timestamp: now };
    return map;
  } catch {
    return {};
  }
}

/** Internal sync fallback — returns cached data or empty (non-blocking, no fs call). */
function loadRolePrioritiesSync(): Record<string, number> {
  if (cachedRolePriorities) return cachedRolePriorities.data;
  return {};
}

export interface MatchingRule {
  id: string;
  name: string;
  priority: number;
  conditionType?: string | null;
  conditionValue?: string | number | null;
  conditions?: RuleCondition[] | null;
  transactionDirection?: string | null;
  glAccountId?: string | null;
  debitGlAccountId?: string | null;
  creditGlAccountId?: string | null;
}

export interface MatchResult {
  matchedRuleId: string | null;
  glAccountId: string | null;
}

/**
 * High-level matching — loads entity context, filters rules,
 * scores via evaluateWinningRule, returns best match or null.
 */
export async function findMatchingRule(
  tx: Transaction,
  rules: MatchingRule[],
  companyId: string,
): Promise<MatchResult> {
  const context = await loadEntityFirstContext(companyId);
  const rolePriorities = await loadRolePriorities();

  const matchingRules = rules.filter((rule) =>
    transactionMatchesRule(tx, rule, context.knownSocioPatterns, context.entityFirstMode),
  );

  if (matchingRules.length === 0) {
    return { matchedRuleId: null, glAccountId: null };
  }

  const winner = evaluateWinningRule(matchingRules, tx, companyId, rolePriorities);

  return {
    matchedRuleId: winner.id,
    glAccountId:
      winner.glAccountId ?? winner.debitGlAccountId ?? winner.creditGlAccountId ?? null,
  };
}

export function evaluateWinningRule(
  matchingRules: MatchingRule[],
  tx: Transaction,
  companyId: string,
  rolePriorities: Record<string, number> = loadRolePrioritiesSync(),
  contexts?: Array<{ pattern: string; role: string }>,
): MatchingRule {
  if (matchingRules.length <= 1) return matchingRules[0];

  const rolePrios = rolePriorities;
  const descLower = tx.description.toLowerCase();

  const scored = matchingRules.map((rule) => {
    let highestRolePriority = 999;

    const conditions: RuleCondition[] =
      Array.isArray(rule.conditions) && rule.conditions.length > 0
        ? rule.conditions
        : rule.conditionValue
          ? [{ field: 'description' as const, operator: (rule.conditionType || 'contains') as RuleCondition['operator'], value: rule.conditionValue }]
          : [];

    for (const cond of conditions) {
      if (cond.field === 'description') {
        const condValue = String(cond.value).toLowerCase();
        if (descLower.includes(condValue) && contexts) {
          for (const ctx of contexts) {
            if (condValue.includes(ctx.pattern.toLowerCase())) {
              const prio = rolePrios[ctx.role.toUpperCase()] ?? 99;
              if (prio < highestRolePriority) {
                highestRolePriority = prio;
              }
            }
          }
        }
      }
    }

    return { rule, rolePriority: highestRolePriority, dbPriority: rule.priority ?? 99 };
  });

  scored.sort((a, b) => {
    if (a.rolePriority !== b.rolePriority) return a.rolePriority - b.rolePriority;
    return a.dbPriority - b.dbPriority;
  });

  return scored[0].rule;
}
