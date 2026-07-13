import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRule, makeTransaction, makeCondition, makeRuleInput, makeEvaluatedCondition } from './fixtures';
import type { PipelineArtifacts, TraceEvent } from '../types';
import { runPipeline } from '../pipeline';
import { evaluateRules } from '../index';
import { MissingEntityIdError, InvalidRegex } from '../errors';
import { attachTraceToError } from '../trace';

describe('collectCandidates', () => {
  it('filters by isActive', () => {
    const rules = [
      makeRule({ isActive: true, id: 'r1' }),
      makeRule({ isActive: false, id: 'r2' }),
    ];
    const input = makeRuleInput({ context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates.map((c) => c.ruleId)).toEqual(['r1']);
  });

  it('filters by lifecycleStatus active or testing', () => {
    const rules = [
      makeRule({ lifecycleStatus: 'active', id: 'r1' }),
      makeRule({ lifecycleStatus: 'draft', id: 'r2' }),
      makeRule({ lifecycleStatus: 'testing', id: 'r3' }),
      makeRule({ lifecycleStatus: 'archived', id: 'r4' }),
      makeRule({ lifecycleStatus: 'deprecated', id: 'r5' }),
    ];
    const input = makeRuleInput({ context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    const matchedRuleIds = result.rawCandidates.map((c) => c.ruleId);
    expect(matchedRuleIds).toContain('r1');
    expect(matchedRuleIds).toContain('r3');
    expect(matchedRuleIds).not.toContain('r2');
    expect(matchedRuleIds).not.toContain('r4');
    expect(matchedRuleIds).not.toContain('r5');
  });

  it('filters by companyId', () => {
    const rules = [
      makeRule({ companyId: 'company-1', id: 'r1' }),
      makeRule({ companyId: 'company-2', id: 'r2' }),
    ];
    const tx = makeTransaction({ companyId: 'company-1' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates.map((c) => c.ruleId)).toEqual(['r1']);
  });

  it('empty availableRules returns empty', () => {
    const input = makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toEqual([]);
    expect(result.evaluations.size).toBe(0);
  });
});

describe('evaluateConditions', () => {
  it('correctly evaluates a rule with amount_gt condition', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
    });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(1);
    expect(result.rawCandidates[0].ruleId).toBe(rule.id);
  });

  it('produces a candidate with 2 condition scores', () => {
    const rule = makeRule({
      conditions: [
        makeCondition('amount_gt', 500),
        makeCondition('description_contains', 'INVOICE'),
      ],
    });
    const tx = makeTransaction({ amount: 600, description: 'INVOICE #123' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(1);
    expect(result.rawCandidates[0].conditionScores).toHaveLength(2);
    expect(result.rawCandidates[0].conditionScores[0]).toBe(1);
  });
});

describe('discardInvalid', () => {
  it('discards rules where a condition fails', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
    });
    const tx = makeTransaction({ amount: 100 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(0);
  });

  it('mixed: some match, some fail', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)], id: 'r1' }),
      makeRule({ conditions: [makeCondition('amount_lt', 1000)], id: 'r2' }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(2);
  });

  it('all conditions match survives', () => {
    const rule = makeRule({
      conditions: [
        makeCondition('amount_gt', 100),
        makeCondition('amount_lt', 1000),
        makeCondition('description_contains', 'TEST'),
      ],
    });
    const tx = makeTransaction({ amount: 500, description: 'TEST transaction' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(1);
  });

  it('multiple entries some fail', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 100)], id: 'r1' }),
      makeRule({ conditions: [makeCondition('amount_gt', 1000)], id: 'r2' }),
      makeRule({ conditions: [makeCondition('amount_gt', 50)], id: 'r3' }),
    ];
    const tx = makeTransaction({ amount: 200 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(2);
    expect(result.rawCandidates.map((c) => c.ruleId)).toEqual(['r1', 'r3']);
  });

  it('no mutation of input', () => {
    const rules = [makeRule({ conditions: [makeCondition('amount_gt', 500)] })];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const originalRules = [...input.context.availableRules];
    const originalTx = { ...input.transaction };
    const [,] = runPipeline(input);
    expect(input.context.availableRules).toEqual(originalRules);
    expect(input.transaction).toEqual(originalTx);
  });
});

