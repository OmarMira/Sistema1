import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const txEntryCreate = [] as Mock[];

vi.mock('@/lib/db', () => ({
  db: {
    glAccount: { findMany: vi.fn(), findFirst: vi.fn() },
    journalLine: { groupBy: vi.fn() },
    fiscalPeriod: { findMany: vi.fn() },
    $transaction: vi.fn((cb: (...args: unknown[]) => Promise<unknown>) => {
      const createEntry = vi.fn().mockResolvedValue({ id: 'entry-1' });
      txEntryCreate.push(createEntry);
      return cb({
        journalEntry: { create: createEntry },
        fiscalPeriod: { updateMany: vi.fn().mockResolvedValue({ count: 8 }) },
      });
    }),
  },
}));

vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: vi.fn() }));
vi.mock('@/lib/fiscal-period/strategies', () => ({
  getPeriodStrategy: vi.fn(),
}));

import { executeYearClose } from '@/lib/services/closing-engine';
import { db } from '@/lib/db';
import { getPeriodStrategy } from '@/lib/fiscal-period/strategies';
import { createAuditLogWithRetry } from '@/lib/audit';

const BASE_CONFIG = {
  type: 'CALENDAR' as const,
  startMonth: 1,
  closingAccountCode: '3090',
  periodsPerYear: 12,
  allowShortPeriods: false,
};

