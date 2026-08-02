import { normalizeText } from './conditions/normalize';
import type { EvaluatedCondition, RuleCondition } from './types';

/**
 * Wildcard surface — the set of condition types for which the literal `*`
 * means "matches any non-empty value". Governed by `rule-wildcard-semantics`:
 * any addition or removal from this table requires a specification update.
 */
export const WILDCARD_SURFACE: Readonly<Record<string, boolean>> = {
  description_contains: true,
  description_eq: true,
  description_starts_with: true,
  description_ends_with: true,
  description_matches: false,
  amount_gt: false,
  amount_gte: false,
  amount_lt: false,
  amount_lte: false,
  amount_eq: false,
  amount_range: false,
};

/** True iff the normalized value is exactly the wildcard marker `*`. */
export function isWildcardValue(value: unknown): boolean {
  return normalizeText(String(value)) === '*';
}

/**
 * Map a legacy `{ field, operator }` pair to its canonical condition type.
 * Returns '' when the pair is not a known legacy condition.
 */
export function legacyConditionType(
  field: string | undefined,
  operator: string | undefined,
): string {
  if (!field || !operator) return '';
  const map: Record<string, Record<string, string>> = {
    description: {
      contains: 'description_contains',
      equals: 'description_eq',
      starts_with: 'description_starts_with',
      ends_with: 'description_ends_with',
      description_matches: 'description_matches',
    },
    amount: {
      equals: 'amount_eq',
      amount_greater: 'amount_gt',
      amount_less: 'amount_lt',
      greater_than: 'amount_gt',
      greaterThan: 'amount_gt',
      less_than: 'amount_lt',
      lessThan: 'amount_lt',
    },
  };
  return map[field]?.[operator] ?? '';
}

/**
 * Evaluate a condition whose value is `*` on the wildcard surface.
 * Returns an EvaluatedCondition (match iff the normalized transaction value
 * is non-empty) when the condition is on the surface AND the value is `*`;
 * returns `null` to let the engine continue normally otherwise. Never throws.
 */
export function evaluateWildcardCondition(
  condition: RuleCondition,
  transaction: { description: string },
): EvaluatedCondition | null {
  if (!WILDCARD_SURFACE[condition.type] || !isWildcardValue(condition.value)) {
    return null;
  }
  const desc = normalizeText(transaction.description ?? '');
  const match = desc.length > 0;
  return {
    type: condition.type,
    score: match ? 1 : 0,
    match,
    detail: `wildcard "*" matches any non-empty description: ${match}`,
  };
}
