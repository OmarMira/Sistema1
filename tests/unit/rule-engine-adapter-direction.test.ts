import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EntityResolution } from '@/lib/rule-engine/types'

const mockEvaluateRules = vi.fn()
const mockEvaluateRulesPure = vi.fn()

vi.mock('@/lib/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
  evaluateRulesPure: (...args: unknown[]) => mockEvaluateRulesPure(...args),
}))

import { runRuleEngineV2Shadow } from '@/lib/services/rule-engine-adapter'
import type { ParsedTransaction, PrismaBankRule } from '@/lib/services/rule-engine-adapter'
import type { BankRule } from '@/lib/rule-engine/types'

function makeTxn(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    id: 'txn-1',
    date: new Date('2026-07-14'),
    description: 'Test transaction',
    amount: -500,
    bankAccountId: 'acct-001',
    ...overrides,
  }
}

function makeRule(overrides: Partial<PrismaBankRule> = {}): PrismaBankRule {
  return {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditions: [{ field: 'description', operator: 'contains', value: 'test' }],
    glAccountId: 'gl-001',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    transactionDirection: 'any',
    ...overrides,
  }
}

const defaultEntityResolution: EntityResolution = { status: 'not_run' }

beforeEach(() => {
  vi.clearAllMocks()
})

function directionMappedTo(rule: PrismaBankRule): BankRule['direction'] {
  mockEvaluateRulesPure.mockReturnValueOnce({
    output: { candidates: [], decision: { type: 'rule', result: 'no_match', candidateList: [], explanation: '' } },
  })
  runRuleEngineV2Shadow(makeTxn(), [rule], defaultEntityResolution, 'company-1')
  const callArg = mockEvaluateRulesPure.mock.calls[0][0] as {
    context: { availableRules: BankRule[] }
  }
  return callArg.context.availableRules[0].direction
}

describe('buildEngineRule — transactionDirection mapping (BRE-007)', () => {
  it('maps transactionDirection debit → direction debit', () => {
    expect(directionMappedTo(makeRule({ transactionDirection: 'debit' }))).toBe('debit');
  });

  it('maps transactionDirection credit → direction credit', () => {
    expect(directionMappedTo(makeRule({ transactionDirection: 'credit' }))).toBe('credit');
  });

  it('maps transactionDirection any → direction undefined', () => {
    expect(directionMappedTo(makeRule({ transactionDirection: 'any' }))).toBeUndefined();
  });

  it('maps transactionDirection null → direction undefined', () => {
    expect(directionMappedTo(makeRule({ transactionDirection: null }))).toBeUndefined();
  });

  it('maps missing transactionDirection → direction undefined', () => {
    const rule = makeRule() as Partial<PrismaBankRule>;
    delete rule.transactionDirection;
    expect(directionMappedTo(rule as PrismaBankRule)).toBeUndefined();
  });

  it('does not set direction in any other field of the engine rule', () => {
    mockEvaluateRulesPure.mockReturnValueOnce({
      output: { candidates: [], decision: { type: 'rule', result: 'no_match', candidateList: [], explanation: '' } },
    });
    runRuleEngineV2Shadow(makeTxn(), [makeRule({ transactionDirection: 'debit' })], defaultEntityResolution, 'company-1');
    const callArg = mockEvaluateRulesPure.mock.calls[0][0] as {
      context: { availableRules: BankRule[] }
    };
    const { direction, ...rest } = callArg.context.availableRules[0];
    expect(direction).toBe('debit');
    expect(rest).not.toHaveProperty('transactionDirection');
  });
});