describe('produceCandidates', () => {
  it('produces PipelineArtifacts with RawCandidate[]', () => {
    const rule = makeRule({
      conditions: [
        makeCondition('amount_gt', 100),
        makeCondition('amount_lt', 1000),
        makeCondition('description_contains', 'TEST'),
      ],
    });
    const tx = makeTransaction({ amount: 500, description: 'TEST' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result).toHaveProperty('rawCandidates');
    expect(Array.isArray(result.rawCandidates)).toBe(true);
    expect(result).toHaveProperty('evaluations');
    expect(result.evaluations instanceof Map).toBe(true);
  });

  it('RawCandidate has no ranking data', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
      action: { category: 'EXPENSE' },
    });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    const raw = result.rawCandidates[0];
    expect(raw).not.toHaveProperty('specificity');
    expect(raw).not.toHaveProperty('matchQuality');
    expect(raw).not.toHaveProperty('confidence');
    expect(raw.ruleId).toBeDefined();
    expect(raw.conditionScores).toBeDefined();
    expect(raw.priority).toBeDefined();
    expect(raw.action).toBeDefined();
  });

  it('evaluations map keyed by ruleId', () => {
    const rule = makeRule({
      id: 'test-rule-1',
      conditions: [makeCondition('amount_gt', 500)],
    });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    const evals = result.evaluations.get('test-rule-1');
    expect(evals).toBeDefined();
    expect(evals).toHaveLength(1);
    expect(evals![0].type).toBe('amount_gt');
  });

  it('conditionScores copied from evaluations', () => {
    const rule = makeRule({
      conditions: [
        makeCondition('amount_gt', 100),
        makeCondition('description_contains', 'TEST'),
        makeCondition('amount_lt', 1000),
      ],
    });
    const tx = makeTransaction({ amount: 500, description: 'TEST' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates[0].conditionScores).toEqual([1, 1, 1]);
  });

  it('action preserved in RawCandidate', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
      action: { category: 'EXPENSE', entityId: 'ent-1', glAccountId: '6000' },
    });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates[0].action).toEqual({ category: 'EXPENSE', entityId: 'ent-1', glAccountId: '6000' });
  });

  it('empty entries', () => {
    const input = makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toEqual([]);
    expect(result.evaluations.size).toBe(0);
  });

  it('multiple entries', () => {
    const rules = [
      makeRule({ id: 'r1', conditions: [makeCondition('amount_gt', 100)] }),
      makeRule({ id: 'r2', conditions: [makeCondition('description_contains', 'X')] }),
      makeRule({ id: 'r3', conditions: [makeCondition('amount_lt', 1000)] }),
    ];
    const tx = makeTransaction({ amount: 500, description: 'X transaction' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(3);
    expect(result.evaluations.size).toBe(3);
    expect(result.evaluations.has('r1')).toBe(true);
    expect(result.evaluations.has('r2')).toBe(true);
    expect(result.evaluations.has('r3')).toBe(true);
  });

  it('maps priority from BankRule', () => {
    const rule = makeRule({ priority: 42, conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates[0].priority).toBe(42);
  });
});

describe('runPipeline integration', () => {
  it('full pipeline: valid input returns candidates', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 100)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toHaveLength(1);
  });

  it('empty input returns empty', () => {
    const input = makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toEqual([]);
  });

  it('all rules fail returns empty', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 1000)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 50)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [result] = runPipeline(input);
    expect(result.rawCandidates).toEqual([]);
  });

  it('deterministic: same input, same output', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 100)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [first] = runPipeline(input);
    const [second] = runPipeline(input);
    expect(first).toEqual(second);
  });

  it('no mutation of input', () => {
    const rules = [makeRule({ conditions: [makeCondition('amount_gt', 500)] })];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const originalRules = [...input.context.availableRules];
    const originalTx = { ...input.transaction };
    const [,] = runPipeline(input);
    expect(input.context.availableRules).toEqual(originalRules);
    expect(input.transaction).toEqual(originalTx);
  });
});

