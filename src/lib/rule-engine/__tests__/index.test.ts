import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRules } from '../index';
import { MissingTransaction, MissingContext, InvalidTransaction, InvalidRegex, MissingEntityIdError } from '../errors';
import { makeRule, makeTransaction, makeCondition } from './fixtures';


beforeEach(() => {
  vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
});

describe('feature flag', () => {
  it('returns empty when flag is disabled', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    const input = { transaction: null as any, context: null as any };
    const result = evaluateRules(input);
    expect(result).toEqual({ candidates: [], decision: undefined });
  });

  it('returns empty when flag is unset', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', '');
    const input = { transaction: null as any, context: null as any };
    const result = evaluateRules(input);
    expect(result).toEqual({ candidates: [], decision: undefined });
  });

  it('processes when flag is enabled', () => {
    const tx = makeTransaction();
    const input = {
      transaction: tx,
      context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    };
    const result = evaluateRules(input);
    expect(result.candidates).toBeDefined();
  });
});

describe('input validation', () => {
  it('throws MissingTransaction when transaction is null', () => {
    expect(() => evaluateRules({ transaction: null as any, context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } })).toThrow(MissingTransaction);
  });

  it('throws MissingContext when context is null', () => {
    const tx = makeTransaction();
    expect(() => evaluateRules({ transaction: tx, context: null as any })).toThrow(MissingContext);
  });

  it('throws MissingContext when availableRules is not an array', () => {
    const tx = makeTransaction();
    expect(() => evaluateRules({ transaction: tx, context: { availableRules: 'not-array' as any, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } })).toThrow(MissingContext);
  });

  it('throws InvalidTransaction when transaction.id is empty', () => {
    const tx = makeTransaction({ id: '' });
    expect(() => evaluateRules({ transaction: tx, context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } })).toThrow(InvalidTransaction);
  });

  it('throws InvalidTransaction when companyId is empty', () => {
    const tx = makeTransaction({ companyId: '' });
    expect(() => evaluateRules({ transaction: tx, context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } } })).toThrow(InvalidTransaction);
  });
});

describe('decision orchestration', () => {
  it('valid input with candidates returns winner decision', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].ruleId).toBe(rule.id);
    expect(result.decision).toBeDefined();
    expect(result.decision!.result).toBe('winner');
  });

  it('condition error propagates', () => {
    const rule = makeRule({ conditions: [makeCondition('description_matches', '[invalid')] });
    const tx = makeTransaction();
    expect(() => evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    })).toThrow(InvalidRegex);
  });

  it('valid input with no candidates returns no_match decision', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 1000)] });
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.decision).toBeDefined();
    expect(result.decision!.result).toBe('no_match');
  });

  it('pipeline to scoring to ranking to decision flow works end to end', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].specificity).toBeGreaterThan(0);
    expect(result.candidates[0].matchQuality).toBeGreaterThan(0);
    expect(result.decision!.result).toBe('winner');
  });

  it('empty conditions filtered by discardInvalidConfiguration', () => {
    const rule = makeRule({
      conditions: [],
      action: { category: 'EXPENSE' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.candidates).toHaveLength(0);
  });

  it('entityResolution not_run with entity_eq condition propagates MissingEntityIdError', () => {
    const rule = makeRule({ conditions: [makeCondition('entity_eq', 'ent-123')] });
    const tx = makeTransaction({ amount: 600 });
    expect(() => evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    })).toThrow(MissingEntityIdError);
  });

  it('entityResolution resolved with entity_eq returns winner decision', () => {
    const rule = makeRule({
      conditions: [makeCondition('entity_eq', 'ent-123')],
      action: { category: 'EXPENSE' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'resolved' as const, entityId: 'ent-123' } },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.decision!.result).toBe('winner');
  });

  it('valid input with ambiguous result returns ambiguous decision', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 500)], action: { category: 'EXPENSE' } }),
      makeRule({ conditions: [makeCondition('amount_gt', 500)], action: { category: 'REVENUE' } }),
    ];
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.decision!.result).toBe('ambiguous');
  });

  it('classification populated from top candidate action when winner', () => {
    const rule = makeRule({
      conditions: [makeCondition('amount_gt', 500)],
      action: { category: 'EXPENSE', glAccountId: '6000' },
    });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.decision!.result).toBe('winner');
    expect(result.decision!.classification).toBeDefined();
    expect(result.decision!.classification!.category).toBe('EXPENSE');
    expect(result.decision!.classification!.glAccountId).toBe('6000');
  });
});
