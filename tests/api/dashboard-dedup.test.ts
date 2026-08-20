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
    if (where.isReconciled === true) return Promise.resolve(reconciledTxs);
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
    mockDb.journalLine.findMany.mockResolvedValue([
      { id: 'jl-1', debit: 100, credit: 0, glAccount: EXPENSE, entry: { description: 'Auto-reconcile: Compra (Rule: X)' } },
      { id: 'jl-2', debit: 0, credit: 100, glAccount: BANK_ASSET, entry: { description: 'Auto-reconcile: Compra (Rule: X)' } },
    ]);
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
    mockDb.journalLine.findMany.mockResolvedValue([]);
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
