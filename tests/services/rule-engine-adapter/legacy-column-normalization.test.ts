import { describe, it, expect } from 'vitest';
import { runRuleEngineV2Shadow } from '@/lib/services/rule-engine-adapter';
import type { ParsedTransaction, PrismaBankRule } from '@/lib/services/rule-engine-adapter';
import type { EntityResolution } from '@/lib/rule-engine/types';

function makeTxn(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    id: 'txn-wild',
    date: new Date('2026-07-14'),
    description: 'Netflix subscription',
    amount: -1500,
    bankAccountId: 'acct-001',
    ...overrides,
  };
}

function makeRule(overrides: Partial<PrismaBankRule> = {}): PrismaBankRule {
  return {
    id: 'rule-legacy',
    companyId: 'company-1',
    priority: 10,
    conditions: null,
    glAccountId: 'gl-001',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    ...overrides,
  };
}

const ER: EntityResolution = { status: 'not_run' };
const COMPANY = 'company-1';

function outcomeOf(result: { outcome: 'matched' } | { outcome: 'pending'; errorCode?: string }) {
  return result.outcome === 'matched'
    ? { outcome: 'matched' as const, errorCode: undefined }
    : { outcome: 'pending' as const, errorCode: result.errorCode };
}

describe('BRE-011 Decision #2 — legacy-column normalization (conditions-first, fallback, fail closed)', () => {
  it('conditions-first: valid conditions win, legacy columns ignored', () => {
    const rule = makeRule({
      conditions: [{ type: 'description_contains', value: 'netflix' }],
      conditionType: 'contains',
      conditionValue: 'should-be-ignored',
    });

    const matched = outcomeOf(
      runRuleEngineV2Shadow(makeTxn(), [rule], ER, COMPANY),
    );
    expect(matched).toEqual({ outcome: 'matched', errorCode: undefined });

    const ignored = outcomeOf(
      runRuleEngineV2Shadow(makeTxn({ description: 'should-be-ignored' }), [rule], ER, COMPANY),
    );
    expect(ignored.outcome).toBe('pending');
    expect(ignored.errorCode).toBeUndefined();
  });

  it('legacy fallback: equals / "*" normalizes to description_eq("*") and matches via the wildcard contract', () => {
    const rule = makeRule({
      conditions: null,
      conditionType: 'equals',
      conditionValue: '*',
    });

    const result = outcomeOf(runRuleEngineV2Shadow(makeTxn(), [rule], ER, COMPANY));
    expect(result).toEqual({ outcome: 'matched', errorCode: undefined });
  });

  it('legacy fallback (general, not just "*"): contains normalizes to canonical condition', () => {
    const rule = makeRule({
      conditions: null,
      conditionType: 'contains',
      conditionValue: 'netflix',
    });

    const result = outcomeOf(runRuleEngineV2Shadow(makeTxn(), [rule], ER, COMPANY));
    expect(result).toEqual({ outcome: 'matched', errorCode: undefined });
  });

  it('fail closed: no usable conditions and no legacy columns yields conditions_normalization_failed', () => {
    const rule = makeRule({ conditions: null, conditionType: null, conditionValue: null });

    const result = outcomeOf(runRuleEngineV2Shadow(makeTxn(), [rule], ER, COMPANY));
    expect(result).toEqual({ outcome: 'pending', errorCode: 'conditions_normalization_failed' });
  });

  it('null-not-preserved: a rule whose stored conditions are null still evaluates via the canonical model', () => {
    const rule = makeRule({
      conditions: null,
      conditionType: 'equals',
      conditionValue: 'Netflix subscription',
    });

    const matched = outcomeOf(runRuleEngineV2Shadow(makeTxn(), [rule], ER, COMPANY));
    expect(matched).toEqual({ outcome: 'matched', errorCode: undefined });

    const missed = outcomeOf(
      runRuleEngineV2Shadow(makeTxn({ description: 'Something else' }), [rule], ER, COMPANY),
    );
    expect(missed.outcome).toBe('pending');
    expect(missed.errorCode).toBeUndefined();
  });
});
