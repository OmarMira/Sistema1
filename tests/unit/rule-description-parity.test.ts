import { describe, it, expect } from 'vitest';
import { transactionMatchesRule } from '@/lib/services/rule-matching-engine';
import {
  evaluateTransactionAgainstRules,
  type RulePrecedenceRule,
  type RulePrecedenceTransaction,
} from '@/lib/services/rule-precedence-engine';
import { evaluateRulesPure } from '@/lib/rule-engine';
import type { BankRule, Transaction, RuleInput } from '@/lib/rule-engine/types';

const DESCRIPTION_AMOUNT = 100;

type DescriptionOperator = 'contains' | 'equals' | 'starts_with' | 'ends_with';

const OP_TO_V2_TYPE: Record<DescriptionOperator, string> = {
  contains: 'description_contains',
  equals: 'description_eq',
  starts_with: 'description_starts_with',
  ends_with: 'description_ends_with',
};

// ── Legacy (productive, normalizes) ─────────────────────────────────────

function legacyEligible(description: string, op: DescriptionOperator, value: string | number): boolean {
  return transactionMatchesRule(
    { description, amount: DESCRIPTION_AMOUNT },
    {
      transactionDirection: undefined,
      conditions: [{ field: 'description', operator: op, value }],
    },
  );
}

// ── Precedence (canonical productive, normalizes) ───────────────────────

function precedenceEligible(description: string, op: DescriptionOperator, value: string | number): boolean {
  const rule: RulePrecedenceRule = {
    id: 'rule-1',
    transactionDirection: null,
    conditions: [{ field: 'description', operator: op, value }],
    priority: 10,
    glAccountId: 'gl-1',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
  const tx: RulePrecedenceTransaction = {
    id: 'tx-1',
    date: new Date('2026-07-31T12:00:00Z'),
    description,
    amount: DESCRIPTION_AMOUNT,
  };
  const output = evaluateTransactionAgainstRules(tx, [rule]);
  return output.candidates.some((c) => c.ruleId === rule.id);
}

// ── V2 (canonical rule engine) ──────────────────────────────────────────

function v2Eligible(description: string, op: DescriptionOperator, value: string | number): boolean {
  const rule: BankRule = {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditions: [{ type: OP_TO_V2_TYPE[op] as never, value }],
    action: { glAccountId: 'gl-1' },
    isActive: true,
    lifecycleStatus: 'active',
  };
  const input: RuleInput = {
    transaction: {
      id: 'tx-1',
      date: new Date('2026-07-31T12:00:00Z'),
      description,
      amount: DESCRIPTION_AMOUNT,
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

// ── Regex (description_matches: Precedence and V2, raw) ─────────────────

function precedenceRegexEligible(description: string, pattern: string): boolean {
  const rule: RulePrecedenceRule = {
    id: 'rule-1',
    transactionDirection: null,
    conditions: [{ type: 'description_matches', value: pattern }],
    priority: 10,
    glAccountId: 'gl-1',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
  const tx: RulePrecedenceTransaction = {
    id: 'tx-1',
    date: new Date('2026-07-31T12:00:00Z'),
    description,
    amount: DESCRIPTION_AMOUNT,
  };
  const output = evaluateTransactionAgainstRules(tx, [rule]);
  return output.candidates.some((c) => c.ruleId === rule.id);
}

function v2RegexEligible(description: string, pattern: string): boolean {
  const rule: BankRule = {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditions: [{ type: 'description_matches' as never, value: pattern }],
    action: { glAccountId: 'gl-1' },
    isActive: true,
    lifecycleStatus: 'active',
  };
  const input: RuleInput = {
    transaction: {
      id: 'tx-1',
      date: new Date('2026-07-31T12:00:00Z'),
      description,
      amount: DESCRIPTION_AMOUNT,
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

const MATRIX: Array<{ description: string; op: DescriptionOperator; value: string | number; expected: boolean }> = [
  { description: 'OMAR MIRA', op: 'contains', value: 'omar mira', expected: true },
  { description: 'Netflix', op: 'equals', value: 'NETFLIX', expected: true },
  { description: 'OMA   R MIRA', op: 'starts_with', value: 'oma r', expected: true },
  { description: 'PAYMENT OMA  R', op: 'ends_with', value: 'oma r', expected: true },
  { description: '  omar mira  ', op: 'contains', value: 'omar mira', expected: true },
  { description: 'OMA  R MIRA', op: 'contains', value: 'OMA R MIRA', expected: true },
  { description: 'anything', op: 'contains', value: '', expected: false },
  { description: 'anything', op: 'equals', value: '', expected: false },
  { description: 'anything', op: 'starts_with', value: '', expected: false },
  { description: 'anything', op: 'ends_with', value: '', expected: false },
  { description: 'anything', op: 'contains', value: '   ', expected: false },
  { description: 'café', op: 'contains', value: 'cafe', expected: false },
  { description: 'É MIRA', op: 'contains', value: 'E\u0301 MIRA', expected: false },
  { description: 'Invoice 123', op: 'contains', value: 123, expected: true },
];

describe('BRE-008: description normalization parity matrix — Legacy = Precedence = V2', () => {
  for (const { description, op, value, expected } of MATRIX) {
    it(`op=${op} value=${JSON.stringify(value)} desc=${JSON.stringify(description)} → eligible=${expected} in all engines`, () => {
      const legacy = legacyEligible(description, op, value);
      const precedence = precedenceEligible(description, op, value);
      const v2 = v2Eligible(description, op, value);
      expect({ legacy, precedence, v2 }).toEqual({ legacy: expected, precedence: expected, v2: expected });
    });
  }

  it('probes each engine independently to keep the matrix honest', () => {
    expect(legacyEligible('OMAR MIRA', 'contains', 'omar mira')).toBe(true);
    expect(precedenceEligible('OMAR MIRA', 'contains', 'omar mira')).toBe(true);
    expect(v2Eligible('OMAR MIRA', 'contains', 'omar mira')).toBe(true);
    expect(legacyEligible('anything', 'contains', '')).toBe(false);
    expect(precedenceEligible('anything', 'contains', '   ')).toBe(false);
    expect(v2Eligible('anything', 'contains', '')).toBe(false);
  });
});

describe('BRE-008: regex (description_matches) stays raw in Precedence and V2', () => {
  it('case-sensitive pattern matches only its exact case in both engines', () => {
    const desc = 'INVOICE #123';
    expect(precedenceRegexEligible(desc, 'INVOICE \\#\\d+')).toBe(true);
    expect(precedenceRegexEligible(desc, 'invoice \\#\\d+')).toBe(false);
    expect(v2RegexEligible(desc, 'INVOICE \\#\\d+')).toBe(true);
    expect(v2RegexEligible(desc, 'invoice \\#\\d+')).toBe(false);
  });
});
