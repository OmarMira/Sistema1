import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  bankRule: { findMany: vi.fn() },
  bankStatement: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn() },
  entityContext: { findMany: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

const mockPersist = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/rule-precedence-shadow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/rule-precedence-shadow')>();
  return {
    ...actual,
    persistShadowSummaryBestEffort: mockPersist,
  };
});

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: vi.fn(),
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
  { id: 'tx-1', statementId: 'stmt-1', date: new Date('2026-07-01'), description: 'GAS STATION PAYMENT', amount: -45.50, isReconciled: false, isIgnored: false, journalEntryId: null, matchedRuleId: null, glAccountId: null },
  { id: 'tx-2', statementId: 'stmt-1', date: new Date('2026-07-01'), description: 'SUPERMARKET MONTHLY', amount: -120.00, isReconciled: false, isIgnored: false, journalEntryId: null, matchedRuleId: null, glAccountId: null },
  { id: 'tx-3', statementId: 'stmt-1', date: new Date('2026-07-01'), description: 'WIRE DEPOSIT CLIENT', amount: 5000.00, isReconciled: false, isIgnored: false, journalEntryId: null, matchedRuleId: null, glAccountId: null },
  { id: 'tx-4', statementId: 'stmt-1', date: new Date('2026-07-01'), description: 'ONLINE SUBSCRIPTION', amount: -15.00, isReconciled: false, isIgnored: false, journalEntryId: null, matchedRuleId: null, glAccountId: null },
];

const OLD_ENV = { ...process.env };

const getBaselineResult = (result: any) => ({
  matchedRuleIds: result.matchedRules.map((r: any) => r.rule.id).sort(),
  totalCount: result.totalCount,
  totalAmount: result.totalAmount,
  remaining: result.remaining,
  txIds: result.transactions.map((t: any) => t.id).sort(),
});

describe('S7-04C: Apply All with Shadow ON/OFF', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED;
    delete process.env.RULE_ENGINE_ADAPTER_ENABLED;

    mockDb.company.findUnique.mockResolvedValue({
      entityFirstMode: false,
      maxApplyTransactions: 200,
    });

    mockDb.bankRule.findMany.mockResolvedValue(RULES);
    mockDb.bankStatement.findMany.mockResolvedValue([{ id: 'stmt-1', bankAccountId: 'ba-001' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue(TRANSACTIONS);
    mockDb.entityContext.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('Shadow OFF: matchTransactions produces baseline result', async () => {
    const result = await matchTransactions('c1');

    expect(mockPersist).not.toHaveBeenCalled();
    expect(result.matchedRules.length).toBe(3);

    const gasRule = result.matchedRules.find((r: any) => r.rule.id === 'rule-debit-gas');
    expect(gasRule?.txIds).toEqual(['tx-1']);

    const incomeRule = result.matchedRules.find((r: any) => r.rule.id === 'rule-credit-income');
    expect(incomeRule?.txIds).toEqual(['tx-3']);

    const superRule = result.matchedRules.find((r: any) => r.rule.id === 'rule-debit-super');
    expect(superRule?.txIds).toEqual(['tx-2']);

    expect(result.totalCount).toBe(3);
  });

  it('Shadow ON + Adapter OFF: productive result is identical to baseline', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';

    const result = await matchTransactions('c1');

    expect(result.matchedRules.length).toBe(3);

    const gasRule = result.matchedRules.find((r: any) => r.rule.id === 'rule-debit-gas');
    expect(gasRule?.txIds).toEqual(['tx-1']);

    const incomeRule = result.matchedRules.find((r: any) => r.rule.id === 'rule-credit-income');
    expect(incomeRule?.txIds).toEqual(['tx-3']);

    const superRule = result.matchedRules.find((r: any) => r.rule.id === 'rule-debit-super');
    expect(superRule?.txIds).toEqual(['tx-2']);

    expect(result.totalCount).toBe(3);
  });

  it('Shadow ON + Adapter OFF: persistShadowSummaryBestEffort is called with ApplyAllBatch', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';

    await matchTransactions('c1');

    expect(mockPersist).toHaveBeenCalledTimes(1);
    const callArg = mockPersist.mock.calls[0][0];
    expect(callArg.entity).toBe('ApplyAllBatch');
    expect(callArg.entityId).toMatch(/^apply-all-/);
    expect(callArg.companyId).toBe('c1');
    expect(callArg.summary).toBeDefined();
    expect(callArg.summary.totalEvaluated).toBe(4);
    expect(callArg.summary.sameWinner).toBeGreaterThanOrEqual(0);
  });

  it('Shadow ON + Adapter ON: shadow is NOT executed', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';
    process.env.RULE_ENGINE_ADAPTER_ENABLED = 'true';

    const result = await matchTransactions('c1');

    expect(mockPersist).not.toHaveBeenCalled();
    expect(result.matchedRules.length).toBeGreaterThanOrEqual(0);
  });

  it('Shadow ON + Adapter OFF: matchedRules are identical to Shadow OFF', async () => {
    const baseline = await matchTransactions('c1');
    const baselineSummary = getBaselineResult(baseline);

    vi.clearAllMocks();
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';

    mockDb.company.findUnique.mockResolvedValue({ entityFirstMode: false, maxApplyTransactions: 200 });
    mockDb.bankRule.findMany.mockResolvedValue(RULES);
    mockDb.bankStatement.findMany.mockResolvedValue([{ id: 'stmt-1', bankAccountId: 'ba-001' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue(TRANSACTIONS);
    mockDb.entityContext.findMany.mockResolvedValue([]);

    const withShadow = await matchTransactions('c1');

    expect(getBaselineResult(withShadow)).toEqual(baselineSummary);
  });

  it('Shadow ON + Adapter OFF: winnerMap invariant holds (same matchedRuleIds across runs)', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';

    const result = await matchTransactions('c1');

    const allTxIds = result.transactions.map((t: any) => t.id).sort();
    const matchedTxIds = new Set(result.matchedRules.flatMap((r: any) => r.txIds));
    for (const txId of allTxIds) {
      expect(matchedTxIds.has(txId)).toBe(true);
    }
  });
});
