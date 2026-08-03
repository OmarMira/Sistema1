import { describe, it, expect } from 'vitest';
import {
  canonicalComparator,
  rankCanonical,
  classifyCanonical,
  AMBIGUITY_DELTA_THRESHOLD,
} from '../canonical-ranking';
import type { CanonicalCandidate } from '../canonical-ranking';

function cand(overrides?: Partial<CanonicalCandidate>): CanonicalCandidate {
  return {
    ruleId: 'r1',
    specificityScore: { highestTier: 3, weightWithinTier: 300 },
    matchQuality: 0.8,
    priority: 10,
    ...overrides,
  };
}

describe('AMBIGUITY_DELTA_THRESHOLD', () => {
  it('is 0.10 (contract-level shared threshold)', () => {
    expect(AMBIGUITY_DELTA_THRESHOLD).toBe(0.10);
  });
});

describe('canonicalComparator total order', () => {
  it('tier DESC first', () => {
    const a = cand({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 } });
    const b = cand({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 } });
    expect(canonicalComparator(a, b)).toBeGreaterThan(0);
    expect(canonicalComparator(b, a)).toBeLessThan(0);
  });

  it('weightWithinTier DESC second when tier ties', () => {
    const a = cand({ specificityScore: { highestTier: 4, weightWithinTier: 400 } });
    const b = cand({ specificityScore: { highestTier: 4, weightWithinTier: 380 } });
    expect(canonicalComparator(a, b)).toBeLessThan(0);
  });

  it('matchQuality DESC third', () => {
    const a = cand({ matchQuality: 0.8 });
    const b = cand({ matchQuality: 0.5 });
    expect(canonicalComparator(a, b)).toBeLessThan(0);
  });

  it('priority ASC fourth (lower wins)', () => {
    const a = cand({ priority: 1 });
    const b = cand({ priority: 5 });
    expect(canonicalComparator(a, b)).toBeLessThan(0);
  });

  it('ruleId ASC — ordinal, locale-independent final key', () => {
    const a = cand({ ruleId: 'rule-10' });
    const b = cand({ ruleId: 'rule-2' });
    expect(canonicalComparator(b, a)).toBeGreaterThan(0);
    expect(canonicalComparator(a, b)).toBeLessThan(0);
  });
});

describe('rankCanonical', () => {
  it('ranks a full cascade deterministically', () => {
    const out = rankCanonical([
      cand({ ruleId: 'E', specificityScore: { highestTier: 1, weightWithinTier: 100 }, matchQuality: 0.9, priority: 1 }),
      cand({ ruleId: 'D', specificityScore: { highestTier: 4, weightWithinTier: 400 }, matchQuality: 0.9, priority: 1 }),
      cand({ ruleId: 'C', specificityScore: { highestTier: 4, weightWithinTier: 380 }, matchQuality: 0.9, priority: 1 }),
      cand({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 }, matchQuality: 0.7, priority: 5 }),
      cand({ ruleId: 'A', specificityScore: { highestTier: 5, weightWithinTier: 500 }, matchQuality: 0.8, priority: 1 }),
    ]);
    expect(out.map((c) => c.ruleId)).toEqual(['A', 'B', 'D', 'C', 'E']);
  });

  it('is order-insensitive and does not mutate input', () => {
    const input = [
      cand({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      cand({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const original = [...input];
    const out = rankCanonical(input);
    expect(out.map((c) => c.ruleId)).toEqual(['B', 'A']);
    expect(input).toEqual(original);
  });
});

describe('classifyCanonical', () => {
  it('zero candidates → no winner', () => {
    const d = classifyCanonical([]);
    expect(d.winner).toBeUndefined();
    expect(d.ambiguous).toBe(false);
    expect(d.reason).toBe('no_candidates');
  });

  it('single candidate → winner', () => {
    const c = cand({ ruleId: 'r1' });
    const d = classifyCanonical([c]);
    expect(d.winner?.ruleId).toBe('r1');
    expect(d.ambiguous).toBe(false);
    expect(d.reason).toBe('single_candidate');
  });

  it('higher tier → winner, higher_specificity_tier', () => {
    const d = classifyCanonical([
      cand({ ruleId: 'A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      cand({ ruleId: 'B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ]);
    expect(d.winner?.ruleId).toBe('A');
    expect(d.reason).toBe('higher_specificity_tier');
  });

  it('same tier, higher weight → winner, higher_specificity_weight', () => {
    const d = classifyCanonical([
      cand({ ruleId: 'A', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      cand({ ruleId: 'B', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ]);
    expect(d.winner?.ruleId).toBe('A');
    expect(d.reason).toBe('higher_specificity_weight');
  });

  it('DELTA >= 0.10 → winner, delta_above_threshold', () => {
    const d = classifyCanonical([
      cand({ ruleId: 'A', matchQuality: 0.8 }),
      cand({ ruleId: 'B', matchQuality: 0.65 }),
    ]);
    expect(d.winner?.ruleId).toBe('A');
    expect(d.ambiguous).toBe(false);
    expect(d.reason).toBe('delta_above_threshold');
  });

  it('DELTA < 0.10 → ambiguous, delta_below_threshold', () => {
    const d = classifyCanonical([
      cand({ ruleId: 'A', matchQuality: 0.72 }),
      cand({ ruleId: 'B', matchQuality: 0.68 }),
    ]);
    expect(d.winner).toBeUndefined();
    expect(d.ambiguous).toBe(true);
    expect(d.reason).toBe('delta_below_threshold');
  });

  it('full semantic tie (only ruleId differs) → AMBIGUOUS, not a fabricated ruleId winner', () => {
    const d = classifyCanonical([
      cand({ ruleId: 'rule-aaa', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7, priority: 5 }),
      cand({ ruleId: 'rule-bbb', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7, priority: 5 }),
    ]);
    expect(d.winner).toBeUndefined();
    expect(d.ambiguous).toBe(true);
    expect(d.reason).toBe('delta_below_threshold');
  });

  it('priority difference does NOT reach ambiguity — higher priority (lower number) wins', () => {
    const d = classifyCanonical([
      cand({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7, priority: 1 }),
      cand({ ruleId: 'B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7, priority: 9 }),
    ]);
    expect(d.winner?.ruleId).toBe('A');
    expect(d.ambiguous).toBe(false);
  });
});