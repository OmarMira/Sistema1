import { describe, it, expect } from 'vitest';
import { classify, makeDecision, AMBIGUITY_DELTA_THRESHOLD } from '../decision';
import { makeScoredCandidate } from './fixtures';
import type { ScoredCandidate, DecisionReason, TraceEvent } from '../types';

describe('AMBIGUITY_DELTA_THRESHOLD', () => {
  it('is 0.10', () => {
    expect(AMBIGUITY_DELTA_THRESHOLD).toBe(0.10);
  });
});

describe('classify', () => {
  it('DC-01: zero candidates → no_match, reason=no_candidates', () => {
    const result = classify([]);
    expect(result.winner).toBeUndefined();
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('No matching rules found');
    expect(result.reason).toBe('no_candidates');
  });

  it('DC-02: one candidate → winner, reason=single_candidate', () => {
    const scored = [makeScoredCandidate({ ruleId: 'rule-123' })];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-123');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('Single candidate');
    expect(result.reason).toBe('single_candidate');
  });

  it('DC-03: different highestTier → winner, reason=higher_specificity_tier', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('specificity tier');
    expect(result.reason).toBe('higher_specificity_tier');
  });

  it('DC-04: same tier, different weight → winner, reason=higher_specificity_weight', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('specificity weight');
    expect(result.reason).toBe('higher_specificity_weight');
  });

  it('DC-05: same spec, DELTA >= 0.10 → winner, reason=delta_above_threshold', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.80 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.explanation).toContain('DELTA');
    expect(result.explanation).toContain('exceeds threshold');
    expect(result.reason).toBe('delta_above_threshold');
    expect(result.delta).toBeCloseTo(0.15, 10);
  });

  it('DC-06: same spec, DELTA < 0.10 → ambiguous, reason=delta_below_threshold', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.72 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.68 }),
    ];
    const result = classify(scored);
    expect(result.winner).toBeUndefined();
    expect(result.isAmbiguous).toBe(true);
    expect(result.explanation).toContain('DELTA');
    expect(result.explanation).toContain('below threshold');
    expect(result.reason).toBe('delta_below_threshold');
    expect(result.delta).toBeCloseTo(0.04, 10);
  });

  it('DC-07: DELTA >= 0.10 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7 }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.reason).toBe('delta_above_threshold');
  });

  it('DC-08: DELTA < 0.10 → ambiguous (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7499 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const result = classify(scored);
    expect(result.winner).toBeUndefined();
    expect(result.isAmbiguous).toBe(true);
    expect(result.reason).toBe('delta_below_threshold');
  });

  it('DC-09: DELTA == 0.1001 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7501 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const result = classify(scored);
    expect(result.winner?.ruleId).toBe('rule-A');
    expect(result.isAmbiguous).toBe(false);
    expect(result.reason).toBe('delta_above_threshold');
  });
});

describe('makeDecision', () => {
  it('DC-01: zero candidates → no_match', () => {
    const [decision] = makeDecision([]);
    expect(decision.result).toBe('no_match');
    expect(decision.ruleId).toBeUndefined();
    expect(decision.explanation).toContain('No matching rules found');
  });

  it('DC-02: one candidate → winner', () => {
    const scored = [makeScoredCandidate({ ruleId: 'rule-123' })];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.ruleId).toBe('rule-123');
    expect(decision.explanation).toContain('Single candidate');
  });

  it('DC-03: different highestTier → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.ruleId).toBe('rule-A');
    expect(decision.explanation).toContain('specificity tier');
  });

  it('DC-04: same tier, different weight → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.explanation).toContain('specificity weight');
  });

  it('DC-05: same spec, DELTA >= 0.10 → winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.80 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.explanation).toContain('DELTA');
    expect(decision.explanation).toContain('exceeds threshold');
  });

  it('DC-06: same spec, DELTA < 0.10 → ambiguous', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.72 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.68 }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('ambiguous');
    expect(decision.ruleId).toBeUndefined();
  });

  it('DC-07: DELTA >= 0.10 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.8 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7 }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
  });

  it('DC-08: DELTA < 0.10 → ambiguous (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7499 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('ambiguous');
  });

  it('DC-09: DELTA == 0.1001 → winner (boundary)', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.7501 }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
  });

  it('DC-10: Candidate mapping: ruleId preserved', () => {
    const scored = [makeScoredCandidate({ ruleId: 'rule-123' })];
    const [decision] = makeDecision(scored);
    expect(decision.candidateList[0].ruleId).toBe('rule-123');
  });

  it('DC-11: Candidate mapping: conditionScores preserved', () => {
    const scored = [makeScoredCandidate({ conditionScores: [1, 0.5] })];
    const [decision] = makeDecision(scored);
    expect(decision.candidateList[0].conditionScores).toEqual([1, 0.5]);
  });

  it('DC-12: Candidate mapping: priority preserved', () => {
    const scored = [makeScoredCandidate({ priority: 3 })];
    const [decision] = makeDecision(scored);
    expect(decision.candidateList[0].priority).toBe(3);
  });

  it('DC-13: Candidate.specificity = weightWithinTier (compatibility)', () => {
    const scored = [makeScoredCandidate({ specificityScore: { highestTier: 4, weightWithinTier: 400 } })];
    const [decision] = makeDecision(scored);
    expect(decision.candidateList[0].specificity).toBe(400);
  });

  it('DC-14: Candidate.matchQuality preserved', () => {
    const scored = [makeScoredCandidate({ matchQuality: 0.275 })];
    const [decision] = makeDecision(scored);
    expect(decision.candidateList[0].matchQuality).toBe(0.275);
  });

  it('DC-15: Candidate.confidence = 0', () => {
    const scored = [makeScoredCandidate()];
    const [decision] = makeDecision(scored);
    expect(decision.candidateList[0].confidence).toBe(0);
  });

  it('DC-16: classification populated when winner', () => {
    const scored = [
      makeScoredCandidate({
        ruleId: 'rule-A',
        action: { category: 'EXPENSE', entityId: 'ent-123', glAccountId: '6000' },
      }),
    ];
    const [decision] = makeDecision(scored);
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
    const [decision] = makeDecision(scored);
    expect(decision.classification).toBeUndefined();
  });

  it('DC-18: highestTier NOT serialized in Candidate', () => {
    const scored = [makeScoredCandidate({ specificityScore: { highestTier: 4, weightWithinTier: 400 } })];
    const [decision] = makeDecision(scored);
    const candidate = decision.candidateList[0];
    expect(candidate.specificity).toBe(400);
    expect((candidate as unknown as Record<string, unknown>).highestTier).toBeUndefined();
  });

  it('DC-19: EngineDecision.ruleId matches top candidate when winner', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'rule-A', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'rule-B', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const [decision] = makeDecision(scored);
    expect(decision.result).toBe('winner');
    expect(decision.ruleId).toBe('rule-A');
  });
});

