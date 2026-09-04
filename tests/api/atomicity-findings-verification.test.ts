/**
 * S5.5 — Atomicity Findings Experimental Verification
 *
 * Verifies F-1, F-2, F-2b, F-3 under simulated failure conditions.
 * Each test proves or disproves a specific atomicity hypothesis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

// ── Hoisted mocks ────────────────────────────────────────────────
const m = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requestContextRun: vi.fn(),
  saveLogo: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: m.getSessionUserId }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, limit: 100, remaining: 99, resetAt: 999999 })),
}));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/context-storage', () => ({
  requireCurrentUserId: vi.fn(() => 'admin-id'),
  requireCompanyContext: vi.fn(() => ({ userId: 'admin-id', companyId: 'company-1' })),
  requestContext: { run: m.requestContextRun },
}));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(async () => 'hashed-pw') }));
vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(),
  requireActiveTenantAccess: vi.fn(),
}));
vi.mock('@/lib/uploads/logo-service', () => ({ saveLogo: m.saveLogo }));
const mockLogoFile = { name: 'logo.png', type: 'image/png', size: 100 };
vi.mock('@/lib/parse-admin-body', () => ({
  parseAdminBody: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    return { ok: true, body: { data: body, files: new Map([['logo', mockLogoFile]]) } };
  }),
}));
vi.mock('@/lib/validations/admin', () => ({
  createAdminUserSchema: {}, createAdminCompanySchema: {}, createUserSchema: {},
}));
vi.mock('@/lib/validate-request', () => ({
  validateRequest: vi.fn(async (req: NextRequest) => { const b = await req.json(); return b; }),
}));
vi.mock('@/lib/chart-of-accounts', () => ({ seedChartOfAccounts: vi.fn(), CHART_OF_ACCOUNTS: [] }));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: vi.fn() }));
vi.mock('@/lib/fiscal-period/strategies', () => ({
  getPeriodStrategy: vi.fn(() => ({
    calculate: () => [
      { name: '2026-01', startDate: '2026-01-01', endDate: '2026-01-31' },
      { name: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28' },
    ],
  })),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: m.writeFileSync, existsSync: vi.fn(() => true), readFileSync: vi.fn(() => '{"companies":{}}') };
});
vi.mock('@/lib/config/paths', () => ({ RUNTIME_FILES: { companyConfig: '/tmp/test-config.json' } }));

// ── Mock db methods ──────────────────────────────────────────────
const dbMocks = {
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  cmFindFirst: vi.fn(),
  cmFindUnique: vi.fn(),
  cmCreate: vi.fn(),
  dbTransaction: vi.fn(),
};

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: dbMocks.userFindUnique, create: dbMocks.userCreate },
    companyMember: {
      findFirst: dbMocks.cmFindFirst,
      findUnique: dbMocks.cmFindUnique,
      create: dbMocks.cmCreate,
    },
    auditLog: { create: dbMocks.auditLogCreate },
    $transaction: dbMocks.dbTransaction,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.getSessionUserId.mockResolvedValue('admin-id');
  m.requestContextRun.mockImplementation(async (_c: unknown, fn: () => Promise<unknown>) => fn());
});

// ═══════════════════════════════════════════════════════════════════
// F-2: POST /api/admin/users
// ═══════════════════════════════════════════════════════════════════
describe('F-2: POST /api/admin/users — user persists if auditLog fails', () => {
  const mockUser = {
    id: 'user-1', email: 'test@example.com', firstName: 'Test',
    lastName: 'User', platformRole: 'user', isActive: true,
    phone: '', streetLine1: '', streetLine2: '', city: '',
    state: '', zipCode: '', avatar: '',
  };

  it('auditLog failure does NOT roll back user creation', async () => {
    // apiHandler auth → super_admin; handler → null (no existing user)
    dbMocks.userFindUnique
      .mockResolvedValueOnce({ platformRole: 'super_admin' })
      .mockResolvedValueOnce(null);
    dbMocks.userCreate.mockResolvedValue(mockUser);
    dbMocks.auditLogCreate.mockRejectedValue(new Error('auditLog failure'));

    const { POST } = await import('@/app/api/admin/users/route');
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', firstName: 'Test', lastName: 'User', password: 'password123' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });

    expect(dbMocks.userCreate).toHaveBeenCalledTimes(1);
    expect(dbMocks.auditLogCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F-2b: POST /api/users
// ═══════════════════════════════════════════════════════════════════
describe('F-2b: POST /api/users — user+membership persists if auditLog fails', () => {
  const mockNewUser = {
    id: 'user-2', email: 'invite@example.com', firstName: 'Invite',
    lastName: 'User', platformRole: 'user',
  };

  it('auditLog failure does NOT roll back user+membership creation', async () => {
    // apiHandler auth → super_admin; handler → null (no existing user)
    dbMocks.userFindUnique
      .mockResolvedValueOnce({ platformRole: 'super_admin' })
      .mockResolvedValueOnce(null);
    dbMocks.userCreate.mockResolvedValue(mockNewUser);
    dbMocks.auditLogCreate.mockRejectedValue(new Error('auditLog failure'));

    const { POST } = await import('@/app/api/users/route');
    const req = new NextRequest('http://localhost/api/users?companyId=company-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invite@example.com', firstName: 'Invite', lastName: 'User', password: 'password123', role: 'company_admin' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    const json = await res.json();

    expect(dbMocks.userCreate).toHaveBeenCalledTimes(1);
    expect(dbMocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'invite@example.com',
        companyMemberships: { create: expect.any(Object) },
      }),
    }));
    expect(dbMocks.auditLogCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error');
  });
});

// ═══════════════════════════════════════════════════════════════════
// F-1: POST /api/admin/companies
// ═══════════════════════════════════════════════════════════════════
describe('F-1: POST /api/admin/companies — logo orphan on TX failure', () => {
  it('saveLogo is called BEFORE $transaction — logo persists if TX fails', async () => {
    dbMocks.userFindUnique.mockResolvedValue({ platformRole: 'super_admin' });
    m.saveLogo.mockResolvedValue('/uploads/logos/orphaned-logo.png');
    dbMocks.dbTransaction.mockRejectedValue(new Error('Simulated TX failure'));

    const { POST } = await import('@/app/api/admin/companies/route');
    const req = new NextRequest('http://localhost/api/admin/companies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ legalName: 'Test Company', taxId: '123456789' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });

    expect(m.saveLogo).toHaveBeenCalledTimes(1);
    expect(dbMocks.dbTransaction).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F-3: POST /api/onboarding/complete
// ═══════════════════════════════════════════════════════════════════
describe('F-3: POST /api/onboarding/complete — JSON config desync on TX failure', () => {
  it('saveCompanyConfig runs inside TX callback but OUTSIDE DB transaction — config persists if TX rolls back', async () => {
    // Handler does its own auth check (lines 68-96):
    // 1. db.user.findUnique → platformRole
    // 2. db.companyMember.findFirst → role check
    dbMocks.userFindUnique.mockResolvedValue({ platformRole: 'company_admin' });
    dbMocks.cmFindFirst.mockResolvedValue({ role: 'company_admin' });

    dbMocks.dbTransaction.mockImplementation(
      async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const mockTx = {
          company: {
            findUnique: vi.fn().mockResolvedValue({ id: 'company-1', legalName: 'Test' }),
            update: vi.fn().mockResolvedValue({ id: 'company-1' }),
          },
          fiscalPeriod: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockRejectedValue(new Error('Simulated fiscalPeriod.create failure')),
          },
          glAccount: { count: vi.fn().mockResolvedValue(0), create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
          journalEntry: { create: vi.fn() },
          bankAccount: { create: vi.fn() },
          auditLog: { create: vi.fn() },
        };
        return cb(mockTx);
      },
    );

    const { POST } = await import('@/app/api/onboarding/complete/route');
    const req = new NextRequest('http://localhost/api/onboarding/complete?companyId=company-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        legalName: 'Test Company', currency: 'USD',
        fiscalYearStartMonth: 1, fiscalYearStartYear: 2026,
        periodType: 'CALENDAR', initialCashBalance: 0,
      }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });

    expect(dbMocks.dbTransaction).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(m.writeFileSync).toHaveBeenCalled();
  });
});
