import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockResolveEntitlement = vi.hoisted(() => vi.fn());
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockDbBankRuleFindMany = vi.hoisted(() => vi.fn());
const mockDbGlAccountFindMany = vi.hoisted(() => vi.fn());

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
    bankRule: { findMany: mockDbBankRuleFindMany },
    glAccount: { findMany: mockDbGlAccountFindMany },
  },
}));

import { GET as getTopAccounts } from '@/app/api/bank-rules/top-accounts/route';
import { POST as postReview } from '@/app/api/reconciliation/review/route';
import { PATCH as patchTransaction } from '@/app/api/transactions/[id]/route';

// Engine results as the 11B authority would produce them for module "banking".
const BANKING_OK = {
  moduleKey: 'banking',
  implementationStatus: 'AVAILABLE',
  configured: true,
  commercialEnabled: true,
  effectiveEnabled: true,
  reason: 'EFFECTIVE_ENABLED',
  missingDependencies: [],
};

const BANKING_DISABLED = {
  moduleKey: 'banking',
  implementationStatus: 'AVAILABLE',
  configured: true,
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'COMMERCIALLY_DISABLED',
  missingDependencies: [],
};

const BANKING_NOT_CONFIGURED = {
  moduleKey: 'banking',
  implementationStatus: 'AVAILABLE',
  configured: false,
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'NOT_CONFIGURED',
  missingDependencies: [],
};

const BANKING_DEPENDENCY_MISSING = {
  moduleKey: 'banking',
  implementationStatus: 'AVAILABLE',
  configured: true,
  commercialEnabled: true,
  effectiveEnabled: false,
  reason: 'MISSING_DEPENDENCY',
  missingDependencies: ['accounting'],
};

let testMembershipRole: 'company_admin' | 'employee' | 'viewer' = 'company_admin';

function topAccountsRequest(companyId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/bank-rules/top-accounts?companyId=${companyId}`,
  );
}

function reviewPostRequest(companyId: string): NextRequest {
  return new NextRequest(`http://localhost/api/reconciliation/review?companyId=${companyId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId: 'tx-1', action: 'approve' }),
  });
}

function transactionPatchRequest(companyId: string): NextRequest {
  return new NextRequest(`http://localhost/api/transactions/tx-1?companyId=${companyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('banking commercial entitlement enforcement (11D-C)', () => {
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
    mockDbBankRuleFindMany.mockResolvedValue([]);
    mockDbGlAccountFindMany.mockResolvedValue([]);
    mockResolveEntitlement.mockResolvedValue(BANKING_OK);
  });

  it('B1: READ with banking effective (dependency resolved) → allowed (200)', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_OK);

    const res = await getTopAccounts(topAccountsRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
  });

  it('B2: READ banking commercially disabled → 403 MODULE_NOT_ENTITLED', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_DISABLED);

    const res = await getTopAccounts(topAccountsRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
  });

  it('B3: READ banking NOT_CONFIGURED → 403 MODULE_NOT_ENTITLED', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_NOT_CONFIGURED);

    const res = await getTopAccounts(topAccountsRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
  });

  it('B4: banking enabled but accounting dependency ineffective → 403 MODULE_DEPENDENCY_MISSING', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_DEPENDENCY_MISSING);

    const res = await getTopAccounts(topAccountsRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_DEPENDENCY_MISSING');
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-1', 'banking');
    // The guard never resolves dependencies locally: it only maps the engine reason.
    expect(body.details?.missingDependencies).toEqual(['accounting']);
  });

  it('B5: WRITE banking disabled → 403 MODULE_NOT_ENTITLED before business IO', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_DISABLED);

    const res = await postReview(reviewPostRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-1', 'banking');
  });

  it('B6: RBAC fails before the entitlement → prior security error preserved, engine not consulted', async () => {
    testMembershipRole = 'viewer';
    mockResolveEntitlement.mockResolvedValue(BANKING_OK);

    const res = await postReview(reviewPostRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
    expect(mockResolveEntitlement).not.toHaveBeenCalled();
  });

  it('B7: engine receives exactly the active tenant from context', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_OK);

    const res = await getTopAccounts(topAccountsRequest('tenant-7'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-7', 'banking');
  });

  it('B8: resource route entitlement uses the membership-validated active tenant; a foreign request companyId never reaches the engine', async () => {
    mockResolveEntitlement.mockResolvedValue(BANKING_OK);

    // (a) Resource-scoped route: entitlement company is the validated active
    // tenant from context — never a value taken from the resource or steered
    // by the request beyond membership validation.
    const allowed = await patchTransaction(transactionPatchRequest('tenant-1'), {
      params: Promise.resolve({}),
    });
    expect(allowed.status).toBe(400); // business validation (glAccountId required) runs after the gate
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-1', 'banking');

    // (b) Declaring a foreign company (no membership) is rejected by the
    // pre-existing tenant gate BEFORE the entitlement: the engine is never
    // asked about a company the caller is not authorized for.
    vi.clearAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-1');
    mockCheckRateLimit.mockReturnValue({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: Math.ceil(Date.now() / 1000) + 60,
    });
    mockDbUserFindUnique.mockResolvedValue({ platformRole: 'user' });
    mockDbCompanyFindUnique.mockResolvedValue({ isActive: true });
    mockDbCompanyMemberFindUnique.mockImplementation(async () => null);
    mockResolveEntitlement.mockResolvedValue(BANKING_OK);

    const denied = await patchTransaction(transactionPatchRequest('tenant-9'), {
      params: Promise.resolve({}),
    });
    expect(denied.status).toBe(403);
    expect(mockResolveEntitlement).not.toHaveBeenCalled();
  });
});
