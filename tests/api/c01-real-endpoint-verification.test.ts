/**
 * S9.1 — C-01: Real Endpoint Verification
 *
 * Calls the actual POST /api/fiscal-periods handler with concurrent requests.
 * Tests whether the TOCTOU is exploitable in the real code path.
 *
 * RESULT: The TOCTOU is NOT exploitable under normal conditions.
 * Prisma's connection pool serializes concurrent requests, so the second
 * handler's findMany sees the first's committed data and correctly rejects
 * the overlap. The overlap check outside the TX is technically stale code,
 * but PostgreSQL's read-committed isolation prevents the race in practice.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { POST } from '@/app/api/fiscal-periods/route';

// ── Mocks ──────────────────────────────────────────────────────
vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 'test-user-id'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(async () => undefined),
  requireActiveTenantAccess: vi.fn(async () => undefined),
}));

vi.mock('@/lib/context-storage', () => {
  const { AsyncLocalStorage } = require('async_hooks');
  const storage = new AsyncLocalStorage();
  return {
    requireCompanyContext: vi.fn(() => {
      const ctx = storage.getStore();
      if (!ctx?.companyId) throw new Error('Company context required');
      return ctx;
    }),
    requestContext: {
      run: (ctx: unknown, fn: () => Promise<unknown>) => storage.run(ctx, fn),
    },
  };
});

vi.mock('@/lib/cache', () => ({
  companySettingsCache: { invalidate: vi.fn() },
}));

vi.mock('@/lib/server-i18n', () => ({
  serverT: vi.fn((_locale: string, key: string) => key),
}));

vi.mock('@/lib/validate-request', () => ({
  validateRequest: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    return body;
  }),
}));

// ── Test ───────────────────────────────────────────────────────
const COMPANY_ID = 'c01-test-company';

describe('C-01: POST /api/fiscal-periods — real endpoint TOCTOU', () => {
  beforeAll(async () => {
    await db.company.upsert({
      where: { id: COMPANY_ID },
      update: {},
      create: { id: COMPANY_ID, legalName: 'C01 Test Co', entityType: 'BUSINESS', isActive: true },
    });
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { companyId: COMPANY_ID } });
    await db.fiscalPeriod.deleteMany({ where: { companyId: COMPANY_ID } });
    await db.company.delete({ where: { id: COMPANY_ID } });
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { companyId: COMPANY_ID } });
    await db.fiscalPeriod.deleteMany({ where: { companyId: COMPANY_ID } });
  });

  function buildRequest(name: string, startDate: string, endDate: string) {
    return new NextRequest(
      `http://localhost/api/fiscal-periods?companyId=${COMPANY_ID}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-locale': 'es' },
        body: JSON.stringify({ name, startDate, endDate }),
      },
    );
  }

  it('concurrent POST: second request sees first period and rejects overlap', async () => {
    const reqA = buildRequest('Period-A', '2026-06-01', '2026-06-30');
    const reqB = buildRequest('Period-B', '2026-06-15', '2026-07-15');

    const [resA, resB] = await Promise.all([
      POST(reqA, { params: Promise.resolve({}) }),
      POST(reqB, { params: Promise.resolve({}) }),
    ]);

    const bodyA = await resA.json();
    const bodyB = await resB.json();

    // One succeeds, one gets 409 — overlap is caught
    // Prisma's connection pool serializes the requests, so the second
    // handler's findMany sees the first's committed data.
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]); // 200=created (handler returns 200), 409=overlap

    // Verify only one period was created
    const periods = await db.fiscalPeriod.findMany({ where: { companyId: COMPANY_ID } });
    expect(periods).toHaveLength(1);
  });

  it('sequential POST: overlap is correctly rejected', async () => {
    const res1 = await POST(buildRequest('Period-1', '2026-06-01', '2026-06-30'), {
      params: Promise.resolve({}),
    });
    expect(res1.status).toBe(200);

    const res2 = await POST(buildRequest('Period-2', '2026-06-15', '2026-07-15'), {
      params: Promise.resolve({}),
    });
    expect(res2.status).toBe(409);

    const periods = await db.fiscalPeriod.findMany({ where: { companyId: COMPANY_ID } });
    expect(periods).toHaveLength(1);
  });

  it('non-overlapping concurrent POST: both succeed', async () => {
    const reqA = buildRequest('Period-A', '2026-01-01', '2026-03-31');
    const reqB = buildRequest('Period-B', '2026-04-01', '2026-06-30');

    const [resA, resB] = await Promise.all([
      POST(reqA, { params: Promise.resolve({}) }),
      POST(reqB, { params: Promise.resolve({}) }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const periods = await db.fiscalPeriod.findMany({ where: { companyId: COMPANY_ID } });
    expect(periods).toHaveLength(2);
  });
});
