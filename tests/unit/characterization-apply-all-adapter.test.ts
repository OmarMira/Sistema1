import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  bankRule: { findMany: vi.fn() },
  bankStatement: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn() },
  entityContext: { findMany: vi.fn() },
}));

const mockEvaluate = vi.hoisted(() => ({ fn: vi.fn() }));
const mockApplyAllAdapter = vi.hoisted(() => ({ fn: vi.fn() }));
const mockIsAdapter = vi.hoisted(() => ({ fn: vi.fn() }));
const mockLegacyMatch = vi.hoisted(() => ({ fn: vi.fn() }));
const mockLegacyWinner = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/rule-engine/flag', () => ({
  isRuleEngineAdapterEnabled: mockIsAdapter.fn,
}));

vi.mock('@/lib/services/rule-precedence-engine', () => ({
  evaluateTransactionAgainstRules: mockEvaluate.fn,
}));

vi.mock('@/lib/services/rule-precedence-adapters', () => ({
  applyAllAdapter: mockApplyAllAdapter.fn,
}));

vi.mock('@/lib/services/rule-matching-engine', () => ({
  transactionMatchesRule: mockLegacyMatch.fn,
  evaluateWinningRule: mockLegacyWinner.fn,
  loadEntityFirstContext: vi.fn().mockResolvedValue({
    knownSocioPatterns: [],
    entityFirstMode: false,
  }),
  loadRolePriorities: vi.fn().mockResolvedValue({}),
}));

import { matchTransactions } from '@/lib/services/apply-all-engine';

const RULES = [
  {
    id: 'rule-debit-gas',
    name: 'Gas Expense',
    priority: 5,
    conditionType: 'contains',
    conditionValue: 'gas',
    transactionDirection: 'debit',
    glAccountId: 'gl-5010',
    debitGlAccountId: null,
    creditGlAccountId: null,
    conditions: null,
    isActive: true,
    companyId: 'c1',
  },
  {
    id: 'rule-credit-income',
    name: 'Income Deposit',
    priority: 1,
    conditionType: 'contains',
    conditionValue: 'deposit',
    transactionDirection: 'credit',
    glAccountId: 'gl-1000',
    debitGlAccountId: null,
    creditGlAccountId: null,
    conditions: null,
    isActive: true,
    companyId: 'c1',
  },
];

const TRANSACTIONS = [
  {
    id: 'tx-1',
    statementId: 'stmt-1',
    date: new Date('2026-07-01'),
    description: 'GAS STATION PAYMENT',
    amount: -45.50,
    isReconciled: false,
    isIgnored: false,
    journalEntryId: null,
    matchedRuleId: null,
    glAccountId: null,
  },
  {
    id: 'tx-2',
    statementId: 'stmt-1',
    date: new Date('2026-07-01'),
    description: 'WIRE DEPOSIT CLIENT',
    amount: 5000.00,
    isReconciled: false,
    isIgnored: false,
    journalEntryId: null,
    matchedRuleId: null,
    glAccountId: null,
  },
];

describe('matchTransactions with adapter flag ON', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockIsAdapter.fn.mockReturnValue(true);

    mockEvaluate.fn.mockReturnValue({
      winner: { ruleId: 'rule-debit-gas', priority: 5, specificityScore: 1, matchQuality: 1 },
      candidates: [{ ruleId: 'rule-debit-gas', priority: 5, specificityScore: 1, matchQuality: 1 }],
      ambiguous: false,
      reason: 'WINNER',
    });

    mockApplyAllAdapter.fn.mockReturnValue({
      matchedRuleId: 'rule-debit-gas',
      resolvedRule: {
        id: 'rule-debit-gas',
        name: 'Gas Expense',
        priority: 5,
        glAccountId: 'gl-5010',
        debitGlAccountId: null,
        creditGlAccountId: null,
      },
    });

    mockDb.company.findUnique.mockResolvedValue({
      entityFirstMode: false,
      maxApplyTransactions: 200,
    });

    mockDb.bankRule.findMany.mockResolvedValue(RULES);
    mockDb.bankStatement.findMany.mockResolvedValue([
      { id: 'stmt-1', bankAccountId: 'ba-001' },
    ]);
    mockDb.bankTransaction.findMany.mockResolvedValue(TRANSACTIONS);
    mockDb.entityContext.findMany.mockResolvedValue([]);
  });

  it('calls the canonical adapter path with a real bankAccountId', async () => {
    const result = await matchTransactions('c1');

    expect(mockEvaluate.fn).toHaveBeenCalled();
    const evaluateCall = mockEvaluate.fn.mock.calls[0];
    const txArg = evaluateCall[0];
    expect(txArg.bankAccountId).toBe('ba-001');
    expect(txArg.bankAccountId).not.toBe('');
    expect(txArg.bankAccountId).not.toBeUndefined();

    expect(mockApplyAllAdapter.fn).toHaveBeenCalled();
  });

  it('does NOT call legacy path functions', async () => {
    await matchTransactions('c1');

    expect(mockLegacyMatch.fn).not.toHaveBeenCalled();
    expect(mockLegacyWinner.fn).not.toHaveBeenCalled();
  });

  it('preserves MatchResult structure', async () => {
    const result = await matchTransactions('c1');

    expect(result).toHaveProperty('matchedRules');
    expect(result).toHaveProperty('transactions');
    expect(result).toHaveProperty('totalAmount');
    expect(result).toHaveProperty('totalCount');
    expect(result).toHaveProperty('remaining');
    expect(Array.isArray(result.matchedRules)).toBe(true);
    expect(Array.isArray(result.transactions)).toBe(true);
    expect(typeof result.totalAmount).toBe('number');
    expect(typeof result.totalCount).toBe('number');
    expect(typeof result.remaining).toBe('number');
  });

  it('returns matched transactions with correct structure', async () => {
    const result = await matchTransactions('c1');

    expect(result.matchedRules.length).toBeGreaterThan(0);
    for (const matched of result.matchedRules) {
      expect(matched.rule.id).toBeDefined();
      expect(matched.rule.name).toBeDefined();
      expect(typeof matched.rule.priority).toBe('number');
      expect(Array.isArray(matched.txIds)).toBe(true);
    }

    for (const tx of result.transactions) {
      expect(tx.id).toBeDefined();
      expect(typeof tx.amount).toBe('number');
      expect(typeof tx.description).toBe('string');
    }
  });

  it('skips transactions whose statementId is not in the bank account map', async () => {
    mockDb.bankTransaction.findMany.mockResolvedValue([
      ...TRANSACTIONS,
      {
        id: 'tx-orphan',
        statementId: 'stmt-unknown',
        date: new Date('2026-07-01'),
        description: 'ORPHAN TX',
        amount: -100,
        isReconciled: false,
        isIgnored: false,
        journalEntryId: null,
        matchedRuleId: null,
        glAccountId: null,
      },
    ]);

    const result = await matchTransactions('c1');

    const orphanTx = result.transactions.find((t) => t.id === 'tx-orphan');
    expect(orphanTx).toBeUndefined();
  });
});