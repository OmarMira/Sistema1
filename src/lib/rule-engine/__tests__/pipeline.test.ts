import { describe, it, expect } from 'vitest';
import { makeRule, makeTransaction, makeCondition, makeRuleInput, makeEvaluatedCondition } from './fixtures';
import { runPipeline } from '../pipeline';

describe('collectCandidates', () => {
  it('filters by isActive', () => {
    const rules = [
      makeRule({ isActive: true, id: 'r1' }),
      makeRule({ isActive: false, id: 'r2' }),
    ];
    const input = makeRuleInput({ context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result.map((c) => c.ruleId)).toEqual(['r1']);
  });

  it('filters by lifecycleStatus active or testing', () => {
    const rules = [
      makeRule({ lifecycleStatus: 'active', id: 'r1' }),
      makeRule({ lifecycleStatus: 'draft', id: 'r2' }),
      makeRule({ lifecycleStatus: 'testing', id: 'r3' }),
      makeRule({ lifecycleStatus: 'archived', id: 'r4' }),
      makeRule({ lifecycleStatus: 'deprecated', id: 'r5' }),
    ];
    const input = makeRuleInput({ context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    const matchedRuleIds = result.map((c) => c.ruleId);
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
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result.map((c) => c.ruleId)).toEqual(['r1']);
  });

  it('empty availableRules returns empty', () => {
    const input = makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [] } });
    expect(runPipeline(input)).toEqual([]);
  });
});

describe('evaluateConditions', () => {
  it('correctly evaluates a rule with amount_gt condition', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
    });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe(rule.id);
  });

  it('produces a candidate with 2 condition scores', () => {
    const rule = makeRule({
      conditions: [
        makeCondition('amount_gt', 500),
        makeCondition('description_contains', 'INVOICE'),
      ],
    });
    const tx = makeTransaction({ amount: 600, description: 'INVOICE #123' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result).toHaveLength(1);
    expect(result[0].conditionScores).toHaveLength(2);
    expect(result[0].conditionScores[0]).toBe(1);
  });
});

describe('discardInvalid', () => {
  it('discards rules where a condition fails', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
    });
    const tx = makeTransaction({ amount: 100 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result).toHaveLength(0);
  });

  it('mixed: some match, some fail', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)], id: 'r1' }),
      makeRule({ conditions: [makeCondition('amount_lt', 1000)], id: 'r2' }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result).toHaveLength(2);
  });
});

describe('produceCandidates', () => {
  it('sets specificity, matchQuality, confidence to 0', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result[0].specificity).toBe(0);
    expect(result[0].matchQuality).toBe(0);
    expect(result[0].confidence).toBe(0);
  });

  it('copies conditionScores correctly', () => {
    const rule = makeRule({
      conditions: [
        makeCondition('amount_gt', 500),
        makeCondition('description_contains', 'INVOICE'),
      ],
    });
    const tx = makeTransaction({ amount: 600, description: 'INVOICE #123' });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result[0].conditionScores[0]).toBeGreaterThan(0);
    expect(result[0].conditionScores[1]).toBeGreaterThan(0);
  });

  it('maps priority from BankRule', () => {
    const rule = makeRule({ priority: 42, conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: [rule], entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result[0].priority).toBe(42);
  });

  it('empty entries returns empty array', () => {
    expect(runPipeline(makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [] } }))).toEqual([]);
  });
});

describe('runPipeline integration', () => {
  it('full pipeline: valid input returns candidates', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 100)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const result = runPipeline(input);
    expect(result).toHaveLength(1);
  });

  it('empty input returns empty', () => {
    const input = makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [] } });
    expect(runPipeline(input)).toEqual([]);
  });

  it('all rules fail returns empty', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 1000)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 50)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    expect(runPipeline(input)).toEqual([]);
  });

  it('deterministic: same input, same output', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 100)] }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const first = runPipeline(input);
    const second = runPipeline(input);
    expect(first).toEqual(second);
  });

  it('no mutation of input', () => {
    const rules = [makeRule({ conditions: [makeCondition('amount_gt', 500)] })];
    const tx = makeTransaction({ amount: 600 });
    const input = makeRuleInput({ transaction: tx, context: { availableRules: rules, entityContexts: [], historicalMatches: [] } });
    const originalRules = [...input.context.availableRules];
    const originalTx = { ...input.transaction };
    runPipeline(input);
    expect(input.context.availableRules).toEqual(originalRules);
    expect(input.transaction).toEqual(originalTx);
  });
});
