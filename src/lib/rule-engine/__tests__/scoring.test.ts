import { describe, it, expect } from 'vitest';
import { computeMatchQuality, scoreCandidates, MATCH_QUALITY_ALPHA } from '../scoring';
import { InvalidPipelineStateError, InvalidPipelineStateError as PipelineStateError } from '../errors';
import { makeEvaluatedCondition, makeRawCandidate, makePipelineArtifacts } from './fixtures';
import type { TraceEvent } from '../types';

describe('MATCH_QUALITY_ALPHA', () => {
  it('is 0.25', () => {
    expect(MATCH_QUALITY_ALPHA).toBe(0.25);
  });
});

describe('computeMatchQuality', () => {
  it('SQ-06: single score returns that score', () => {
    expect(computeMatchQuality([0.8])).toBe(0.8);
  });

  it('SQ-07: all equal scores returns that score', () => {
    expect(computeMatchQuality([0.5, 0.5, 0.5])).toBe(0.5);
  });

  it('SQ-08: mixed scores uses formula', () => {
    const result = computeMatchQuality([0.2, 0.8, 0.5]);
    expect(result).toBeCloseTo(0.275, 10);
  });

  it('SQ-09: alpha=0.25 blending (not average, not min)', () => {
    const result = computeMatchQuality([0.1, 1.0]);
    const min = 0.1;
    const avg = 0.55;
    const expected = min + 0.25 * (avg - min);
    expect(result).toBeCloseTo(expected, 10);
  });

  it('SQ-10: edge: all zeros', () => {
    expect(computeMatchQuality([0, 0, 0])).toBe(0);
  });

  it('SQ-11: edge: all ones', () => {
    expect(computeMatchQuality([1, 1, 1])).toBe(1);
  });

  it('SQ-12: edge: empty scores (defensive)', () => {
    expect(computeMatchQuality([])).toBe(0);
  });
});

describe('scoreCandidates', () => {
  it('SQ-01: valid PipelineArtifacts produces ScoredCandidate[]', () => {
    const evals = [
      makeEvaluatedCondition({ type: 'amount_gt', match: true, score: 1 }),
    ];
    const artifacts = makePipelineArtifacts({
      rawCandidates: [makeRawCandidate({ ruleId: 'rule-1', conditionScores: [1] })],
      evaluations: new Map([['rule-1', evals]]),
    });
    const [result] = scoreCandidates(artifacts);
    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe('rule-1');
    expect(result[0].specificityScore).toEqual({ highestTier: 1, weightWithinTier: 100 });
    expect(result[0].matchQuality).toBe(1);
  });

  it('SQ-02: missing evaluation entry throws InvalidPipelineStateError', () => {
    const artifacts = makePipelineArtifacts({
      rawCandidates: [makeRawCandidate({ ruleId: 'rule-1' })],
      evaluations: new Map(),
    });
    expect(() => scoreCandidates(artifacts)).toThrow(InvalidPipelineStateError);
  });

  it('SQ-03: RawCandidate fields preserved in ScoredCandidate', () => {
    const evals = [
      makeEvaluatedCondition({ type: 'amount_gt', match: true, score: 1 }),
    ];
    const raw = makeRawCandidate({
      ruleId: 'rule-1',
      priority: 5,
      conditionScores: [1],
      action: { category: 'EXPENSE', entityId: 'ent-1', glAccountId: '6000' },
    });
    const artifacts = makePipelineArtifacts({
      rawCandidates: [raw],
      evaluations: new Map([['rule-1', evals]]),
    });
    const [result] = scoreCandidates(artifacts);
    expect(result[0].ruleId).toBe('rule-1');
    expect(result[0].priority).toBe(5);
    expect(result[0].conditionScores).toEqual([1]);
    expect(result[0].action).toEqual({ category: 'EXPENSE', entityId: 'ent-1', glAccountId: '6000' });
  });

  it('SQ-04: empty rawCandidates returns empty array', () => {
    const artifacts = makePipelineArtifacts({
      rawCandidates: [],
      evaluations: new Map(),
    });
    const [result] = scoreCandidates(artifacts);
    expect(result).toEqual([]);
  });

  it('SQ-05: multiple candidates scored independently', () => {
    const evals1 = [
      makeEvaluatedCondition({ type: 'amount_gt', match: true, score: 1 }),
    ];
    const evals2 = [
      makeEvaluatedCondition({ type: 'description_eq', match: true, score: 0.5 }),
    ];
    const artifacts = makePipelineArtifacts({
      rawCandidates: [
        makeRawCandidate({ ruleId: 'rule-1', conditionScores: [1] }),
        makeRawCandidate({ ruleId: 'rule-2', conditionScores: [0.5] }),
      ],
      evaluations: new Map([
        ['rule-1', evals1],
        ['rule-2', evals2],
      ]),
    });
    const [result] = scoreCandidates(artifacts);
    expect(result).toHaveLength(2);
    expect(result[0].ruleId).toBe('rule-1');
    expect(result[0].specificityScore.highestTier).toBe(1);
    expect(result[1].ruleId).toBe('rule-2');
    expect(result[1].specificityScore.highestTier).toBe(4);
  });
});

describe('scoring trace events', () => {
  it('emits candidate_scored for each candidate', () => {
    const evals = [
      makeEvaluatedCondition({ type: 'amount_gt', match: true, score: 1 }),
    ];
    const artifacts = makePipelineArtifacts({
      rawCandidates: [makeRawCandidate({ ruleId: 'rule-1', conditionScores: [1] })],
      evaluations: new Map([['rule-1', evals]]),
    });
    const [, events] = scoreCandidates(artifacts);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.stage).toBe('scoring');
    if (event.stage === 'scoring' && event.event === 'candidate_scored') {
      expect(event.ruleId).toBe('rule-1');
      expect(event.highestTier).toBe(1);
      expect(event.weightWithinTier).toBe(100);
      expect(event.matchQuality).toBe(1);
    }
  });

  it('emits one event per candidate', () => {
    const evals1 = [makeEvaluatedCondition({ type: 'amount_gt', match: true, score: 1 })];
    const evals2 = [makeEvaluatedCondition({ type: 'description_eq', match: true, score: 0.5 })];
    const artifacts = makePipelineArtifacts({
      rawCandidates: [
        makeRawCandidate({ ruleId: 'rule-1', conditionScores: [1] }),
        makeRawCandidate({ ruleId: 'rule-2', conditionScores: [0.5] }),
      ],
      evaluations: new Map([
        ['rule-1', evals1],
        ['rule-2', evals2],
      ]),
    });
    const [, events] = scoreCandidates(artifacts);
    expect(events).toHaveLength(2);
  });

  it('stage guard preserves partial events on error', () => {
    const artifacts = makePipelineArtifacts({
      rawCandidates: [makeRawCandidate({ ruleId: 'rule-1' })],
      evaluations: new Map(),
    });
    try {
      scoreCandidates(artifacts);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineStateError);
      const events: TraceEvent[] = (err as any).__ruleEngineEvents ?? [];
      expect(events).toHaveLength(0);
    }
  });
});
