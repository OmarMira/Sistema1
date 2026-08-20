import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  companyMember: { findUnique: vi.fn() },
  company: { findUnique: vi.fn() },
  journalLine: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn() },
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { GET } from '@/app/api/reports/trial-balance/route';

const CASH = {
  id: 'gl-1010',
  code: '1010',
  name: 'Cash',
  accountType: 'asset',
  normalBalance: 'debit',
  isActive: true,
};
const EXPENSE = {
  id: 'gl-6000',
  code: '6000',
  name: 'Expense',
  accountType: 'expense',
  normalBalance: 'debit',
  isActive: true,
};

function mockContext() {
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-test', platformRole: 'user' });
  mockDb.companyMember.findUnique.mockResolvedValue({
    id: 'member-test',
    userId: 'user-test',
    companyId: 'c1',
  });
  mockDb.company.findUnique.mockResolvedValue({ isActive: true });
}

describe('GET /api/reports/trial-balance — dedup by journalEntryId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext();
  });

  it('counts a reconciled tx WITH journalEntryId only once (via its posted lines)', async () => {
    mockDb.journalLine.findMany.mockResolvedValue([
      { id: 'jl-1', glAccount: EXPENSE, debit: 50, credit: 0, entry: { description: 'Reconciliation: Compra' } },
      { id: 'jl-2', glAccount: CASH, debit: 0, credit: 50, entry: { description: 'Reconciliation: Compra' } },
    ]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-1',
        amount: -50,
        description: 'Compra',
        journalEntryId: 'je-1',
        glAccount: EXPENSE,
        statement: { bankAccount: { glAccount: CASH } },
      },
    ]);

    const req = new NextRequest('http://localhost/api/reports/trial-balance?companyId=c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    const expense = body.accounts.find((a: { code: string }) => a.code === '6000');
    expect(expense.balance).toBe(50);
  });

  it('counts a reconciled tx WITHOUT journalEntryId as a virtual movement', async () => {
    mockDb.journalLine.findMany.mockResolvedValue([]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-2',
        amount: -30,
        description: 'Cafe',
        journalEntryId: null,
        glAccount: EXPENSE,
        statement: { bankAccount: { glAccount: CASH } },
      },
    ]);

    const req = new NextRequest('http://localhost/api/reports/trial-balance?companyId=c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    const expense = body.accounts.find((a: { code: string }) => a.code === '6000');
    expect(expense.balance).toBe(30);
    const cash = body.accounts.find((a: { code: string }) => a.code === '1010');
    expect(cash.balance).toBe(-30);
  });
});
