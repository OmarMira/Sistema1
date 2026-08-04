import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const mockTx = {
    ruleApplyRecord: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    journalEntry: {
      update: vi.fn(),
    },
    bankTransaction: {
      updateMany: vi.fn(),
    },
  };
  return {
    db: {
      $transaction: vi.fn(async (fn: any) => fn(mockTx)),
    },
    __mockTx: mockTx,
  };
});

vi.mock('@/lib/fiscal-period-guard', () => ({
  assertActiveFiscalPeriod: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/journal-entry.service', () => ({
  JournalEntryService: {
    recalculateBalance: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: vi.fn().mockResolvedValue(undefined),
}));

import { revertApplyRecord } from '@/lib/services/rollback-apply.service';
import { __mockTx as mockTx } from '@/lib/db';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { createAuditLogWithRetry } from '@/lib/audit';

function makeRecord(overrides: Record<string, any> = {}) {
  return {
    id: 'rec-1',
    companyId: 'comp-1',
    origin: 'batch',
    ruleId: 'rule-1',
    userId: 'user-1',
    state: 'applied',
    appliedAt: new Date('2025-06-15'),
    transactions: [
      { id: 'tx-1', date: new Date('2025-06-15') },
      { id: 'tx-2', date: new Date('2025-06-16') },
    ],
    journalEntries: [
      {
        id: 'je-1',
        status: 'posted',
        lines: [
          { glAccountId: 'gl-expense' },
          { glAccountId: 'gl-bank' },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('4.1 — CAS 0-row: record stays applied, no side effects', () => {
  it('throws when CAS matches 0 rows (concurrent revert won)', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(makeRecord());
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 2 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      revertApplyRecord('comp-1', 'rec-1', 'user-1'),
    ).rejects.toThrow('Concurrent revert won');

    expect(mockTx.ruleApplyRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', state: 'applied' },
      data: { state: 'reverted' },
    });
  });

  it('does not create audit log when CAS fails', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(makeRecord());
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 2 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      revertApplyRecord('comp-1', 'rec-1', 'user-1'),
    ).rejects.toThrow();

    expect(createAuditLogWithRetry).not.toHaveBeenCalled();
  });

  it('voids journals before CAS but CAS failure rolls back the whole tx', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(makeRecord());
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 2 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      revertApplyRecord('comp-1', 'rec-1', 'user-1'),
    ).rejects.toThrow();

    expect(mockTx.journalEntry.update).toHaveBeenCalled();
    expect(createAuditLogWithRetry).not.toHaveBeenCalled();
  });
});

describe('4.2 — Idempotent double invoke on reverted record', () => {
  it('returns already-reverted without touching DB when state is not applied', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(
      makeRecord({ state: 'reverted' }),
    );

    const result = await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(result).toEqual({ status: 'already-reverted' });
    expect(mockTx.journalEntry.update).not.toHaveBeenCalled();
    expect(mockTx.bankTransaction.updateMany).not.toHaveBeenCalled();
    expect(JournalEntryService.recalculateBalance).not.toHaveBeenCalled();
    expect(createAuditLogWithRetry).not.toHaveBeenCalled();
  });

  it('returns already-reverted for reverting state (non-applied)', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(
      makeRecord({ state: 'reverting' }),
    );

    const result = await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(result).toEqual({ status: 'already-reverted' });
    expect(mockTx.ruleApplyRecord.updateMany).not.toHaveBeenCalled();
  });
});

describe('4.3 — Post-revert re-eligibility and full revert path', () => {
  it('throws NotFoundError when record does not exist', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(null);

    await expect(
      revertApplyRecord('comp-1', 'nonexistent', 'user-1'),
    ).rejects.toThrow('RuleApplyRecord not found for this company');
  });

  it('throws NotFoundError when companyId does not match', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(
      makeRecord({ companyId: 'other-company' }),
    );

    await expect(
      revertApplyRecord('comp-1', 'rec-1', 'user-1'),
    ).rejects.toThrow('RuleApplyRecord not found for this company');
  });

  it('clears classification fields on transactions, enabling re-eligibility', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(makeRecord());
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 2 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 1 });

    const result = await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(result).toEqual({ status: 'reverted' });
    expect(mockTx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['tx-1', 'tx-2'] } },
      data: {
        glAccountId: null,
        matchedRuleId: null,
        journalEntryId: null,
        journalLineId: null,
      },
    });
  });

  it('voids journals and recalculates GL balances for both accounts', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(makeRecord());
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 2 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 1 });

    await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(mockTx.journalEntry.update).toHaveBeenCalledWith({
      where: { id: 'je-1' },
      data: { status: 'void' },
    });
    expect(JournalEntryService.recalculateBalance).toHaveBeenCalledTimes(2);
    expect(JournalEntryService.recalculateBalance).toHaveBeenCalledWith(
      mockTx,
      'gl-expense',
    );
    expect(JournalEntryService.recalculateBalance).toHaveBeenCalledWith(
      mockTx,
      'gl-bank',
    );
  });

  it('creates RULE_REVERTED audit event with correct fields', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(makeRecord());
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 2 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 1 });

    await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(createAuditLogWithRetry).toHaveBeenCalledTimes(1);
    expect(createAuditLogWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'comp-1',
        userId: 'user-1',
        action: 'RULE_REVERTED',
        entity: 'RuleApplyRecord',
        entityId: 'rec-1',
      }),
      mockTx,
    );
  });

  it('skips already-voided journals: no re-update and no balance recalc', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(
      makeRecord({
        journalEntries: [
          {
            id: 'je-1',
            status: 'void',
            lines: [{ glAccountId: 'gl-expense' }],
          },
        ],
      }),
    );
    mockTx.bankTransaction.updateMany.mockResolvedValue({ count: 1 });
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 1 });

    await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(mockTx.journalEntry.update).not.toHaveBeenCalled();
    expect(JournalEntryService.recalculateBalance).not.toHaveBeenCalled();
  });

  it('handles record with no transactions and no journals', async () => {
    mockTx.ruleApplyRecord.findUnique.mockResolvedValue(
      makeRecord({ transactions: [], journalEntries: [] }),
    );
    mockTx.ruleApplyRecord.updateMany.mockResolvedValue({ count: 1 });

    const result = await revertApplyRecord('comp-1', 'rec-1', 'user-1');

    expect(result).toEqual({ status: 'reverted' });
    expect(mockTx.bankTransaction.updateMany).not.toHaveBeenCalled();
    expect(mockTx.journalEntry.update).not.toHaveBeenCalled();
    expect(createAuditLogWithRetry).toHaveBeenCalledTimes(1);
  });
});
