import { describe, it, expect } from 'vitest';
import { makeRule, makeTransaction, makeCondition, makeRuleInput } from './fixtures';
import { evaluateRules } from '../index';
import { vi } from 'vitest';

describe('explainability', () => {
  it('EXPLAIN-01: winner decision includes explanation', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 100)], action: { category: 'EXPENSE' } });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.decision).toBeDefined();
    expect(result.output.decision!.explanation).toBeTruthy();
    expect(typeof result.output.decision!.explanation).toBe('string');
    expect(result.output.decision!.explanation.length).toBeGreaterThan(0);
  });

  it('EXPLAIN-02: no_match decision includes explanation', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 1000)] });
    const tx = makeTransaction({ amount: 100 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.decision!.result).toBe('no_match');
    expect(result.output.decision!.explanation).toBe('No matching rules found');
  });

  it('EXPLAIN-03: ambiguous decision includes explanation', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const rules = [
      makeRule({ id: 'r1', conditions: [makeCondition('amount_gt', 100)], action: { category: 'EXPENSE' } }),
      makeRule({ id: 'r2', conditions: [makeCondition('amount_gt', 100)], action: { category: 'REVENUE' } }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.decision!.result).toBe('ambiguous');
    expect(result.output.decision!.explanation).toContain('ambiguous');
  });

  it('EXPLAIN-04: audit record contains candidateList', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 100)], action: { category: 'EXPENSE' } });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.audit).toBeDefined();
    expect(result.audit!.candidateList).toBeDefined();
    expect(Array.isArray(result.audit!.candidateList)).toBe(true);
    expect(result.audit!.candidateList.length).toBeGreaterThan(0);
    expect(result.audit!.candidateCount).toBe(result.audit!.candidateList.length);
  });

  it('EXPLAIN-05: audit record contains engineVersion', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 100)], action: { category: 'EXPENSE' } });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.audit).toBeDefined();
    expect(result.audit!.engineVersion).toBeTruthy();
    expect(typeof result.audit!.engineVersion).toBe('string');
  });
});
