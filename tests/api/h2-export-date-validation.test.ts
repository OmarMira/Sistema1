import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * H2 — export date validation regression tests.
 *
 * A malformed caller-supplied date (startDate / endDate / asOfDate) in the
 * CSV and PDF export routes used to become `new Date(...)` → Invalid Date →
 * PrismaClientValidationError → generic 500. H2 requires:
 *   invalid date → HTTP 400 (controlled) BEFORE any Prisma/DB access;
 *   valid date   → flow unchanged.
 *
 * Simulates the route surface with real handlers: /lib/db mocked so the tests
 * prove the newly-added guard fires BEFORE Prisma (no DB I/O attempted for
 * invalid dates); context is mocked server-side (same shape the apiHandler
 * would produce for an authorized session).
 */

vi.mock('@/lib/db', () => {
  const journalLineFindMany = vi.fn().mockResolvedValue([]);
  const journalEntryFindMany = vi.fn().mockResolvedValue([]);
  const companyFindUnique = vi.fn().mockResolvedValue({ legalName: 'St Co', logo: null });
  const userFindUnique = vi.fn().mockResolvedValue({ platformRole: 'user' });
  return {
    db: {
      journalLine: { findMany: journalLineFindMany },
      journalEntry: { findMany: journalEntryFindMany },
      company: { findUnique: companyFindUnique },
      user: { findUnique: userFindUnique },
      rateLimit: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockRejectedValue(new Error('test-no-db')),
      },
      __findMany: journalEntryFindMany,
      __findUnique: companyFindUnique,
      __journalLineFindMany: journalLineFindMany,
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

// apiHandler runs the tenant gate BEFORE the route handler. The H2 400 must
// come from the route's own date validation, so the gate is mocked to pass
// exactly like an authorized session would.
vi.mock('@/lib/rbac', () => ({
  requireActiveTenantAccess: vi.fn(),
  requireCompanyRole: vi.fn(),
  COMPANY_ROLES: [],
}));

// The apiHandler resolves the session BEFORE executing the route handler.
// Mock the session layer so tests drive the real route logic, not auth.
vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 'u1'),
  getSessionToken: vi.fn(() => 'raw-test-token'),
  createSession: vi.fn(async () => 'raw-test-token'),
  destroySession: vi.fn(),
  deleteAllUserSessions: vi.fn(),
}));;

vi.mock('@/lib/api-handler', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api-handler')>();
  // keep apiHandler real — the 400 must come from the route's own logic
  return original;
});

import { db } from '@/lib/db';
import { GET as csvGET } from '@/app/api/export/csv/route';
import { GET as pdfGET } from '@/app/api/export/pdf/route';

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/export/csv?companyId=c1${query}`, {
    method: 'GET',
  } as never);
}

function prismaCallCount(): number {
  const d = db as unknown as { __findMany: ReturnType<typeof vi.fn>; __findUnique: ReturnType<typeof vi.fn> };
  return (d.__findMany as ReturnType<typeof vi.fn>).mock.calls.length + (d.__findUnique as ReturnType<typeof vi.fn>).mock.calls.length;
}

describe('H2 — export date validation (invalid date → 400, never Prisma)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.journalLine.findMany as ReturnType<typeof vi.fn>).mockClear();
    (db.journalEntry.findMany as ReturnType<typeof vi.fn>).mockClear();
  });

  // ── CSV ──
  it('CSV: startDate invalid → 400', async () => {
    const res = await csvGET(makeRequest('&type=transactions&startDate=not-a-date'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('Invalid date');
    expect((db.journalEntry.findMany as ReturnType<typeof vi.fn>).mock.calls.length, 'no Prisma read on invalid date').toBe(0);
  });

  it('CSV: endDate invalid → 400', async () => {
    const res = await csvGET(makeRequest('&type=transactions&endDate=not-a-date'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
    expect((db.journalEntry.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('CSV: asOfDate invalid → 400', async () => {
    const res = await csvGET(makeRequest('&type=trial_balance&asOfDate=not-a-date'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
    expect((db.journalLine.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('CSV: impossible calendar date (2026-99-99) → 400', async () => {
    const res = await csvGET(makeRequest('&type=trial_balance&asOfDate=2026-99-99'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
  });

  it('CSV: valid startDate/endDate pass the validation (no 400 from H2)', async () => {
    const res = await csvGET(makeRequest('&type=transactions&startDate=2026-01-01&endDate=2026-12-31'), { params: Promise.resolve({}) } as never);
    expect(res.status).not.toBe(400);
  });

  // ── PDF ──
  it('PDF: startDate invalid → 400', async () => {
    const res = await pdfGET(new NextRequest('http://localhost/api/export/pdf?companyId=c1&type=transactions&startDate=not-a-date'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('Invalid date');
    expect((db.company.findUnique as ReturnType<typeof vi.fn>).mock.calls.length, 'no Prisma read on invalid date').toBe(0);
  });

  it('PDF: endDate invalid → 400', async () => {
    const res = await pdfGET(new NextRequest('http://localhost/api/export/pdf?companyId=c1&type=transactions&endDate=not-a-date'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
  });

  it('PDF: asOfDate invalid → 400', async () => {
    const res = await pdfGET(new NextRequest('http://localhost/api/export/pdf?companyId=c1&type=trial_balance&asOfDate=garbageT00x'), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
  });
});
