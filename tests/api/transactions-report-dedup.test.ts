import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  companyMember: { findUnique: vi.fn() },
  company: { findUnique: vi.fn() },
  journalEntry: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn() },
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { GET } from '@/app/api/reports/transactions/route';

const EXPENSE = {
  id: 'gl-6000',
  code: '6000',
  name: 'Expense',
  accountType: 'expense',
  normalBalance: 'debit',
};
const BANK_ASSET = {
  id: 'gl-1010',
  code: '1010',
  name: 'Cash',
  accountType: 'asset',
  normalBalance: 'debit',
};

function mockContext() {
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-test', role: 'company_admin' });
  mockDb.companyMember.findUnique.mockResolvedValue({
    id: 'member-test',
    userId: 'user-test',
    companyId: 'c1',
  });
  mockDb.company.findUnique.mockResolvedValue({ isActive: true });
}

describe('GET /api/reports/transactions — dedup by journalEntryId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext();
  });

  it('does not add a reconciled tx WITH journalEntryId as a virtual entry', async () => {
    mockDb.journalEntry.findMany.mockResolvedValue([
      {
        id: 'je-1',
        date: new Date('2025-03-15T00:00:00.000Z'),
        description: 'Auto-reconcile: Compra (Rule: X)',
        reference: null,
        status: 'posted',
        lines: [
          { id: 'jl-1', glAccount: EXPENSE, description: 'Auto-reconcile: Compra (Rule: X)', debit: 100, credit: 0 },
          { id: 'jl-2', glAccount: BANK_ASSET, description: 'Auto-reconcile: Compra (Rule: X)', debit: 0, credit: 100 },
        ],
      },
    ]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-1',
        date: new Date('2025-03-15T00:00:00.000Z'),
        amount: -100,
        description: 'Compra',
        reference: null,
        journalEntryId: 'je-1',
        glAccount: EXPENSE,
        statement: { bankAccount: { glAccount: BANK_ASSET } },
      },
    ]);

    const req = new NextRequest('http://localhost/api/reports/transactions?companyId=c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('je-1');
  });

  it('adds a reconciled tx WITHOUT journalEntryId as a virtual entry', async () => {
    mockDb.journalEntry.findMany.mockResolvedValue([]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-2',
        date: new Date('2025-03-16T00:00:00.000Z'),
        amount: -30,
        description: 'Cafe',
        reference: null,
        journalEntryId: null,
        glAccount: EXPENSE,
        statement: { bankAccount: { glAccount: BANK_ASSET } },
      },
    ]);

    const req = new NextRequest('http://localhost/api/reports/transactions?companyId=c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('tx-2');
    expect(body.data[0].lines).toHaveLength(2);
  });
});
