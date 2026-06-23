import { describe, it, expect, vi } from 'vitest';
import { GET as journalGET } from '../src/app/api/journal/route';
import { GET as reconGET } from '../src/app/api/reconciliation/route';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-id-123'),
}));

vi.mock('../src/lib/db', () => ({
  db: {
    companyMember: {
      findUnique: vi.fn().mockResolvedValue({ id: 'member-123' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'member-123' }),
    },
    journalEntry: {
      findMany: vi.fn().mockResolvedValue([
        { id: '1', date: new Date(), createdAt: new Date(), updatedAt: new Date(), description: 'Entry 1', lines: [] },
        { id: '2', date: new Date(), createdAt: new Date(), updatedAt: new Date(), description: 'Entry 2', lines: [] },
      ]),
      count: vi.fn().mockResolvedValue(2),
    },
    bankAccount: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'acc-123',
        glAccountId: 'gl-123',
        balance: 1000,
        glAccount: { normalBalance: 'debit' },
      }),
    },
    bankStatement: {
      findFirst: vi.fn().mockResolvedValue({ id: 'stmt-123', closingBalance: 1200, endDate: new Date() }),
      findMany: vi.fn().mockResolvedValue([{ id: 'stmt-123', startDate: new Date(), endDate: new Date() }]),
    },
    bankTransaction: {
      findMany: vi.fn().mockResolvedValue([
        { id: 't1', amount: 50, date: new Date(), description: 'Tx 1', isReconciled: false },
      ]),
      count: vi.fn().mockResolvedValue(1),
    },
    journalLine: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    reconciliationPeriod: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-id-123', role: 'company_admin' }),
    },
  },
}));

describe('Paginación Cursor + Offset', () => {
  it('GET /api/journal sin cursor debe retornar paginación por offset (comportamiento original)', async () => {
    const request = new NextRequest('http://localhost:3000/api/journal?companyId=c123&page=1&limit=2');
    const response = await journalGET(request, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(2);
  });

  it('GET /api/journal con cursor debe retornar nextCursor y hasMore (comportamiento cursor-based)', async () => {
    const request = new NextRequest('http://localhost:3000/api/journal?companyId=c123&cursor=&limit=1');
    const response = await journalGET(request, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toBeDefined();
    expect(body.nextCursor).toBeDefined();
    expect(body.hasMore).toBeDefined();
  });
});
