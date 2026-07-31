import { describe, it, expect } from 'vitest';
import { transactionMatchesRule } from '@/lib/services/rule-matching-engine';
import {
  evaluateTransactionAgainstRules,
  type RulePrecedenceRule,
  type RulePrecedenceTransaction,
} from '@/lib/services/rule-precedence-engine';
import { runShadowComparison } from '@/lib/services/rule-precedence-shadow';
import { runRuleEngineV2Shadow } from '@/lib/services/rule-engine-adapter';
import type { ParsedTransaction, PrismaBankRule } from '@/lib/services/rule-engine-adapter';
import type { EntityResolution } from '@/lib/rule-engine/types';
import {
  buildDivergenceEvent,
  type V2EngineResult,
  type PrecedenceEngineResult,
} from '@/lib/rule-engine/events';

const DESCRIPTION = 'APPLE.COM BILLING';
const CONDITION_VALUE = 'APPLE';
const COMPANY_ID = 'company-1';

function makeTxn(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    id: 'tx-1',
    date: new Date('2026-07-16T12:00:00Z'),
    description: DESCRIPTION,
    amount: -150,
    bankAccountId: 'acc-1',
    ...overrides,
  };
}

function makePrismaRule(overrides: Partial<PrismaBankRule> = {}): PrismaBankRule {
  return {
    id: 'rule-1',
    companyId: COMPANY_ID,
    priority: 10,
    conditions: [{ field: 'description', operator: 'contains', value: CONDITION_VALUE }],
    glAccountId: 'gl-001',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    transactionDirection: 'any',
    ...overrides,
  };
}

function makePrecedenceRule(overrides: Partial<RulePrecedenceRule> = {}): RulePrecedenceRule {
  return {
    id: 'rule-1',
    conditions: [{ field: 'description', operator: 'contains', value: CONDITION_VALUE }],
    transactionDirection: 'any',
    priority: 10,
    glAccountId: 'gl-001',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    ...overrides,
  };
}

const notRunResolution: EntityResolution = { status: 'not_run' };

function toV2Result(match: ReturnType<typeof runRuleEngineV2Shadow>): V2EngineResult {
  if (match.outcome === 'matched') {
    return { outcome: 'matched', matchedRuleId: match.matchedRuleId };
  }
  if (match.outcome === 'pending' && match.errorCode) {
    return { outcome: 'pending', errorCode: match.errorCode };
  }
  return { outcome: 'pending' };
}

function precedenceResultFor(txn: ParsedTransaction, rule: RulePrecedenceRule): PrecedenceEngineResult {
  const output = evaluateTransactionAgainstRules(
    { id: txn.id, date: txn.date, description: txn.description, amount: txn.amount },
    [rule],
  );
  return { reason: output.reason, winnerRuleId: output.winner?.ruleId ?? null, ambiguous: output.ambiguous };
}

describe('BRE-007 TEST-7: V2 shadow divergence eliminated by direction parity', () => {
  it('credit rule + debit tx: V2 pending, Precedence NO_MATCH, no divergence event', () => {
    const txn = makeTxn({ amount: -150 });
    const v2Result = toV2Result(
      runRuleEngineV2Shadow(txn, [makePrismaRule({ transactionDirection: 'credit' })], notRunResolution, COMPANY_ID),
    );
    const precedenceResult = precedenceResultFor(txn, makePrecedenceRule({ transactionDirection: 'credit' }));

    expect(v2Result.outcome).toBe('pending');
    expect(precedenceResult.reason).toBe('NO_MATCH');
    expect(buildDivergenceEvent(txn.id, COMPANY_ID, v2Result, precedenceResult)).toBeNull();
  });

  it('debit rule + credit tx: V2 pending, Precedence NO_MATCH, no divergence event', () => {
    const txn = makeTxn({ amount: 150 });
    const v2Result = toV2Result(
      runRuleEngineV2Shadow(txn, [makePrismaRule({ transactionDirection: 'debit' })], notRunResolution, COMPANY_ID),
    );
    const precedenceResult = precedenceResultFor(txn, makePrecedenceRule({ transactionDirection: 'debit' }));

    expect(v2Result.outcome).toBe('pending');
    expect(precedenceResult.reason).toBe('NO_MATCH');
    expect(buildDivergenceEvent(txn.id, COMPANY_ID, v2Result, precedenceResult)).toBeNull();
  });

  it('credit rule + credit tx: V2 matched, Precedence WINNER same rule, no divergence event', () => {
    const txn = makeTxn({ amount: 150 });
    const v2Result = toV2Result(
      runRuleEngineV2Shadow(txn, [makePrismaRule({ transactionDirection: 'credit' })], notRunResolution, COMPANY_ID),
    );
    const precedenceResult = precedenceResultFor(txn, makePrecedenceRule({ transactionDirection: 'credit' }));

    expect(v2Result).toEqual({ outcome: 'matched', matchedRuleId: 'rule-1' });
    expect(precedenceResult).toEqual({ reason: 'WINNER', winnerRuleId: 'rule-1', ambiguous: false });
    expect(buildDivergenceEvent(txn.id, COMPANY_ID, v2Result, precedenceResult)).toBeNull();
  });

  it('control: the pre-BRE-007 V2 signal (credit rule matched a debit tx) DID classify as divergence', () => {
    const v2Result: V2EngineResult = { outcome: 'matched', matchedRuleId: 'rule-1' };
    const precedenceResult: PrecedenceEngineResult = { reason: 'NO_MATCH', winnerRuleId: null, ambiguous: false };
    const event = buildDivergenceEvent('tx-1', COMPANY_ID, v2Result, precedenceResult);
    expect(event).not.toBeNull();
    expect(event!.divergenceType).toBe('V2_MATCH_PRECEDENCE_NO_MATCH');
  });
});

describe('BRE-007 TEST-7: productive shadow (Legacy vs Precedence) on direction-only scenarios', () => {
  it('credit rule + credit tx → SAME_WINNER (both engines pick rule-1)', () => {
    const txn = makeTxn({ amount: 150 });
    const productiveMatches = transactionMatchesRule(
      { description: txn.description, amount: txn.amount },
      { transactionDirection: 'credit', conditions: [{ field: 'description', operator: 'contains', value: CONDITION_VALUE }] },
    );
    expect(productiveMatches).toBe(true);

    const result = runShadowComparison(
      { id: txn.id, date: txn.date, description: txn.description, amount: txn.amount },
      [makePrecedenceRule({ transactionDirection: 'credit' })],
      'rule-1',
      { companyId: COMPANY_ID, transactionId: txn.id },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.comparison.comparison).toBe('SAME_WINNER');
    }
  });

  it('credit rule + debit tx → BOTH_NO_MATCH (no divergence, both engines exclude)', () => {
    const txn = makeTxn({ amount: -150 });
    const productiveMatches = transactionMatchesRule(
      { description: txn.description, amount: txn.amount },
      { transactionDirection: 'credit', conditions: [{ field: 'description', operator: 'contains', value: CONDITION_VALUE }] },
    );
    expect(productiveMatches).toBe(false);

    const result = runShadowComparison(
      { id: txn.id, date: txn.date, description: txn.description, amount: txn.amount },
      [makePrecedenceRule({ transactionDirection: 'credit' })],
      null,
      { companyId: COMPANY_ID, transactionId: txn.id },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.comparison.comparison).toBe('BOTH_NO_MATCH');
    }
  });
});
