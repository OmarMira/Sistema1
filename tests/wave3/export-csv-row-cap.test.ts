import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * S23a — GET /api/export/csv row cap.
 *
 * The export used to stream every row the ledger held. It is now bounded by a
 * documented constant, and an export that would exceed it is REFUSED (413 with
 * a clear message) instead of being silently truncated: a bookkeeping export
 * that quietly drops rows is worse than one that asks for a narrower range.
 *
 * /lib/db is mocked so the cap can be exercised without seeding 50k rows; the
 * handler, the guard order and the response contract are the real ones.
 */
vi.mock('@/lib/db', () => {
  return {
    db: {
      companyModuleEntitlement: { findFirst: async () => ({ enabled: true }) },
      journalLine: { findMany: vi.fn().mockResolvedValue([]) },
      journalEntry: { findMany: vi.fn().mockResolvedValue([]) },
      bankTransaction: { findMany: vi.fn().mockResolvedValue([]) },
      bankAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'bank-1' }) },
      glAccount: { findMany: vi.fn().mockResolvedValue([]) },
      company: { findUnique: vi.fn().mockResolvedValue({ legalName: 'St Co', logo: null }) },
      user: { findUnique: vi.fn().mockResolvedValue({ platformRole: 'user' }) },
    },
  };
});

vi.mock('@/lib/context-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/context-storage')>();
  return {
    ...original,
    requireCompanyContext: () => ({ userId: 'u1', companyId: 'c1' }),
  };
});

vi.mock('@/lib/rbac', () => ({
  requireActiveTenantAccess: vi.fn(),
  requireCompanyRole: vi.fn(),
  COMPANY_ROLES: [],
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 'u1'),
  getSessionToken: vi.fn(() => 'raw-test-token'),
  createSession: vi.fn(async () => 'raw-test-token'),
  destroySession: vi.fn(),
  deleteAllUserSessions: vi.fn(),
}));

import { db } from '@/lib/db';
import { GET as csvGET, MAX_EXPORT_ROWS } from '@/app/api/export/csv/route';

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/export/csv?companyId=c1${query}`);
}

type Mocked<T> = T extends { mockResolvedValue: unknown } ? T : never;

const journalEntryFindMany = db.journalEntry.findMany as unknown as Mocked<typeof db.journalEntry.findMany>;
const journalLineFindMany = db.journalLine.findMany as unknown as Mocked<typeof db.journalLine.findMany>;

function entry(index: number) {
  return {
    id: `je-${index}`,
    date: new Date('2025-03-15T00:00:00.000Z'),
    description: `Entry ${index}`,
    reference: null,
    status: 'posted',
    lines: [
      {
        id: `jl-${index}`,
        glAccount: { code: '6010', name: 'Office' },
        description: null,
        debit: 1,
        credit: 0,
      },
    ],
  };
}

describe('S23a — /api/export/csv row cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses an export above the documented cap with a clear 413', async () => {
    journalEntryFindMany.mockResolvedValue(
      Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, index) => entry(index)),
    );

    const res = await csvGET(makeRequest('&type=transactions'), { params: Promise.resolve({}) });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('EXPORT_TOO_LARGE');
    expect(body.limit).toBe(MAX_EXPORT_ROWS);
    expect(body.error).toContain('50,000');
    expect(body.error).toMatch(/rango de fechas/i);
  });

  it('bounds the read itself (LIMIT/take) instead of buffering the whole ledger', async () => {
    journalEntryFindMany.mockResolvedValue([entry(1)]);

    await csvGET(makeRequest('&type=transactions'), { params: Promise.resolve({}) });

    const args = journalEntryFindMany.mock.calls[0]?.[0] as { take?: number };
    expect(args.take).toBe(MAX_EXPORT_ROWS + 1);
  });

  it('exports normally when the result set fits under the cap', async () => {
    journalEntryFindMany.mockResolvedValue([entry(1), entry(2)]);

    const res = await csvGET(makeRequest('&type=transactions'), { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('Account Code');
    expect(text).toContain('Entry 1');
    expect(text).toContain('Entry 2');
  });

  it('applies the same cap to the trial balance read', async () => {
    journalLineFindMany.mockResolvedValue(
      Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, index) => ({
        glAccount: { code: String(index), name: 'X', accountType: 'expense', normalBalance: 'debit', isActive: true },
        debit: 1,
        credit: 0,
      })),
    );

    const res = await csvGET(makeRequest('&type=trial_balance'), { params: Promise.resolve({}) });

    expect(res.status).toBe(413);
    expect(journalLineFindMany.mock.calls[0]?.[0]).toMatchObject({ take: MAX_EXPORT_ROWS + 1 });
  });
});
