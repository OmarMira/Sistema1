// GAP #11D-D — cross-module enforcement (REQUIRE_ALL accounting + banking).
//
// C1 both effective => allowed
// C2 accounting disabled => 403 MODULE_NOT_ENTITLED, banking engine check skipped
// C3 accounting effective + banking disabled => 403 MODULE_NOT_ENTITLED
// C4 banking enabled but dependency missing => 403 MODULE_DEPENDENCY_MISSING
// C5 RBAC/tenant failure happens before both entitlement checks
// C6 engine receives the exact active tenant for both checks
//
// The guard is NOT mocked. The 11B engine is instrumented as a spy, the same
// authorized pattern used by the 11D-A/11D-C enforcement suites.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockResolveEntitlement = vi.hoisted(() => vi.fn());
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const mockBankRuleCreate = vi.hoisted(() => vi.fn());
const mockCreateAuditLogWithRetry = vi.hoisted(() => vi.fn());
const mockParseConversationalContext = vi.hoisted(() => vi.fn());
const mockSafeAuditLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({ getSessionUserId: mockGetSessionUserId }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/services/module-entitlement-engine', () => ({
  resolveCompanyModuleEntitlement: mockResolveEntitlement,
}));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    company: { findUnique: mockDbCompanyFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
    glAccount: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: mockTransaction,
    bankRule: { create: mockBankRuleCreate },
    entityContext: { upsert: vi.fn() },
  },
}));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: mockCreateAuditLogWithRetry }));
vi.mock('@/lib/services/conversational-service', () => ({
  parseConversationalContext: mockParseConversationalContext,
}));
vi.mock('@/lib/services/audit-service', () => ({ safeAuditLog: mockSafeAuditLog }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { POST as postRule } from '@/app/api/learning/rules/route';
import { POST as postParse } from '@/app/api/learning/conversational-parse/route';

// Engine results as the 11B authority produces them, per module key.
function entitlementResult(
  moduleKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    moduleKey,
    implementationStatus: 'AVAILABLE',
    configured: true,
    commercialEnabled: true,
    effectiveEnabled: true,
    reason: 'EFFECTIVE_ENABLED',
    missingDependencies: [],
    ...overrides,
  };
}

const ACCOUNTING_OK = entitlementResult('accounting');
const BANKING_OK = entitlementResult('banking');
const ACCOUNTING_DISABLED = entitlementResult('accounting', {
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'COMMERCIALLY_DISABLED',
});
const BANKING_DISABLED = entitlementResult('banking', {
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'COMMERCIALLY_DISABLED',
});
const BANKING_DEPENDENCY_MISSING = entitlementResult('banking', {
  effectiveEnabled: false,
  reason: 'MISSING_DEPENDENCY',
  missingDependencies: ['accounting'],
});

let testMembershipRole: 'company_admin' | 'viewer' = 'company_admin';

function scenario(results: Record<string, Record<string, unknown>>): void {
  mockResolveEntitlement.mockImplementation(
    async (_companyId: string, moduleKey: string) => results[moduleKey] ?? entitlementResult(moduleKey),
  );
}

function ruleRequest(companyId: string): NextRequest {
  return new NextRequest(`http://localhost/api/learning/rules?companyId=${companyId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern: 'Cross Module Rule' }),
  });
}

function parseRequest(companyId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/learning/conversational-parse?companyId=${companyId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'Cross Vendor',
        userInput: 'pago a proveedor',
        directionProfile: { creditPct: 0.5, debitPct: 0.5 },
      }),
    },
  );
}

describe('cross-module entitlement enforcement (11D-D, REQUIRE_ALL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMembershipRole = 'company_admin';
    mockGetSessionUserId.mockResolvedValue('user-1');
    mockCheckRateLimit.mockReturnValue({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: Math.ceil(Date.now() / 1000) + 60,
    });
    mockDbUserFindUnique.mockResolvedValue({ platformRole: 'user' });
    mockDbCompanyFindUnique.mockResolvedValue({ isActive: true });
    mockDbCompanyMemberFindUnique.mockImplementation(
      async (args: {
        where?: { userId_companyId?: { companyId?: string } };
        select?: { id?: boolean; role?: boolean };
      }) => {
        // tenant-9 is a foreign company: no membership row exists.
        if (args?.where?.userId_companyId?.companyId === 'tenant-9') return null;
        if (args?.select?.role) return { role: testMembershipRole };
        return { id: 'member-1' };
      },
    );
    mockTransaction.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          bankRule: { create: mockBankRuleCreate },
          glAccount: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
          entityContext: { upsert: vi.fn() },
        }),
    );
    mockBankRuleCreate.mockResolvedValue({ id: 'rule-1', name: 'Cross Module Rule' });
    mockCreateAuditLogWithRetry.mockResolvedValue(undefined);
    mockParseConversationalContext.mockResolvedValue({
      role: 'PROVEEDOR',
      glAccountCode: null,
      suggestSubAccount: false,
    });
    mockSafeAuditLog.mockResolvedValue(undefined);
    scenario({ accounting: ACCOUNTING_OK, banking: BANKING_OK });
  });

  it('C1: accounting effective + banking effective => request allowed (rules route)', async () => {
    const res = await postRule(ruleRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('C1: accounting effective + banking effective => request allowed (conversational route)', async () => {
    const res = await postParse(parseRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('C2: accounting disabled => 403 MODULE_NOT_ENTITLED and banking engine check never runs', async () => {
    scenario({ accounting: ACCOUNTING_DISABLED, banking: BANKING_OK });

    const res = await postRule(ruleRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-1', 'accounting');
  });

  it('C3: accounting effective + banking disabled => 403 MODULE_NOT_ENTITLED', async () => {
    scenario({ accounting: ACCOUNTING_OK, banking: BANKING_DISABLED });

    const res = await postParse(parseRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(2);
    expect(mockResolveEntitlement).toHaveBeenNthCalledWith(1, 'tenant-1', 'accounting');
    expect(mockResolveEntitlement).toHaveBeenNthCalledWith(2, 'tenant-1', 'banking');
  });

  it('C4: banking enabled but accounting dependency ineffective => 403 MODULE_DEPENDENCY_MISSING', async () => {
    scenario({ accounting: ACCOUNTING_OK, banking: BANKING_DEPENDENCY_MISSING });

    const res = await postRule(ruleRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_DEPENDENCY_MISSING');
    expect(body.details?.missingDependencies).toEqual(['accounting']);
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(2);
  });

  it('C5: RBAC failure happens before both entitlement checks (engine never consulted)', async () => {
    testMembershipRole = 'viewer';

    const res = await postRule(ruleRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
    expect(mockResolveEntitlement).not.toHaveBeenCalled();
  });

  it('C5: tenant failure happens before both entitlement checks (engine never consulted)', async () => {
    const res = await postRule(ruleRequest('tenant-9'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    expect(mockResolveEntitlement).not.toHaveBeenCalled();
  });

  it('C6: engine receives the exact active tenant for both checks, in policy order', async () => {
    const res = await postRule(ruleRequest('tenant-7'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(2);
    expect(mockResolveEntitlement).toHaveBeenNthCalledWith(1, 'tenant-7', 'accounting');
    expect(mockResolveEntitlement).toHaveBeenNthCalledWith(2, 'tenant-7', 'banking');
  });
});
