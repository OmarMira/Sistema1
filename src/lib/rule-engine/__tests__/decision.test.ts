import { describe, it, expect } from 'vitest';
import { classify, makeDecision, AMBIGUITY_DELTA_THRESHOLD } from '../decision';
import { makeScoredCandidate } from './fixtures';
import type { ScoredCandidate } from '../types';

describe('AMBIGUITY_DELTA_THRESHOLD', () => {
  it('is 0.10', () => {
    expect(AMBIGUITY_DELTA_THRESHOLD).toBe(0.10);
  });
});

describe('classify', () => {
  it('DC-01: zero candidates → no_match', () => {
    const result = classify([]);
    expect(result.winner).toBeUndefined();
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('No matching rules found');
  });

  it('DC-02: one candidate → winner', () => {
    const scored = [makeScoredCandidate({ ruleId: 'rule-123' })];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-123');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('Single candidate');
  });

  it('DC-03: two candidates, different highestTier → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('specificity tier');
  });

  it('DC-04: two candidates, same tier, different weight → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('specificity weight');
  });

  it('DC-05: two candidates, identical spec, DELTA >= 0.10 → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.80 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('DELTA');
    expect(result.explanation).toContain('exceeds threshold');
  });

  it('DC-06: two candidates, identical spec, DELTA < 0.10 → ambiguous', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.72 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.68 }),
    ];
    const result = classify(scored);
    expect(result.winner).toBeUndefined();
    expect(result.isAmbiguous).toBe(true);
    expect(result.explanation).toContain('DELTA');
    expect(result.explanation).toContain('below threshold');
  });

  it('DC-07: two candidates, DELTA >= 0.10 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7 }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
  });

  it('DC-08: two candidates, DELTA < 0.10 → ambiguous (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7499 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const result = classify(scored);
    expect(result.winner).toBeUndefined();
    expect(result.isAmbiguous).toBe(true);
  });

  it('DC-09: two candidates, DELTA == 0.1001 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7501 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
  });
});

describe('makeDecision', () => {
  it('DC-01: zero candidates → no_match', () => {
    const decision = makeDecision([]);
    expect(decision.result).toBe('no_match');
    expect(decision.ruleId).toBeUndefined();
    expect(decision.explanation).toContain('No matching rules found');
  });

  it('DC-02: one candidate → winner', () => {
    const scored = [makeScoredCandidate({ ruleId: 'rule-123' })];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.ruleId).toBe('rule-123');
    expect(decision.explanation).toContain('Single candidate');
  });

  it('DC-03: two candidates, different highestTier → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.ruleId).toBe('rule-A');
    expect(decision.explanation).toContain('specificity tier');
  });

  it('DC-04: two candidates, same tier, different weight → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.explanation).toContain('specificity weight');
  });

  it('DC-05: two candidates, identical spec, DELTA >= 0.10 → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.80 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.explanation).toContain('DELTA');
    expect(decision.explanation).toContain('exceeds threshold');
  });

  it('DC-06: two candidates, identical spec, DELTA < 0.10 → ambiguous', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.72 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.68 }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('ambiguous');
    expect(decision.ruleId).toBeUndefined();
  });

  it('DC-07: two candidates, DELTA >= 0.10 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7 }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
  });

  it('DC-08: two candidates, DELTA < 0.10 → ambiguous (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7499 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('ambiguous');
  });

  it('DC-09: two candidates, DELTA == 0.1001 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7501 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
  });

  it('DC-10: Candidate mapping: ruleId preserved', () => {
    const scored = [makeScoredCandidate({ ruleId: 'rule-123' })];
    const decision = makeDecision(scored);
    expect(decision.candidateList[0].ruleId).toBe('rule-123');
  });

  it('DC-11: Candidate mapping: conditionScores preserved', () => {
    const scored = [makeScoredCandidate({ conditionScores: [1, 0.5] })];
    const decision = makeDecision(scored);
    expect(decision.candidateList[0].conditionScores).toEqual([1, 0.5]);
  });

  it('DC-12: Candidate mapping: priority preserved', () => {
    const scored = [makeScoredCandidate({ priority: 3 })];
    const decision = makeDecision(scored);
    expect(decision.candidateList[0].priority).toBe(3);
  });

  it('DC-13: Candidate.specificity = weightWithinTier (compatibility)', () => {
    const scored = [makeScoredCandidate({ specificityScore: { highestTier: 4, weightWithinTier: 400 } })];
    const decision = makeDecision(scored);
    expect(decision.candidateList[0].specificity).toBe(400);
  });

  it('DC-14: Candidate.matchQuality preserved', () => {
    const scored = [makeScoredCandidate({ matchQuality: 0.275 })];
    const decision = makeDecision(scored);
    expect(decision.candidateList[0].matchQuality).toBe(0.275);
  });

  it('DC-15: Candidate.confidence = 0', () => {
    const scored = [makeScoredCandidate()];
    const decision = makeDecision(scored);
    expect(decision.candidateList[0].confidence).toBe(0);
  });

  it('DC-16: classification populated only when winner', () => {
    const scored = [
      makeScoredCandidate({
        ruleId: 'rule-A',
        action: { category: 'EXPENSE', entityId: 'ent-123', glAccountId: '6000' },
      }),
    ];
    const decision = makeDecision(scored);
    expect(decision.classification).toBeDefined();
    expect(decision.classification?.category).toBe('EXPENSE');
    expect(decision.classification?.entityId).toBe('ent-123');
    expect(decision.classification?.glAccountId).toBe('6000');
  });

  it('DC-17: classification undefined when ambiguous', () => {
    const scored = [
      makeScoredCandidate({
        ruleId: 'rule-A',
        specificityScore: { highestTier: 3, weightWithinTier: 300 },
        matchQuality: 0.72,
        action: { category: 'EXPENSE' },
      }),
      makeScoredCandidate({
        ruleId: 'rule-B',
        specificityScore: { highestTier: 3, weightWithinTier: 300 },
        matchQuality: 0.68,
        action: { category: 'REVENUE' },
      }),
    ];
    const decision = makeDecision(scored);
    expect(decision.classification).toBeUndefined();
  });

  it('DC-18: highestTier NOT serialized in Candidate', () => {
    const scored = [makeScoredCandidate({ specificityScore: { highestTier: 4, weightWithinTier: 400 } })];
    const decision = makeDecision(scored);
    const candidate = decision.candidateList[0];
    expect(candidate.specificity).toBe(400);
    expect((candidate as unknown as Record<string, unknown>).highestTier).toBeUndefined();
  });

  it('DC-19: EngineDecision.ruleId matches top candidate when winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const decision = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.ruleId).toBe('rule-A');
  });
});
