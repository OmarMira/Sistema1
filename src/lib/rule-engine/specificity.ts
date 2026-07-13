import type { EvaluatedCondition, SpecificityScore, RuleConditionType } from './types';

const CONDITION_WEIGHTS: Record<string, { tier: number; weight: number }> = {
  entity_eq: { tier: 5, weight: 500 },
  description_eq: { tier: 4, weight: 400 },
  amount_eq: { tier: 4, weight: 380 },
  description_matches: { tier: 3, weight: 300 },
  description_starts_with: { tier: 2, weight: 220 },
  description_ends_with: { tier: 2, weight: 220 },
  amount_range: { tier: 2, weight: 200 },
  description_contains: { tier: 1, weight: 120 },
  amount_gt: { tier: 1, weight: 100 },
  amount_gte: { tier: 1, weight: 100 },
  amount_lt: { tier: 1, weight: 100 },
  amount_lte: { tier: 1, weight: 100 },
  date_before: { tier: 1, weight: 50 },
  date_after: { tier: 1, weight: 50 },
};

export function getConditionWeight(type: RuleConditionType): { tier: number; weight: number } {
  return CONDITION_WEIGHTS[type] ?? { tier: 0, weight: 0 };
}

export function computeSpecificity(conditions: EvaluatedCondition[]): SpecificityScore {
  const matched = conditions.filter((c) => c.match).map((c) => getConditionWeight(c.type));
  if (matched.length === 0) {
    return { highestTier: 0, weightWithinTier: 0 };
  }
  const highestTier = Math.max(...matched.map((m) => m.tier));
  const weightWithinTier = matched
    .filter((m) => m.tier === highestTier)
    .reduce((sum, m) => sum + m.weight, 0);
  return { highestTier, weightWithinTier };
}
