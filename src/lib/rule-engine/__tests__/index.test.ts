import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRules } from '../index';
import { MissingTransaction, MissingContext, InvalidTransaction, InvalidRegex, MissingEntityIdError } from '../errors';
import { makeRule, makeTransaction, makeCondition } from './fixtures';
import type { TraceEvent, DecisionTrace, AuditRecord } from '../types';
import { RULE_ENGINE_VERSION } from '../version';

beforeEach(() => {
  vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
});

describe('feature flag', () => {
  it('returns empty when flag is disabled', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    const input = { transaction: null as any, context: null as any };
    const result = evaluateRules(input);
    expect(result).toEqual({ output: { candidates: [], decision: undefined } });
  });

  it('returns empty when flag is unset', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', '');
    const input = { transaction: null as any, context: null as any };
    const result = evaluateRules(input);
    expect(result).toEqual({ output: { candidates: [], decision: undefined } });
  });

  it('processes when flag is enabled', () => {
    const tx = makeTransaction();
    const input = {
      transaction: tx,
      context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    };
    const result = evaluateRules(input);
    expect(result.output.candidates).toBeDefined();
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
    expect(result.output.candidates).toHaveLength(1);
    expect(result.output.candidates[0].ruleId).toBe(rule.id);
    expect(result.output.decision).toBeDefined();
    expect(result.output.decision!.result).toBe('winner');
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
    expect(result.output.candidates).toHaveLength(0);
    expect(result.output.decision).toBeDefined();
    expect(result.output.decision!.result).toBe('no_match');
  });

  it('pipeline to scoring to ranking to decision flow works end to end', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.output.candidates).toHaveLength(1);
    expect(result.output.candidates[0].specificity).toBeGreaterThan(0);
    expect(result.output.candidates[0].matchQuality).toBeGreaterThan(0);
    expect(result.output.decision!.result).toBe('winner');
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
    expect(result.output.candidates).toHaveLength(0);
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
    expect(result.output.candidates).toHaveLength(1);
    expect(result.output.decision!.result).toBe('winner');
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
    expect(result.output.candidates).toHaveLength(2);
    expect(result.output.decision!.result).toBe('ambiguous');
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
    expect(result.output.decision!.result).toBe('winner');
    expect(result.output.decision!.classification).toBeDefined();
    expect(result.output.decision!.classification!.category).toBe('EXPENSE');
    expect(result.output.decision!.classification!.glAccountId).toBe('6000');
  });
});

describe('trace and audit integration', () => {
  it('flag OFF omits trace and audit keys', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    const input = { transaction: null as any, context: null as any };
    const result = evaluateRules(input);
    expect('trace' in result).toBe(false);
    expect('audit' in result).toBe(false);
    expect(result.output).toEqual({ candidates: [], decision: undefined });
  });

  it('full pipeline produces trace with terminal complete event', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.trace).toBeDefined();
    expect(result.audit).toBeDefined();
    expect(result.trace!.engineVersion).toBe(RULE_ENGINE_VERSION);
    expect(result.trace!.events.length).toBeGreaterThan(0);
    const lastEvent = result.trace!.events[result.trace!.events.length - 1];
    expect(lastEvent).toEqual({ stage: 'execution', event: 'complete' });
  });

  it('audit record has correct fields on success', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)], action: { category: 'EXPENSE' } });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.audit!.engineVersion).toBe(RULE_ENGINE_VERSION);
    expect(result.audit!.transactionId).toBe(tx.id);
    expect(result.audit!.companyId).toBe(tx.companyId);
    expect(result.audit!.result).toBe('winner');
    expect(result.audit!.winnerRuleId).toBe(rule.id);
    expect(result.audit!.candidateCount).toBe(1);
  });

  it('error path — typed error has partial trace, no audit', () => {
    const rule = makeRule({ conditions: [makeCondition('description_matches', '[invalid')] });
    const tx = makeTransaction();
    try {
      evaluateRules({
        transaction: tx,
        context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.trace).toBeDefined();
      expect(err.trace.events.length).toBeGreaterThan(0);
      const lastEvent = err.trace.events[err.trace.events.length - 1];
      expect(lastEvent.stage).toBe('execution');
      expect(lastEvent.event).toBe('error');
      expect(lastEvent.errorCode).toBe('ERR_INVALID_REGEX');
      expect(err.audit).toBeUndefined();
    }
  });

  it('no-match result still produces audit with result=no_match', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 1000)] });
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.audit!.result).toBe('no_match');
    expect(result.audit!.winnerRuleId).toBeUndefined();
    expect(result.audit!.candidateCount).toBe(0);
  });
});