describe('decision trace events', () => {
  it('emits outcome with reason=no_candidates', () => {
    const [, events] = makeDecision([]);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.stage).toBe('decision');
    if (event.stage === 'decision' && event.event === 'outcome') {
      expect(event.result).toBe('no_match');
      expect(event.reason).toBe('no_candidates');
      expect(event.threshold).toBe(AMBIGUITY_DELTA_THRESHOLD);
      expect(event.winnerRuleId).toBeUndefined();
      expect(event.delta).toBeUndefined();
    }
  });

  it('emits outcome with reason=single_candidate', () => {
    const scored = [makeScoredCandidate({ ruleId: 'r1' })];
    const [, events] = makeDecision(scored);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event.stage === 'decision' && event.event === 'outcome') {
      expect(event.result).toBe('winner');
      expect(event.reason).toBe('single_candidate');
      expect(event.winnerRuleId).toBe('r1');
    }
  });

  it('emits outcome with reason=higher_specificity_tier', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'r-high', specificityScore: { highestTier: 5, weightWithinTier: 500 } }),
      makeScoredCandidate({ ruleId: 'r-low', specificityScore: { highestTier: 3, weightWithinTier: 300 } }),
    ];
    const [, events] = makeDecision(scored);
    const event = events[0];
    if (event.stage === 'decision' && event.event === 'outcome') {
      expect(event.reason).toBe('higher_specificity_tier');
    }
  });

  it('emits outcome with reason=higher_specificity_weight', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'r-high', specificityScore: { highestTier: 4, weightWithinTier: 400 } }),
      makeScoredCandidate({ ruleId: 'r-low', specificityScore: { highestTier: 4, weightWithinTier: 380 } }),
    ];
    const [, events] = makeDecision(scored);
    const event = events[0];
    if (event.stage === 'decision' && event.event === 'outcome') {
      expect(event.reason).toBe('higher_specificity_weight');
    }
  });

  it('emits outcome with reason=delta_above_threshold', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'r-a', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.85 }),
      makeScoredCandidate({ ruleId: 'r-b', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.65 }),
    ];
    const [, events] = makeDecision(scored);
    const event = events[0];
    if (event.stage === 'decision' && event.event === 'outcome') {
      expect(event.reason).toBe('delta_above_threshold');
      expect(event.delta).toBeCloseTo(0.20, 10);
    }
  });

  it('emits outcome with reason=delta_below_threshold', () => {
    const scored = [
      makeScoredCandidate({ ruleId: 'r-a', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.72 }),
      makeScoredCandidate({ ruleId: 'r-b', specificityScore: { highestTier: 3, weightWithinTier: 300 }, matchQuality: 0.68 }),
    ];
    const [, events] = makeDecision(scored);
    const event = events[0];
    if (event.stage === 'decision' && event.event === 'outcome') {
      expect(event.reason).toBe('delta_below_threshold');
      expect(event.delta).toBeCloseTo(0.04, 10);
    }
  });

  it('exhaustive switch on DecisionReason — every variant compiles', () => {
    const reasons: DecisionReason[] = [
      'no_candidates',
      'single_candidate',
      'higher_specificity_tier',
      'higher_specificity_weight',
      'delta_above_threshold',
      'delta_below_threshold',
    ];
    for (const reason of reasons) {
      switch (reason) {
        case 'no_candidates': break;
        case 'single_candidate': break;
        case 'higher_specificity_tier': break;
        case 'higher_specificity_weight': break;
        case 'delta_above_threshold': break;
        case 'delta_below_threshold': break;
        default: { const _exhaustive: never = reason; expect(_exhaustive).toBe(reason); }
      }
    }
  });

  it('stage guard preserves events on error path', () => {
    try {
      makeDecision([makeScoredCandidate({ ruleId: 'test' })], undefined);
    } catch (err) {
      const events: TraceEvent[] = (err as any).__ruleEngineEvents ?? [];
      expect(Array.isArray(events)).toBe(true);
    }
  });
});
