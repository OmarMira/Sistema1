import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuleInput } from '@/lib/rule-engine/types';

const mockPersist = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/lib/rule-engine/audit', () => ({
  persistRuleExecutionAudit: mockPersist.fn,
}));

import { evaluateRules, evaluateRulesPure } from '@/lib/rule-engine';

const V2_FLAG_KEY = 'RULE_ENGINE_V2_ENABLED';

function makeInput(): RuleInput {
  return {
    transaction: {
      id: 'txn-1',
      date: new Date('2026-07-14'),
      description: 'Test transaction',
      amount: -500,
      bankAccountId: 'acct-001',
      companyId: 'company-1',
    },
    context: {
      availableRules: [],
      entityContexts: [],
      historicalMatches: [],
      entityResolution: { status: 'not_run' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPersist.fn.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env[V2_FLAG_KEY];
});

describe('evaluateRules — persistence', () => {
  it('persists the audit exactly once by default', () => {
    process.env[V2_FLAG_KEY] = '1';
    const execution = evaluateRules(makeInput());

    expect(mockPersist.fn).toHaveBeenCalledTimes(1);
    expect(execution.audit).toBeDefined();
    expect(execution.output.decision).toBeDefined();
  });

  it('persists when opts are omitted entirely', () => {
    process.env[V2_FLAG_KEY] = '1';
    evaluateRules(makeInput(), undefined);

    expect(mockPersist.fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT persist when persistAudit is false', () => {
    process.env[V2_FLAG_KEY] = '1';
    const execution = evaluateRules(makeInput(), { persistAudit: false });

    expect(mockPersist.fn).not.toHaveBeenCalled();
    expect(execution.output.decision).toBeDefined();
  });

  it('persistAudit false returns the same result as the default path', () => {
    process.env[V2_FLAG_KEY] = '1';
    const withAudit = evaluateRules(makeInput());
    const withoutAudit = evaluateRules(makeInput(), { persistAudit: false });

    expect(withoutAudit.output).toEqual(withAudit.output);
    expect(withoutAudit.audit).toEqual(withAudit.audit);
  });

  it('does not persist when the V2 flag is disabled (returns empty result)', () => {
    const execution = evaluateRules(makeInput());

    expect(mockPersist.fn).not.toHaveBeenCalled();
    expect(execution.output).toEqual({ candidates: [], decision: undefined });
  });
});

describe('evaluateRulesPure — no persistence', () => {
  it('never calls persistRuleExecutionAudit', () => {
    const execution = evaluateRulesPure(makeInput());

    expect(mockPersist.fn).not.toHaveBeenCalled();
    expect(execution.output.decision).toBeDefined();
    expect(execution.audit).toBeDefined();
  });

  it('runs the pipeline regardless of the V2 flag', () => {
    const execution = evaluateRulesPure(makeInput());

    expect(execution.output.decision).toBeDefined();
    expect(execution.trace).toBeDefined();
  });

  it('produces the same output as evaluateRules with the flag enabled', () => {
    process.env[V2_FLAG_KEY] = '1';
    const pure = evaluateRulesPure(makeInput());
    const productive = evaluateRules(makeInput());

    expect(pure.output).toEqual(productive.output);
    expect(pure.audit).toEqual(productive.audit);
  });
});
