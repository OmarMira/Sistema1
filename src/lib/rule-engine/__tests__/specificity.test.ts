import { describe, it, expect } from 'vitest';
import { computeSpecificity, getConditionWeight } from '../specificity';
import { makeEvaluatedCondition } from './fixtures';
import type { RuleConditionType } from '../types';

describe('computeSpecificity', () => {
  it('SP-01: entity_eq maps to tier 5 weight 500', () => {
    const conditions = [makeEvaluatedCondition({ type: 'entity_eq', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 5, weightWithinTier: 500 });
  });

  it('SP-02: description_eq maps to tier 4 weight 400', () => {
    const conditions = [makeEvaluatedCondition({ type: 'description_eq', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 4, weightWithinTier: 400 });
  });

  it('SP-03: amount_eq maps to tier 4 weight 380', () => {
    const conditions = [makeEvaluatedCondition({ type: 'amount_eq', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 4, weightWithinTier: 380 });
  });

  it('SP-04: description_matches maps to tier 3 weight 300', () => {
    const conditions = [makeEvaluatedCondition({ type: 'description_matches', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 3, weightWithinTier: 300 });
  });

  it('SP-05: description_starts_with maps to tier 2 weight 220', () => {
    const conditions = [makeEvaluatedCondition({ type: 'description_starts_with', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 2, weightWithinTier: 220 });
  });

  it('SP-06: description_ends_with maps to tier 2 weight 220', () => {
    const conditions = [makeEvaluatedCondition({ type: 'description_ends_with', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 2, weightWithinTier: 220 });
  });

  it('SP-07: amount_range maps to tier 2 weight 200', () => {
    const conditions = [makeEvaluatedCondition({ type: 'amount_range', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 2, weightWithinTier: 200 });
  });

  it('SP-08: description_contains maps to tier 1 weight 120', () => {
    const conditions = [makeEvaluatedCondition({ type: 'description_contains', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 120 });
  });

  it('SP-09: amount_gt maps to tier 1 weight 100', () => {
    const conditions = [makeEvaluatedCondition({ type: 'amount_gt', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 100 });
  });

  it('SP-10: amount_gte maps to tier 1 weight 100', () => {
    const conditions = [makeEvaluatedCondition({ type: 'amount_gte', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 100 });
  });

  it('SP-11: amount_lt maps to tier 1 weight 100', () => {
    const conditions = [makeEvaluatedCondition({ type: 'amount_lt', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 100 });
  });

  it('SP-12: amount_lte maps to tier 1 weight 100', () => {
    const conditions = [makeEvaluatedCondition({ type: 'amount_lte', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 100 });
  });

  it('SP-13: date_before maps to tier 1 weight 50', () => {
    const conditions = [makeEvaluatedCondition({ type: 'date_before', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 50 });
  });

  it('SP-14: date_after maps to tier 1 weight 50', () => {
    const conditions = [makeEvaluatedCondition({ type: 'date_after', match: true })];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 1, weightWithinTier: 50 });
  });

  it('SP-15: highest tier only — lower tiers excluded', () => {
    const conditions = [
      makeEvaluatedCondition({ type: 'entity_eq', match: true }),
      makeEvaluatedCondition({ type: 'amount_gt', match: true }),
    ];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 5, weightWithinTier: 500 });
  });

  it('SP-16: highest tier only — multiple same-tier summed', () => {
    const conditions = [
      makeEvaluatedCondition({ type: 'description_eq', match: true }),
      makeEvaluatedCondition({ type: 'amount_eq', match: true }),
    ];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 4, weightWithinTier: 780 });
  });

  it('SP-17: empty conditions array', () => {
    expect(computeSpecificity([])).toEqual({ highestTier: 0, weightWithinTier: 0 });
  });

  it('SP-18: unmatched conditions contribute zero', () => {
    const conditions = [
      makeEvaluatedCondition({ type: 'entity_eq', match: false }),
    ];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 0, weightWithinTier: 0 });
  });

  it('SP-19: multi-tier — only highest tier counts, lower ignored', () => {
    const conditions = [
      makeEvaluatedCondition({ type: 'entity_eq', match: true }),
      makeEvaluatedCondition({ type: 'amount_gte', match: true }),
      makeEvaluatedCondition({ type: 'description_contains', match: true }),
    ];
    expect(computeSpecificity(conditions)).toEqual({ highestTier: 5, weightWithinTier: 500 });
  });
});

describe('getConditionWeight', () => {
  it('returns correct weight for known condition types', () => {
    const cases: [RuleConditionType, { tier: number; weight: number }][] = [
      ['entity_eq', { tier: 5, weight: 500 }],
      ['description_eq', { tier: 4, weight: 400 }],
      ['amount_eq', { tier: 4, weight: 380 }],
      ['description_matches', { tier: 3, weight: 300 }],
      ['description_starts_with', { tier: 2, weight: 220 }],
      ['description_ends_with', { tier: 2, weight: 220 }],
      ['amount_range', { tier: 2, weight: 200 }],
      ['description_contains', { tier: 1, weight: 120 }],
      ['amount_gt', { tier: 1, weight: 100 }],
      ['amount_gte', { tier: 1, weight: 100 }],
      ['amount_lt', { tier: 1, weight: 100 }],
      ['amount_lte', { tier: 1, weight: 100 }],
      ['date_before', { tier: 1, weight: 50 }],
      ['date_after', { tier: 1, weight: 50 }],
    ];
    for (const [type, expected] of cases) {
      expect(getConditionWeight(type)).toEqual(expected);
    }
  });
});