const makeAcc = (overrides: Record<string, any> = {}) => ({
  id: 'acc-default',
  code: '9999',
  name: 'Test',
  companyId: 'c1',
  isActive: true,
  accountType: 'expense',
  normalBalance: 'debit',
  parentId: null,
  isSystem: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makePeriod = (i: number) => ({
  id: `period-${i}`,
  companyId: 'c1',
  name: `P${i}`,
  startDate: new Date(`2024-${String(i).padStart(2, '0')}-01T00:00:00.000Z`),
  endDate: new Date(`2024-${String(i).padStart(2, '0')}-28T00:00:00.000Z`),
  isLocked: true,
  createdAt: new Date(),
});

function setupMockPeriods() {
  vi.mocked(getPeriodStrategy).mockReturnValue({
    calculate: () =>
      Array.from({ length: 12 }, (_, i) => ({
        startDate: new Date(`2024-${String(i + 1).padStart(2, '0')}-01T00:00:00.000Z`),
        endDate: new Date(`2024-${String(i + 1).padStart(2, '0')}-28T00:00:00.000Z`),
        name: `P${i + 1}`,
        isShort: false,
      })),
  } as any);
  vi.mocked(db.fiscalPeriod.findMany).mockResolvedValue(
    Array.from({ length: 12 }, (_, i) => makePeriod(i + 1)),
  );
  vi.mocked(db.glAccount.findFirst).mockResolvedValue(
    { id: 'closing-acc', code: '3090', name: 'Utilidades Retenidas', isActive: true, companyId: 'c1' } as any,
  );
}

function mockTotals(totals: Record<string, { debit: number; credit: number }>) {
  vi.mocked(db.journalLine.groupBy).mockResolvedValue(
    Object.entries(totals).map(([glAccountId, t]) => ({
      glAccountId,
      _sum: { debit: t.debit, credit: t.credit },
    })) as any,
  );
}

describe('executeYearClose — core closing logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txEntryCreate.length = 0;
    setupMockPeriods();
  });

  it('creates CREDIT line for expense with debit balance (diff > 0)', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'exp-1', code: '5010', accountType: 'expense', normalBalance: 'debit' }),
    ]);
    mockTotals({ 'exp-1': { debit: 5000, credit: 0 } });

    await executeYearClose('c1', 2024, BASE_CONFIG);

    const entryData = txEntryCreate[0].mock.calls[0][0];
    const lines = entryData.data.lines.create as any[];
    const expenseLine = lines.find((l: any) => l.glAccountId === 'exp-1');
    expect(expenseLine).toBeDefined();
    expect(expenseLine.debit).toBe(0);
    expect(expenseLine.credit).toBe(5000);
  });

  it('creates DEBIT line for revenue with credit balance (diff < 0)', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'rev-1', code: '4010', accountType: 'revenue', normalBalance: 'credit' }),
    ]);
    mockTotals({ 'rev-1': { debit: 0, credit: 10000 } });

    await executeYearClose('c1', 2024, BASE_CONFIG);

    const entryData = txEntryCreate[0].mock.calls[0][0];
    const lines = entryData.data.lines.create as any[];
    const revenueLine = lines.find((l: any) => l.glAccountId === 'rev-1');
    expect(revenueLine).toBeDefined();
    expect(revenueLine.debit).toBe(10000);
    expect(revenueLine.credit).toBe(0);
  });

  it('closes expense+revenue and transfers retained earnings correctly', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'exp-1', code: '5010', accountType: 'expense', normalBalance: 'debit' }),
      makeAcc({ id: 'rev-1', code: '4010', accountType: 'revenue', normalBalance: 'credit' }),
    ]);
    mockTotals({ 'exp-1': { debit: 5000, credit: 0 }, 'rev-1': { debit: 0, credit: 10000 } });

    await executeYearClose('c1', 2024, BASE_CONFIG);

    const entryData = txEntryCreate[0].mock.calls[0][0];
    const lines = entryData.data.lines.create as any[];

    // Expense closes with CREDIT 5000
    expect(lines.find((l: any) => l.glAccountId === 'exp-1')).toMatchObject({
      debit: 0,
      credit: 5000,
    });

    // Revenue closes with DEBIT 10000
    expect(lines.find((l: any) => l.glAccountId === 'rev-1')).toMatchObject({
      debit: 10000,
      credit: 0,
    });

    // Retained earnings: net = -5000 + 10000 = +5000 → CREDIT 5000
    const reLine = lines.find((l: any) => l.glAccountId === 'closing-acc');
    expect(reLine).toMatchObject({
      debit: 0,
      credit: 5000,
    });

    // Entry must be balanced
    const totalDebit = lines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.01);
  });

  it('filters out zero-balance accounts (below threshold)', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'exp-1', code: '5010', accountType: 'expense', normalBalance: 'debit' }),
      makeAcc({ id: 'exp-2', code: '5020', accountType: 'expense', normalBalance: 'debit' }),
    ]);
    mockTotals({ 'exp-1': { debit: 5000, credit: 0 }, 'exp-2': { debit: 0, credit: 0 } });

    await executeYearClose('c1', 2024, BASE_CONFIG);

    const entryData = txEntryCreate[0].mock.calls[0][0];
    const lines = entryData.data.lines.create as any[];
    expect(lines.length).toBe(2); // expense-1 + retained earnings
    expect(lines.find((l: any) => l.glAccountId === 'exp-2')).toBeUndefined();
  });

  it('transfers net loss as DEBIT to retained earnings', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'exp-1', code: '5010', accountType: 'expense', normalBalance: 'debit' }),
      makeAcc({ id: 'rev-1', code: '4010', accountType: 'revenue', normalBalance: 'credit' }),
    ]);
    mockTotals({ 'exp-1': { debit: 12000, credit: 0 }, 'rev-1': { debit: 0, credit: 10000 } });

    await executeYearClose('c1', 2024, BASE_CONFIG);

    const entryData = txEntryCreate[0].mock.calls[0][0];
    const lines = entryData.data.lines.create as any[];
    const reLine = lines.find((l: any) => l.glAccountId === 'closing-acc');

    // Net loss: -12000 + 10000 = -2000 → DEBIT 2000
    expect(reLine).toMatchObject({
      debit: 2000,
      credit: 0,
    });

    const totalDebit = lines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.01);
  });

  it('handles mixed normalBalance types (expense debit, revenue credit)', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'exp-1', code: '5010', accountType: 'expense', normalBalance: 'debit' }),
      makeAcc({ id: 'exp-2', code: '5020', accountType: 'expense', normalBalance: 'debit' }),
      makeAcc({ id: 'rev-1', code: '4010', accountType: 'revenue', normalBalance: 'credit' }),
    ]);
    mockTotals({
      'exp-1': { debit: 2000, credit: 0 },
      'exp-2': { debit: 3000, credit: 0 },
      'rev-1': { debit: 0, credit: 8000 },
    });

    await executeYearClose('c1', 2024, BASE_CONFIG);

    const entryData = txEntryCreate[0].mock.calls[0][0];
    const lines = entryData.data.lines.create as any[];
    const reLine = lines.find((l: any) => l.glAccountId === 'closing-acc');

    // Net: -2000 -3000 + 8000 = +3000 → CREDIT 3000
    expect(reLine).toMatchObject({ debit: 0, credit: 3000 });

    const totalDebit = lines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.01);
  });

  it('throws for unbalanced entry (defensive safety net)', async () => {
    vi.mocked(db.glAccount.findMany).mockResolvedValue([
      makeAcc({ id: 'exp-1', code: '5010', accountType: 'expense', normalBalance: 'debit' }),
    ]);
    mockTotals({ 'exp-1': { debit: 5000, credit: 0 } });
    // Force closingAcc to NOT be found — will throw before entry creation
    vi.mocked(db.glAccount.findFirst).mockResolvedValue(null);

    await expect(executeYearClose('c1', 2024, BASE_CONFIG)).rejects.toThrow(
      'Cuenta de cierre no encontrada',
    );
  });

  it('throws when periods are not locked', async () => {
    vi.mocked(db.fiscalPeriod.findMany).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ ...makePeriod(i + 1), isLocked: false })),
    );

    await expect(executeYearClose('c1', 2024, BASE_CONFIG)).rejects.toThrow(
      /incompletos|bloqueados/i,
    );
  });
});
