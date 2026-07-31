import { describe, it, expect } from 'vitest';
import { transactionMatchesRule } from '@/lib/services/rule-matching-engine';
import {
  evaluateTransactionAgainstRules,
  type RulePrecedenceRule,
  type RulePrecedenceTransaction,
} from '@/lib/services/rule-precedence-engine';
import { evaluateRulesPure } from '@/lib/rule-engine';
import type { BankRule, Transaction, RuleInput } from '@/lib/rule-engine/types';

const DESCRIPTION = 'APPLE.COM BILLING';
const CONDITION_VALUE = 'APPLE';

type Direction = 'debit' | 'credit' | 'any' | null;

// ── Legacy (productive, signed amount) ──────────────────────────────────

function legacyEligible(direction: Direction, amount: number): boolean {
  return transactionMatchesRule(
    { description: DESCRIPTION, amount },
    {
      transactionDirection: direction ?? undefined,
      conditions: [{ field: 'description', operator: 'contains', value: CONDITION_VALUE }],
    },
  );
}

// ── Precedence (canonical productive, signed amount) ────────────────────

function precedenceEligible(direction: Direction, amount: number): boolean {
  const rule: RulePrecedenceRule = {
    id: 'rule-1',
    transactionDirection: direction,
    conditions: [{ field: 'description', operator: 'contains', value: CONDITION_VALUE }],
    priority: 10,
    glAccountId: 'gl-1',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
  const tx: RulePrecedenceTransaction = {
    id: 'tx-1',
    date: new Date('2026-07-16T12:00:00Z'),
    description: DESCRIPTION,
    amount,
  };
  const output = evaluateTransactionAgainstRules(tx, [rule]);
  return output.candidates.some((c) => c.ruleId === rule.id);
}

// ── V2 (canonical rule engine, signed amount) ───────────────────────────

function v2Eligible(direction: Direction, amount: number): boolean {
  const rule: BankRule = {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditions: [{ type: 'description_contains', value: CONDITION_VALUE }],
    action: { glAccountId: 'gl-1' },
    isActive: true,
    lifecycleStatus: 'active',
    ...(direction !== null ? { direction } : {}),
  };
  const input: RuleInput = {
    transaction: {
      id: 'tx-1',
      date: new Date('2026-07-16T12:00:00Z'),
      description: DESCRIPTION,
      amount,
      bankAccountId: 'acc-1',
      companyId: 'company-1',
    },
    context: {
      availableRules: [rule],
      entityContexts: [],
      historicalMatches: [],
      entityResolution: { status: 'not_run' },
    },
  };
  const result = evaluateRulesPure(input);
  return result.output.candidates.some((c) => c.ruleId === rule.id);
}

// ── Parity matrix ───────────────────────────────────────────────────────

const MATRIX: Array<{ direction: Direction; amount: number; expected: boolean }> = [
  { direction: 'debit', amount: -150, expected: true },
  { direction: 'debit', amount: 150, expected: false },
  { direction: 'debit', amount: 0, expected: false },
  { direction: 'credit', amount: 150, expected: true },
  { direction: 'credit', amount: -150, expected: false },
  { direction: 'credit', amount: 0, expected: true },
  { direction: 'any', amount: 150, expected: true },
  { direction: 'any', amount: -150, expected: true },
  { direction: null, amount: 150, expected: true },
  { direction: null, amount: -150, expected: true },
];

describe('BRE-007 TEST-6: direction parity matrix — Legacy = Precedence = V2', () => {
  for (const { direction, amount, expected } of MATRIX) {
    const label = direction === null ? 'missing' : direction;
    it(`rule ${label} + amount ${amount} → eligible=${expected} in all engines`, () => {
      const legacy = legacyEligible(direction, amount);
      const precedence = precedenceEligible(direction, amount);
      const v2 = v2Eligible(direction, amount);
      expect({ legacy, precedence, v2 }).toEqual({ legacy: expected, precedence: expected, v2: expected });
    });
  }

  it('probes each engine independently to keep the matrix honest', () => {
    expect(legacyEligible('credit', 150)).toBe(true);
    expect(legacyEligible('credit', -150)).toBe(false);
    expect(precedenceEligible('debit', -150)).toBe(true);
    expect(precedenceEligible('debit', 150)).toBe(false);
    expect(v2Eligible('any', -150)).toBe(true);
    expect(v2Eligible('any', 150)).toBe(true);
  });
});
