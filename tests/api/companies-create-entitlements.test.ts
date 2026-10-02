/**
 * Coverage repair — direct test of the REAL POST handler exported from
 * src/app/api/companies/route.ts (non-admin route).
 *
 * Proves that a Company created through this route receives exactly the 5
 * default CompanyModuleEntitlement rows.
 *
 * Mirrors the GAP11B block in tests/api/atomicity-findings-verification.test.ts,
 * adapted to the differences of the non-admin route (requireCurrentUserId,
 * validateRequest + createAdminCompanySchema, seedChartOfAccounts,
 * createAuditLogWithRetry).
 *
 * The initializer (initializeDefaultCompanyModuleEntitlements) is intentionally
 * NOT mocked: it runs for real against the fake transaction client, whose
 * companyModuleEntitlement.upsert genuinely records every row in an in-memory
 * store — the store is only ever populated by real initializer calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

// ── Hoisted mocks ────────────────────────────────────────────────
const m = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requestContextRun: vi.fn(),
}));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: m.getSessionUserId }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, limit: 100, remaining: 99, resetAt: 999999 })),
}));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/context-storage', () => ({
  requireCurrentUserId: vi.fn(() => 'user-coverage-1'),
  requireCompanyContext: vi.fn(() => ({ userId: 'user-coverage-1', companyId: 'company-coverage-1' })),
  requestContext: { run: m.requestContextRun },
}));
vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(),
  requireActiveTenantAccess: vi.fn(),
}));
vi.mock('@/lib/validations/admin', () => ({ createAdminCompanySchema: {} }));
vi.mock('@/lib/validate-request', () => ({
  validateRequest: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    return body;
  }),
}));
vi.mock('@/lib/chart-of-accounts', () => ({ seedChartOfAccounts: vi.fn(), CHART_OF_ACCOUNTS: [] }));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: vi.fn() }));

// NOTE: '@/lib/services/module-entitlement-initialization' is NOT mocked on
// purpose — the real initializer must execute inside the real handler flow.

// ── Mock db methods ──────────────────────────────────────────────
const dbMocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  dbTransaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: dbMocks.userFindUnique },
    companyMember: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: dbMocks.dbTransaction,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.getSessionUserId.mockResolvedValue('user-coverage-1');
  m.requestContextRun.mockImplementation(async (_c: unknown, fn: () => Promise<unknown>) => fn());
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/companies — default module entitlements seeded in TX
// ═══════════════════════════════════════════════════════════════════
describe('POST /api/companies — default module entitlements seeded in TX', () => {
  it('company creation initializes exactly 5 default CompanyModuleEntitlement rows', async () => {
    const COMPANY_ID = 'company-coverage-1';

    interface EntitlementRow {
      id: string;
      companyId: string;
      moduleKey: string;
      enabled: boolean;
      activatedAt: Date | null;
      deactivatedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }
    interface EntitlementUpsertArgs {
      where: { companyId_moduleKey: { companyId: string; moduleKey: string } };
      create: Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>;
      update: Partial<Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>>;
    }

    // In-memory store: ONLY the real initializer's upsert calls can populate it.
    const entitlementStore: EntitlementRow[] = [];
    let rowId = 0;
    const upsertSpy = vi.fn(
      async ({ where, create, update }: EntitlementUpsertArgs): Promise<EntitlementRow> => {
        const target = where.companyId_moduleKey;
        const existing = entitlementStore.find(
          (row) => row.companyId === target.companyId && row.moduleKey === target.moduleKey,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const now = new Date();
        const row: EntitlementRow = {
          id: `row-${++rowId}`,
          createdAt: now,
          updatedAt: now,
          ...create,
        };
        entitlementStore.push(row);
        return row;
      },
    );

    dbMocks.dbTransaction.mockImplementation(
      async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const mockTx = {
          company: {
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
              id: COMPANY_ID,
              ...data,
            })),
          },
          companyMember: { create: vi.fn(async () => ({ id: 'member-coverage-1' })) },
          companyModuleEntitlement: { upsert: upsertSpy },
          auditLog: { create: vi.fn(async () => ({ id: 'audit-coverage-1' })) },
        };
        return cb(mockTx);
      },
    );

    const { POST } = await import('@/app/api/companies/route');
    const req = new NextRequest('http://localhost/api/companies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ legalName: 'Entitlements Coverage Co', taxId: '77-666666' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    const json = (await res.json()) as { company: { id: string; legalName: string } };

    // C1: successful creation response from the real handler
    expect(dbMocks.dbTransaction).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    expect(json.company.id).toBe(COMPANY_ID);

    // C2: the real initializer executed inside the real flow — proven by the
    // in-memory store receiving the upserts (initializer is NOT mocked)
    expect(upsertSpy).toHaveBeenCalledTimes(5);

    // C3: exactly 5 entitlement rows created
    expect(entitlementStore).toHaveLength(5);

    // C4: exact key set
    const keys = entitlementStore.map((row) => row.moduleKey).sort();
    expect(keys).toEqual(['accounting', 'banking', 'inventory', 'purchases', 'sales']);

    // C5: exact profile
    const byKey = new Map(entitlementStore.map((row) => [row.moduleKey, row]));
    expect(byKey.size).toBe(5);
    expect(byKey.get('accounting')?.enabled).toBe(true);
    expect(byKey.get('banking')?.enabled).toBe(true);
    expect(byKey.get('purchases')?.enabled).toBe(false);
    expect(byKey.get('sales')?.enabled).toBe(false);
    expect(byKey.get('inventory')?.enabled).toBe(false);

    // C6: timestamps
    expect(byKey.get('accounting')?.activatedAt).not.toBeNull();
    expect(byKey.get('accounting')?.deactivatedAt).toBeNull();
    expect(byKey.get('banking')?.activatedAt).not.toBeNull();
    expect(byKey.get('banking')?.deactivatedAt).toBeNull();
    expect(byKey.get('purchases')?.activatedAt).toBeNull();
    expect(byKey.get('purchases')?.deactivatedAt).toBeNull();
    expect(byKey.get('sales')?.activatedAt).toBeNull();
    expect(byKey.get('sales')?.deactivatedAt).toBeNull();
    expect(byKey.get('inventory')?.activatedAt).toBeNull();
    expect(byKey.get('inventory')?.deactivatedAt).toBeNull();

    // C7: every entitlement row belongs to the company returned by the handler
    expect(entitlementStore.every((row) => row.companyId === json.company.id)).toBe(true);
    expect(entitlementStore.every((row) => row.companyId === COMPANY_ID)).toBe(true);
  });
});
