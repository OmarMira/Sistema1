import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger';
import {
  toRulePrecedenceRule,
  compareRuleDecisions,
  isRulePrecedenceShadowEnabled,
  runShadowComparison,
} from '@/lib/services/rule-precedence-shadow';
import type { RulePrecedenceRule, RulePrecedenceTransaction } from '@/lib/services/rule-precedence-engine';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Helpers

const DEFAULT_DATE = new Date('2026-07-16T12:00:00Z');

function rule(overrides: Partial<RulePrecedenceRule> & { id: string }): RulePrecedenceRule {
  return {
    conditions: undefined,
    conditionType: undefined,
    conditionValue: undefined,
    transactionDirection: null,
    priority: 10,
    glAccountId: null,
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    ...overrides,
  };
}

function tx(overrides: Partial<RulePrecedenceTransaction> = {}): RulePrecedenceTransaction {
  return { id: 'tx-1', date: DEFAULT_DATE, description: 'APPLE.COM BILLING', amount: 150, ...overrides };
}

// Adapter

describe('toRulePrecedenceRule', () => {
  it('preserves all fields from source', () => {
    const source = {
      id: 'rule-1',
      conditions: [{ field: 'description', operator: 'contains', value: 'APPLE' }],
      conditionType: 'contains',
      conditionValue: 'APPLE',
      transactionDirection: 'debit',
      priority: 5,
      glAccountId: 'gl-1',
      debitGlAccountId: null,
      creditGlAccountId: 'gl-2',
      isActive: true,
    };

    const result = toRulePrecedenceRule(source);

    expect(result.id).toBe('rule-1');
    expect(result.conditions).toEqual([{ field: 'description', operator: 'contains', value: 'APPLE' }]);
    expect(result.conditionType).toBe('contains');
    expect(result.conditionValue).toBe('APPLE');
    expect(result.transactionDirection).toBe('debit');
    expect(result.priority).toBe(5);
    expect(result.glAccountId).toBe('gl-1');
    expect(result.debitGlAccountId).toBeNull();
    expect(result.creditGlAccountId).toBe('gl-2');
    expect(result.isActive).toBe(true);
  });

  it('does not mutate the source object', () => {
    const source = {
      id: 'rule-1',
      conditions: [{ field: 'description', operator: 'contains', value: 'APPLE' }],
      conditionType: 'contains',
      conditionValue: 'APPLE',
      transactionDirection: null,
      priority: 10,
      glAccountId: null,
      debitGlAccountId: null,
      creditGlAccountId: null,
      isActive: true,
    };

    const original = { ...source };
    toRulePrecedenceRule(source);

    expect(source).toEqual(original);
  });
});

// Pure comparison

describe('compareRuleDecisions', () => {
  it('SAME_WINNER — motor productivo y canónico coinciden', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, 'r1');

    expect(result.comparison).toBe('SAME_WINNER');
    expect(result.productiveWinnerId).toBe('r1');
    expect(result.canonicalWinnerId).toBe('r1');
    expect(result.canonicalAmbiguous).toBe(false);
    expect(result.canonicalReason).toBe('WINNER');
  });

  it('BOTH_NO_MATCH — ningún motor encuentra match', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'GOOGLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, null);

    expect(result.comparison).toBe('BOTH_NO_MATCH');
    expect(result.productiveWinnerId).toBeNull();
    expect(result.canonicalWinnerId).toBeNull();
    expect(result.canonicalReason).toBe('NO_MATCH');
  });

  it('PRODUCTIVE_MATCH_CANONICAL_NO_MATCH — productivo gana, canónico no', () => {
    const rules: RulePrecedenceRule[] = [];

    const result = compareRuleDecisions(tx(), rules, 'r1');

    expect(result.comparison).toBe('PRODUCTIVE_MATCH_CANONICAL_NO_MATCH');
    expect(result.productiveWinnerId).toBe('r1');
    expect(result.canonicalWinnerId).toBeNull();
    expect(result.canonicalReason).toBe('NO_MATCH');
  });

  it('PRODUCTIVE_NO_MATCH_CANONICAL_MATCH — canónico gana, productivo no', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, null);

    expect(result.comparison).toBe('PRODUCTIVE_NO_MATCH_CANONICAL_MATCH');
    expect(result.productiveWinnerId).toBeNull();
    expect(result.canonicalWinnerId).toBe('r1');
    expect(result.canonicalReason).toBe('WINNER');
  });

  it('DIFFERENT_WINNER — ambos ganan, reglas distintas', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, 'legacy-rule');

    expect(result.comparison).toBe('DIFFERENT_WINNER');
    expect(result.productiveWinnerId).toBe('legacy-rule');
    expect(result.canonicalWinnerId).toBe('r1');
    expect(result.canonicalReason).toBe('WINNER');
  });

  it('CANONICAL_AMBIGUOUS — canónico empata dos reglas', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'equals', conditionValue: 'APPLE.COM BILLING', priority: 10 }),
      rule({ id: 'r2', conditionType: 'equals', conditionValue: 'APPLE.COM BILLING', priority: 10 }),
    ];

    const result = compareRuleDecisions(tx(), rules, null);

    expect(result.comparison).toBe('CANONICAL_AMBIGUOUS');
    expect(result.canonicalWinnerId).toBeNull();
    expect(result.canonicalAmbiguous).toBe(true);
    expect(result.canonicalReason).toBe('AMBIGUOUS');
  });
});

// Flag

describe('isRulePrecedenceShadowEnabled', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('returns true when env var is exactly "true"', () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';
    expect(isRulePrecedenceShadowEnabled()).toBe(true);
  });

  it('returns false when env var is missing', () => {
    expect(isRulePrecedenceShadowEnabled()).toBe(false);
  });

  it('returns false when env var is "false"', () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'false';
    expect(isRulePrecedenceShadowEnabled()).toBe(false);
  });

  it('returns false when env var is any other value', () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = '1';
    expect(isRulePrecedenceShadowEnabled()).toBe(false);
  });
});

// Shadow runner

describe('runShadowComparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when there is a divergence', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    expect(() =>
      runShadowComparison(tx(), rules, 'legacy-rule', { companyId: 'c1', transactionId: 'tx-1' }),
    ).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      '[RULE SHADOW DIVERGENCE]',
      expect.objectContaining({ comparison: 'DIFFERENT_WINNER', companyId: 'c1' }),
    );
  });

  it('catches internal error without propagating', () => {
    const badRule = rule({ id: 'r1' });
    Object.defineProperty(badRule, 'isActive', {
      get() { throw new Error('forced shadow failure'); },
    });

    runShadowComparison(
      tx(),
      [badRule],
      null,
      { companyId: 'c1', transactionId: 'tx-1' },
    );

    expect(logger.error).toHaveBeenCalledWith(
      '[RULE SHADOW ERROR]',
      expect.objectContaining({
        companyId: 'c1',
        transactionId: 'tx-1',
      }),
    );
  });

  it('does not modify matchedRuleId or glAccountId (shadow runner returns void)', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = runShadowComparison(tx(), rules, null, { companyId: 'c1', transactionId: 'tx-1' });
    expect(result).toBeUndefined();
  });
});




