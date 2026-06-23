import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  companyMember: { findUnique: vi.fn() },
  bankAccount: { findFirst: vi.fn() },
  bankStatement: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn(), count: vi.fn() },
  journalLine: { findMany: vi.fn() },
  reconciliationPeriod: { findFirst: vi.fn(), findMany: vi.fn() },
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { GET } from '@/app/api/reconciliation/route';

function mockContext() {
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-test', role: 'company_admin' });
  mockDb.companyMember.findUnique.mockResolvedValue({
    id: 'member-test',
    userId: 'user-test',
    companyId: 'c1',
  });
}

function mockBankAccount() {
  mockDb.bankAccount.findFirst.mockResolvedValue({
    id: 'ba-1',
    accountName: 'Checking',
    bankName: 'Test Bank',
    balance: 5000,
    currency: 'USD',
    glAccountId: 'gl-1010',
    glAccount: { id: 'gl-1010', code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' },
  });
}

const STMT_MAR = { id: 'stmt-mar', startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31'), openingBalance: 1000, closingBalance: 5000, format: 'pdf', fileName: 'mar.pdf' };
const STMT_APR = { id: 'stmt-apr', startDate: new Date('2025-04-01'), endDate: new Date('2025-04-30'), openingBalance: 5000, closingBalance: 8000, format: 'pdf', fileName: 'apr.pdf' };

function mockStatements() {
  mockDb.bankStatement.findMany.mockResolvedValue([STMT_MAR, STMT_APR]);
  mockDb.bankStatement.findFirst.mockImplementation((args: any) => {
    const where = args?.where || {};
    // latestStatement query: where.bankAccountId set, no id
    if (where.bankAccountId && !where.id) {
      return Promise.resolve(STMT_APR);
    }
    // activeStatement query: where.id set (with statementId)
    if (where.id === 'stmt-mar') {
      return Promise.resolve(STMT_MAR);
    }
    if (where.id === 'stmt-apr') {
      return Promise.resolve(STMT_APR);
    }
    return Promise.resolve(STMT_APR);
  });
}

function mockTransactions() {
  mockDb.bankTransaction.findMany.mockResolvedValue([]);
  mockDb.bankTransaction.count.mockResolvedValue(0);
}

function mockJournalLines(lines: Array<{ date: string; debit: number; credit: number }>) {
  mockDb.journalLine.findMany.mockImplementation(
    (args: any) => {
      const entryFilter = args.where?.entry as Record<string, unknown> | undefined;
      const dateLimit = (entryFilter?.date as Record<string, Date> | undefined)?.lte;
      const filtered = dateLimit
        ? lines.filter((l) => new Date(l.date) <= dateLimit)
        : lines;
      return Promise.resolve(
        filtered.map((l) => ({
          id: `jl-${l.debit}-${l.credit}`,
          glAccountId: 'gl-1010',
          debit: l.debit,
          credit: l.credit,
          entry: { date: new Date(l.date) },
        })),
      );
    },
  );
}

describe('GET /api/reconciliation — book balance date scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext();
    mockBankAccount();
    mockStatements();
    mockTransactions();
    mockDb.reconciliationPeriod.findFirst.mockResolvedValue(null);
    mockDb.reconciliationPeriod.findMany.mockResolvedValue([]);
  });

  it('includes ALL journal lines when no statementId or endDate filter', async () => {
    mockJournalLines([
      { date: '2025-03-15', debit: 5000, credit: 0 },
      { date: '2025-04-15', debit: 3000, credit: 0 },
    ]);

    const req = new NextRequest('http://localhost/api/reconciliation?bankAccountId=ba-1&companyId=c1');
    const response = await GET(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(body.summary.bookBalance).toBe(8000);
  });

  it('scopes bookBalance to the specific statement endDate when statementId is provided', async () => {
    mockJournalLines([
      { date: '2025-03-15', debit: 5000, credit: 0 },
      { date: '2025-04-15', debit: 3000, credit: 0 },
    ]);

    const req = new NextRequest(
      'http://localhost/api/reconciliation?bankAccountId=ba-1&companyId=c1&statementId=stmt-mar',
    );
    const response = await GET(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(body.summary.bookBalance).toBe(5000);
    expect(body.summary.statementBalance).toBe(5000);
    expect(body.summary.difference).toBe(0);
  });

  it('scopes bookBalance to explicit endDate param, ignoring statementId endDate', async () => {
    mockJournalLines([
      { date: '2025-03-15', debit: 2000, credit: 0 },
      { date: '2025-03-20', debit: 3000, credit: 0 },
      { date: '2025-04-01', debit: 9999, credit: 0 },
    ]);

    const req = new NextRequest(
      'http://localhost/api/reconciliation?bankAccountId=ba-1&companyId=c1&statementId=stmt-mar&endDate=2025-03-20',
    );
    const response = await GET(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(body.summary.bookBalance).toBe(5000);
  });

  it('uses active statement balance when statementId is provided', async () => {
    mockJournalLines([
      { date: '2025-03-15', debit: 5000, credit: 0 },
    ]);

    const req = new NextRequest(
      'http://localhost/api/reconciliation?bankAccountId=ba-1&companyId=c1&statementId=stmt-mar',
    );
    const response = await GET(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(body.summary.statementBalance).toBe(5000);
    expect(body.summary.bookBalance).toBe(5000);
    expect(body.summary.difference).toBe(0);
  });

  it('returns latestStatement in response for context', async () => {
    mockJournalLines([]);

    const req = new NextRequest(
      'http://localhost/api/reconciliation?bankAccountId=ba-1&companyId=c1&statementId=stmt-mar',
    );
    const response = await GET(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(body.latestStatement?.id).toBe('stmt-apr');
  });
});
