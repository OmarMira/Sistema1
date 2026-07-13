import { describe, it, expect } from 'vitest';
import { rankCandidates } from '../ranking';
import { makeScoredCandidate } from './fixtures';
import type { ScoredCandidate } from '../types';

describe('rankCandidates', () => {
  it('RK-01: sort by highestTier descending', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'C', specificityScore: { highestTier: 1, weightWithinTier: 100 } }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['B', 'A', 'C']);
  });

  it('RK-02: same tier → sort by weightWithinTier descending', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['A', 'B']);
  });

  it('RK-03: same specificity → sort by matchQuality descending', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8 }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.5 }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['A', 'B']);
  });

  it('RK-04: same specificity + quality → sort by priority ascending', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 1 }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 5 }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['A', 'B']);
  });

  it('RK-05: same everything → deterministic by ruleId', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'rule-beta', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 1 }),
      makeScoredCandidate({ ruleId: 'rule-alpha', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 1 }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['rule-alpha', 'rule-beta']);
  });

  it('RK-06: empty array', () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it('RK-07: single element', () => {
    const candidate = makeScoredCandidate({ ruleId: 'A' });
    expect(rankCandidates([candidate])).toEqual([candidate]);
  });

  it('RK-08: stable sort — does not mutate input', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
    ];
    const original = [...candidates];
    rankCandidates(candidates);
    expect(candidates).toEqual(original);
  });

  it('RK-09: real-world lexicographic cascade', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'E', specificityScore: { highestTier: 1, weightWithinTier: 100 }, matchQuality: 0.9, priority: 1 }),
      makeScoredCandidate({ ruleId: 'D', specificityScore: { highestTier: 4, weightWithinTier: 400 }, matchQuality: 0.9, priority: 1 }),
      makeScoredCandidate({ ruleId: 'C', specificityScore: { highestTier: 4, weightWithinTier: 380 }, matchQuality: 0.9, priority: 1 }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 }, matchQuality: 0.7, priority: 5 }),
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 5, weightWithinTier: 500 }, matchQuality: 0.8, priority: 1 }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['A', 'B', 'D', 'C', 'E']);
  });

  it('RK-10: priority dominance at same specificity', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 10 }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 3 }),
      makeScoredCandidate({ ruleId: 'C', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8, priority: 1 }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['C', 'B', 'A']);
  });

  it('RK-11: ranking transitivity — A > B, B > C ⇒ A > C', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
      makeScoredCandidate({ ruleId: 'C', specificityScore: { highestTier: 1, weightWithinTier: 100 } }),
    ];
    const result = rankCandidates(candidates);
    expect(result.map((c) => c.ruleId)).toEqual(['A', 'B', 'C']);
  });

  it('RK-12: ranking idempotence — running twice yields same order', () => {
    const candidates = [
      makeScoredCandidate({ ruleId: 'E', specificityScore: { highestTier: 1, weightWithinTier: 100 }, matchQuality: 0.9, priority: 1 }),
      makeScoredCandidate({ ruleId: 'D', specificityScore: { highestTier: 4, weightWithinTier: 400 }, matchQuality: 0.9, priority: 1 }),
      makeScoredCandidate({ ruleId: 'C', specificityScore: { highestTier: 4, weightWithinTier: 380 }, matchQuality: 0.9, priority: 1 }),
      makeScoredCandidate({ ruleId: 'B', specificityScore: { highestTier: 5, weightWithinTier: 500 }, matchQuality: 0.7, priority: 5 }),
      makeScoredCandidate({ ruleId: 'A', specificityScore: { highestTier: 5, weightWithinTier: 500 }, matchQuality: 0.8, priority: 1 }),
    ];
    const first = rankCandidates(candidates);
    const second = rankCandidates(first);
    expect(second.map((c) => c.ruleId)).toEqual(first.map((c) => c.ruleId));
  });
});