describe('Integration (evaluateRules)', () => {
  beforeEach(() => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
  });

  it('INT-01: full pipeline valid input with 3 rules → winner decision', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 100), makeCondition('amount_lt', 1000)], action: { category: 'EXPENSE' } }),
      makeRule({ conditions: [makeCondition('description_contains', 'TEST')], action: { category: 'REVENUE' } }),
      makeRule({ conditions: [makeCondition('amount_gt', 5000)], action: { category: 'INVESTMENT' } }),
    ];
    const tx = makeTransaction({ amount: 600, description: 'TEST transaction' });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(2);
    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.type).toBe('rule');
    expect(result.output.decision!.ruleId).toBeDefined();
  });

  it('INT-02: full flow with entity_eq matching → winner', () => {
    const rule = makeRule({
      conditions: [makeCondition('entity_eq', 'ent-123')],
      action: { category: 'EXPENSE', glAccountId: '6000' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'resolved', entityId: 'ent-123' } },
    });
    expect(result.output.candidates).toHaveLength(1);
    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.ruleId).toBe(rule.id);
    expect(result.output.decision!.explanation).toBe('Single candidate');
  });

  it('INT-03: full flow with entity_eq not matching → no_match', () => {
    const rule = makeRule({
      conditions: [makeCondition('entity_eq', 'ent-123')],
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'resolved', entityId: 'ent-999' } },
    });
    expect(result.output.candidates).toHaveLength(0);
    expect(result.output.decision!.result).toBe('no_match');
    expect(result.output.decision!.ruleId).toBeUndefined();
  });

  it('INT-04: full flow with ambiguity → ambiguous', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 100)], action: { category: 'EXPENSE' } }),
      makeRule({ conditions: [makeCondition('amount_gt', 100)], action: { category: 'REVENUE' } }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(2);
    expect(result.output.decision!.result).toBe('ambiguous');
    expect(result.output.decision!.ruleId).toBeUndefined();
    expect(result.output.decision!.explanation).toContain('ambiguous');
  });

  it('INT-05: full flow with no candidates → no_match', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 1000)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 50)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(0);
    expect(result.output.decision!.result).toBe('no_match');
    expect(result.output.decision!.ruleId).toBeUndefined();
    expect(result.output.decision!.explanation).toBe('No matching rules found');
  });

  it('INT-06: full flow with mixed specificity → winner by highestTier', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('entity_eq', 'ent-001')], action: { category: 'EXPENSE' } }),
      makeRule({ conditions: [makeCondition('description_contains', 'TEST')], action: { category: 'REVENUE' } }),
    ];
    const tx = makeTransaction({ amount: 600, description: 'TEST transaction' });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'resolved', entityId: 'ent-001' } },
    });
    expect(result.output.candidates).toHaveLength(2);
    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.ruleId).toBe(rules[0].id);
    expect(result.output.decision!.explanation).toBe('Top candidate wins by specificity tier');
    expect(result.output.candidates[0].ruleId).toBe(rules[0].id);
  });

  it('INT-07: full flow with same tier diff weight → winner by weight', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('description_eq', 'INVOICE PAYMENT')], action: { category: 'EXPENSE' } }),
      makeRule({ conditions: [makeCondition('amount_eq', 500)], action: { category: 'REVENUE' } }),
    ];
    const tx = makeTransaction({ amount: 500, description: 'INVOICE PAYMENT' });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(2);
    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.ruleId).toBe(rules[0].id);
    expect(result.output.decision!.explanation).toBe('Top candidate wins by specificity weight');
    expect(result.output.candidates[0].ruleId).toBe(rules[0].id);
    expect(result.output.candidates[0].specificity).toBe(400);
    expect(result.output.candidates[1].specificity).toBe(380);
  });

  it('INT-08: evaluateRules integrates with full pipeline', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 100)],
      action: { category: 'EXPENSE', glAccountId: '6000' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(1);
    expect(result.output.candidates[0].ruleId).toBe(rule.id);
    expect(result.output.candidates[0].specificity).toBeGreaterThan(0);
    expect(result.output.candidates[0].matchQuality).toBeGreaterThan(0);
    expect(result.output.candidates[0].confidence).toBe(0);
    expect(result.output.decision).toBeDefined();
    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.classification).toBeDefined();
    expect(result.output.decision!.classification!.category).toBe('EXPENSE');
  });

  it('INT-09: discardInvalidConfiguration filters empty conditions before pipeline', () => {
    const rule = makeRule({
      conditions: [],
      action: { category: 'EXPENSE' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(0);
    expect(result.output.decision!.result).toBe('no_match');
  });

  it('INT-10: entity_eq not_run propagates MissingEntityIdError through full flow', () => {
    const rule = makeRule({
      conditions: [makeCondition('entity_eq', 'ent-123')],
    });
    const tx = makeTransaction({ amount: 600 });
    expect(() => evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    })).toThrow(MissingEntityIdError);
  });

  it('INT-11: large-scale — 15 rules with varied specificity → correct ranking', () => {
    const tx = makeTransaction({ amount: 500, description: 'INVOICE PAYMENT PROCESSED', date: new Date('2024-06-15') });
    const rules = [
      makeRule({ id: 'r-entity', conditions: [makeCondition('entity_eq', 'ent-001')], priority: 10, action: { category: 'TAX' } }),
      makeRule({ id: 'r-desc-eq', conditions: [makeCondition('description_eq', 'INVOICE PAYMENT PROCESSED')], priority: 3, action: { category: 'EXPENSE' } }),
      makeRule({ id: 'r-amt-eq', conditions: [makeCondition('amount_eq', 500)], priority: 5, action: { category: 'REVENUE' } }),
      makeRule({ id: 'r-match-1', conditions: [makeCondition('description_matches', 'PAYMENT.*')], priority: 2 }),
      makeRule({ id: 'r-match-2', conditions: [makeCondition('description_matches', 'PROCESSED')], priority: 6 }),
      makeRule({ id: 'r-starts', conditions: [makeCondition('description_starts_with', 'INVOICE')], priority: 4 }),
      makeRule({ id: 'r-ends', conditions: [makeCondition('description_ends_with', 'PROCESSED')], priority: 8 }),
      makeRule({ id: 'r-range', conditions: [makeCondition('amount_range', 200, [200, 800])], priority: 9 }),
      makeRule({ id: 'r-contains', conditions: [makeCondition('description_contains', 'INVOICE')], priority: 7 }),
      makeRule({ id: 'r-gt', conditions: [makeCondition('amount_gt', 100)], priority: 11 }),
      makeRule({ id: 'r-gte', conditions: [makeCondition('amount_gte', 200)], priority: 12 }),
      makeRule({ id: 'r-lt', conditions: [makeCondition('amount_lt', 1000)], priority: 13 }),
      makeRule({ id: 'r-lte', conditions: [makeCondition('amount_lte', 800)], priority: 14 }),
      makeRule({ id: 'r-date-before', conditions: [makeCondition('date_before', '2025-01-01')], priority: 15 }),
      makeRule({ id: 'r-date-after', conditions: [makeCondition('date_after', '2023-01-01')], priority: 16 }),
    ];
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'resolved', entityId: 'ent-001' } },
    });
    expect(result.output.candidates).toHaveLength(15);
    const rankedIds = result.output.candidates.map((c) => c.ruleId);

    expect(rankedIds[0]).toBe('r-entity');
    expect(rankedIds[1]).toBe('r-desc-eq');
    expect(rankedIds[2]).toBe('r-amt-eq');
    expect(rankedIds[3]).toBe('r-match-1');
    expect(rankedIds[4]).toBe('r-match-2');
    expect(rankedIds[5]).toBe('r-starts');
    expect(rankedIds[6]).toBe('r-ends');
    expect(rankedIds[7]).toBe('r-range');
    expect(rankedIds[8]).toBe('r-contains');

    const weight100Ids = rankedIds.slice(9, 13);
    expect(weight100Ids).toEqual(['r-gt', 'r-gte', 'r-lt', 'r-lte']);

    const weight50Ids = rankedIds.slice(13, 15);
    expect(weight50Ids).toEqual(['r-date-before', 'r-date-after']);

    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.ruleId).toBe('r-entity');
    expect(result.output.decision!.explanation).toBe('Top candidate wins by specificity tier');
  });

  it('INT-FF: feature flag disabled returns Sprint 1 behavior', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 100)],
      action: { category: 'EXPENSE' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result).toEqual({ output: { candidates: [], decision: undefined } });
  });
});

