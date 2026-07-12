import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRules } from '../index';
import { MissingTransaction, MissingContext, InvalidTransaction, InvalidRegex } from '../errors';
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
      context: { availableRules: [], entityContexts: [], historicalMatches: [] },
    };
    const result = evaluateRules(input);
    expect(result.candidates).toBeDefined();
  });
});

describe('input validation', () => {
  it('throws MissingTransaction when transaction is null', () => {
    expect(() => evaluateRules({ transaction: null as any, context: { availableRules: [], entityContexts: [], historicalMatches: [] } })).toThrow(MissingTransaction);
  });

  it('throws MissingContext when context is null', () => {
    const tx = makeTransaction();
    expect(() => evaluateRules({ transaction: tx, context: null as any })).toThrow(MissingContext);
  });

  it('throws MissingContext when availableRules is not an array', () => {
    const tx = makeTransaction();
    expect(() => evaluateRules({ transaction: tx, context: { availableRules: 'not-array' as any, entityContexts: [], historicalMatches: [] } })).toThrow(MissingContext);
  });

  it('throws InvalidTransaction when transaction.id is empty', () => {
    const tx = makeTransaction({ id: '' });
    expect(() => evaluateRules({ transaction: tx, context: { availableRules: [], entityContexts: [], historicalMatches: [] } })).toThrow(InvalidTransaction);
  });

  it('throws InvalidTransaction when companyId is empty', () => {
    const tx = makeTransaction({ companyId: '' });
    expect(() => evaluateRules({ transaction: tx, context: { availableRules: [], entityContexts: [], historicalMatches: [] } })).toThrow(InvalidTransaction);
  });
});

describe('happy path', () => {
  it('returns candidates for valid input with matching rules', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [] },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].ruleId).toBe(rule.id);
  });

  it('returns empty candidates when no rules match', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 1000)] });
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [] },
    });
    expect(result.candidates).toHaveLength(0);
  });

  it('decision is undefined in Sprint 1', () => {
    const result = evaluateRules({
      transaction: makeTransaction(),
      context: { availableRules: [], entityContexts: [], historicalMatches: [] },
    });
    expect(result.decision).toBeUndefined();
  });
});

describe('error propagation', () => {
  it('propagates ConditionEvalError from pipeline', () => {
    const rule = makeRule({ conditions: [makeCondition('description_matches', '[invalid')] });
    const tx = makeTransaction();
    expect(() => evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [] },
    })).toThrow(InvalidRegex);
  });
});
