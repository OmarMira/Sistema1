import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  companyMember: { findUnique: vi.fn() },
  company: { findUnique: vi.fn() },
  bankAccount: { findMany: vi.fn() },
  journalLine: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn(), count: vi.fn() },
  fiscalPeriod: { findFirst: vi.fn(), findMany: vi.fn() },
  journalEntry: { count: vi.fn() },
  $queryRaw: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { GET } from '@/app/api/dashboard/route';

const EXPENSE = { id: 'gl-6000', accountType: 'expense', normalBalance: 'debit' };
const BANK_ASSET = { id: 'gl-bank', accountType: 'asset', normalBalance: 'debit' };

function mockContext() {
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-test', platformRole: 'user' });
  mockDb.companyMember.findUnique.mockResolvedValue({
    id: 'member-test',
    userId: 'user-test',
    companyId: 'c1',
  });
  mockDb.company.findUnique.mockResolvedValue({ isActive: true });
}

function mockTransactions(reconciledTxs: Array<Record<string, unknown>>) {
  mockDb.bankTransaction.findMany.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    if (where.isReconciled === true) {
      // H-2 fix: route now filters journalEntryId: null at DB level
      if (where.journalEntryId === null) {
        return Promise.resolve(reconciledTxs.filter((tx) => tx.journalEntryId === null));
      }
      return Promise.resolve(reconciledTxs);
    }
    return Promise.resolve([]);
  });
  mockDb.bankTransaction.count.mockResolvedValue(0);
}

describe('GET /api/dashboard — dedup by journalEntryId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext();
    mockDb.bankAccount.findMany.mockResolvedValue([]);
    mockDb.fiscalPeriod.findFirst.mockResolvedValue(null);
    mockDb.fiscalPeriod.findMany.mockResolvedValue([]);
    mockDb.journalEntry.count.mockResolvedValue(0);
  });

  it('skips a reconciled tx WITH journalEntryId even when the JE description differs', async () => {
    // H-2 fix: dashboard now uses $queryRaw for type balances and monthly trend
    mockDb.$queryRaw
      .mockResolvedValueOnce([
        { accountType: 'expense', normalBalance: 'debit', totalDebit: BigInt(100), totalCredit: BigInt(0) },
        { accountType: 'asset', normalBalance: 'debit', totalDebit: BigInt(0), totalCredit: BigInt(100) },
      ])
      .mockResolvedValueOnce([]); // monthly trend
    mockTransactions([
      { id: 'tx-1', amount: -100, description: 'Compra', journalEntryId: 'je-1', glAccount: EXPENSE },
    ]);

    const req = new NextRequest('http://localhost/api/dashboard?companyId=c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalExpenses).toBe(100);
  });

  it('counts a reconciled tx WITHOUT journalEntryId as a virtual movement', async () => {
    // H-2 fix: dashboard now uses $queryRaw for type balances and monthly trend
    mockDb.$queryRaw
      .mockResolvedValueOnce([]) // type balances (no journal lines)
      .mockResolvedValueOnce([]); // monthly trend
    mockTransactions([
      { id: 'tx-2', amount: -100, description: 'Compra', journalEntryId: null, glAccount: EXPENSE },
    ]);

    const req = new NextRequest('http://localhost/api/dashboard?companyId=c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalExpenses).toBe(100);
    expect(body.totalAssets).toBe(-100);
  });
});
