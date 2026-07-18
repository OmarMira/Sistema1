import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  bankRule: { findMany: vi.fn() },
  bankStatement: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn() },
  entityContext: { findMany: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

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
    id: 'rule-debit-super',
    name: 'Supermarket',
    priority: 3,
    conditionType: 'contains',
    conditionValue: 'super',
    transactionDirection: 'debit',
    glAccountId: 'gl-5020',
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
    description: 'SUPERMARKET MONTHLY',
    amount: -120.00,
    isReconciled: false,
    isIgnored: false,
    journalEntryId: null,
    matchedRuleId: null,
    glAccountId: null,
  },
  {
    id: 'tx-3',
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
  {
    id: 'tx-4',
    statementId: 'stmt-1',
    date: new Date('2026-07-01'),
    description: 'ONLINE SUBSCRIPTION',
    amount: -15.00,
    isReconciled: false,
    isIgnored: false,
    journalEntryId: null,
    matchedRuleId: null,
    glAccountId: null,
  },
];

describe('Apply All legacy baseline — matchTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDb.company.findUnique.mockResolvedValue({
      entityFirstMode: false,
      maxApplyTransactions: 200,
    });

    mockDb.bankRule.findMany.mockResolvedValue(RULES);
    mockDb.bankStatement.findMany.mockResolvedValue([{ id: 'stmt-1', bankAccountId: 'ba-001' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue(TRANSACTIONS);
    mockDb.entityContext.findMany.mockResolvedValue([]);
  });

  it('baseline: debit transaction matches correct rule', async () => {
    const result = await matchTransactions('c1');

    const gasRule = result.matchedRules.find((r) => r.rule.id === 'rule-debit-gas');
    expect(gasRule).toBeDefined();
    expect(gasRule!.rule.name).toBe('Gas Expense');
    expect(gasRule!.txIds).toEqual(['tx-1']);

    const superRule = result.matchedRules.find((r) => r.rule.id === 'rule-debit-super');
    expect(superRule).toBeDefined();
    expect(superRule!.txIds).toEqual(['tx-2']);
  });

  it('baseline: credit transaction matches correct rule', async () => {
    const result = await matchTransactions('c1');

    const incomeRule = result.matchedRules.find((r) => r.rule.id === 'rule-credit-income');
    expect(incomeRule).toBeDefined();
    expect(incomeRule!.rule.name).toBe('Income Deposit');
    expect(incomeRule!.txIds).toEqual(['tx-3']);
  });

  it('baseline: unmatched transactions are not in any matched rule', async () => {
    const result = await matchTransactions('c1');

    const allTxIds = result.matchedRules.flatMap((r) => r.txIds);
    expect(allTxIds).not.toContain('tx-4');
  });

  it('baseline: unmatched transactions are excluded from output transactions', async () => {
    const result = await matchTransactions('c1');

    const txIds = result.transactions.map((t) => t.id);
    expect(txIds).toEqual(['tx-1', 'tx-2', 'tx-3']);
  });

  it('baseline: computes totalAmount and totalCount for matched transactions', async () => {
    const result = await matchTransactions('c1');

    expect(result.totalCount).toBe(3);
    expect(result.totalAmount).toBe(-45.50 + -120.00 + 5000.00);
  });

  it('baseline: returns zero result when no active rules exist', async () => {
    mockDb.bankRule.findMany.mockResolvedValue([]);

    const result = await matchTransactions('c1');

    expect(result.matchedRules).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.totalAmount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('baseline: returns correct MatchResult structure', async () => {
    const result = await matchTransactions('c1');
    const lines = RULES.filter((r) => r.id !== 'rule-credit-income');

    for (const matched of result.matchedRules) {
      expect(matched.rule.id).toBeDefined();
      expect(matched.rule.name).toBeDefined();
      expect(typeof matched.rule.priority).toBe('number');
      expect(Array.isArray(matched.txIds)).toBe(true);
      for (const txId of matched.txIds) {
        expect(TRANSACTIONS.map((t) => t.id)).toContain(txId);
      }
    }

    for (const tx of result.transactions) {
      expect(tx.id).toBeDefined();
      expect(typeof tx.amount).toBe('number');
      expect(typeof tx.description).toBe('string');
    }
  });

  it('baseline: only matched transactions appear in output', async () => {
    const result = await matchTransactions('c1');

    const matchedTxIds = new Set(result.matchedRules.flatMap((r) => r.txIds));
    for (const tx of result.transactions) {
      expect(matchedTxIds.has(tx.id)).toBe(true);
    }
  });

  it('legacy: processes transactions even without bankAccountId in statement data', async () => {
    mockDb.bankStatement.findMany.mockResolvedValue([{ id: 'stmt-1' }]);

    const result = await matchTransactions('c1');

    const gasRule = result.matchedRules.find((r) => r.rule.id === 'rule-debit-gas');
    expect(gasRule).toBeDefined();
    expect(gasRule!.txIds).toEqual(['tx-1']);

    const incomeRule = result.matchedRules.find((r) => r.rule.id === 'rule-credit-income');
    expect(incomeRule).toBeDefined();
    expect(incomeRule!.txIds).toEqual(['tx-3']);
  });
});