describe('pipeline trace events', () => {
  it('emits candidates_collected with correct count', () => {
    const rules = [
      makeRule({ id: 'r1', conditions: [makeCondition('amount_gt', 100)] }),
      makeRule({ id: 'r2', conditions: [makeCondition('amount_lt', 1000)] }),
    ];
    const tx = makeTransaction({ amount: 500 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [, events] = runPipeline(input);
    expect(events[0]).toEqual({ stage: 'pipeline', event: 'candidates_collected', count: 2 });
  });

  it('emits condition_evaluated for each condition', () => {
    const rule = makeRule({
      id: 'r1',
      conditions: [
        makeCondition('amount_gt', 100),
        makeCondition('description_contains', 'TEST'),
      ],
    });
    const tx = makeTransaction({ amount: 500, description: 'TEST' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [, events] = runPipeline(input);
    const condEvents = events.filter((e): e is Extract<TraceEvent, { stage: 'pipeline'; event: 'condition_evaluated' }> =>
      e.stage === 'pipeline' && e.event === 'condition_evaluated',
    );
    expect(condEvents).toHaveLength(2);
    expect(condEvents[0].ruleId).toBe('r1');
    expect(condEvents[0].conditionType).toBe('amount_gt');
    expect(condEvents[0].score).toBe(1);
    expect(condEvents[0].matched).toBe(true);
  });

  it('emits candidate_valid for matching rules', () => {
    const rule = makeRule({ id: 'r1', conditions: [makeCondition('amount_gt', 100)] });
    const tx = makeTransaction({ amount: 500 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [, events] = runPipeline(input);
    const validEvents = events.filter((e): e is Extract<TraceEvent, { stage: 'pipeline'; event: 'candidate_valid' }> =>
      e.stage === 'pipeline' && e.event === 'candidate_valid',
    );
    expect(validEvents).toHaveLength(1);
    expect(validEvents[0].ruleId).toBe('r1');
    expect(validEvents[0].conditionCount).toBe(1);
  });

  it('emits candidate_discarded for failing rules', () => {
    const rule = makeRule({ id: 'r1', conditions: [makeCondition('amount_gt', 1000)] });
    const tx = makeTransaction({ amount: 500 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    const [, events] = runPipeline(input);
    const discardedEvents = events.filter((e): e is Extract<TraceEvent, { stage: 'pipeline'; event: 'candidate_discarded' }> =>
      e.stage === 'pipeline' && e.event === 'candidate_discarded',
    );
    expect(discardedEvents).toHaveLength(1);
    expect(discardedEvents[0].ruleId).toBe('r1');
  });

  it('stage guard preserves partial events on error', () => {
    const rule = makeRule({ id: 'r1', conditions: [makeCondition('description_matches', '[invalid')] });
    const tx = makeTransaction({ amount: 500 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } });
    try {
      runPipeline(input);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRegex);
      const events: TraceEvent[] = (err as any).__ruleEngineEvents ?? [];
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].stage).toBe('pipeline');
    }
  });
});
