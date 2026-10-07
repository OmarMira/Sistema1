import { describe, it, expect, vi } from 'vitest';
import { aggregateAccountingFlow } from '@/lib/accounting/flow-aggregator';

const filters = {
  companyId: 'company-test-1',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-31T23:59:59.999Z'),
};

describe('aggregateAccountingFlow — no more silent $0 fallback', () => {
  it('rejects when the underlying bankAccount query throws', async () => {
    const prisma = {
      bankAccount: {
        findMany: vi.fn().mockRejectedValue(new Error('db connection lost')),
      },
    };

    await expect(aggregateAccountingFlow(prisma, filters)).rejects.toThrow(
      'db connection lost',
    );
  });

  it('rejects when a later internal query throws (never masquerades as zeros)', async () => {
    const prisma = {
      bankAccount: {
        findMany: vi.fn().mockResolvedValue([{ glAccountId: 'gl-1' }]),
      },
      journalEntry: {
        findMany: vi.fn().mockRejectedValue(new Error('journal query failed')),
      },
    };

    await expect(aggregateAccountingFlow(prisma, filters)).rejects.toThrow(
      'journal query failed',
    );
  });

  it('still returns legitimate zeros when the company has no cash accounts', async () => {
    const prisma = {
      bankAccount: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const result = await aggregateAccountingFlow(prisma, filters);

    expect(result.summary.totalInflows).toBe(0);
    expect(result.summary.totalOutflows).toBe(0);
    expect(result.summary.netFlow).toBe(0);
    expect(result.summary.transactionCount).toBe(0);
    expect(result.byPeriod).toEqual([]);
    expect(result.byAccount).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(prisma.bankAccount.findMany).toHaveBeenCalledTimes(1);
  });
});
