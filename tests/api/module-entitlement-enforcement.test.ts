import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockResolveEntitlement = vi.hoisted(() => vi.fn());
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockDbCount = vi.hoisted(() => vi.fn());

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
    glAccount: { count: mockDbCount },
    bankAccount: { count: mockDbCount },
    bankTransaction: { count: mockDbCount },
    bankRule: { count: mockDbCount },
    journalEntry: { count: mockDbCount },
  },
}));

import { GET as getWorkflowStatus } from '@/app/api/dashboard/workflow-status/route';
import { POST as postAccount } from '@/app/api/accounts/route';

const ENTITLEMENT_OK = {
  moduleKey: 'accounting',
  implementationStatus: 'AVAILABLE',
  configured: true,
  commercialEnabled: true,
  effectiveEnabled: true,
  reason: 'EFFECTIVE_ENABLED',
  missingDependencies: [],
};

const ENTITLEMENT_DISABLED = {
  moduleKey: 'accounting',
  implementationStatus: 'AVAILABLE',
  configured: true,
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'COMMERCIALLY_DISABLED',
  missingDependencies: [],
};

const ENTITLEMENT_NOT_CONFIGURED = {
  moduleKey: 'accounting',
  implementationStatus: 'AVAILABLE',
  configured: false,
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'NOT_CONFIGURED',
  missingDependencies: [],
};

let testMembershipRole: 'company_admin' | 'employee' | 'viewer' = 'company_admin';

function workflowRequest(companyId: string): NextRequest {
  return new NextRequest(`http://localhost/api/dashboard/workflow-status?companyId=${companyId}`);
}

function accountsPostRequest(companyId: string): NextRequest {
  return new NextRequest(`http://localhost/api/accounts?companyId=${companyId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '1000', name: 'Cash', accountType: 'asset' }),
  });
}

describe('accounting commercial entitlement enforcement (11D-B)', () => {
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
      async (args: { select?: { id?: boolean; role?: boolean } }) =>
        args.select?.role ? { role: testMembershipRole } : { id: 'member-1' },
    );
    mockDbCount.mockResolvedValue(0);
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_OK);
  });

  it('A1: GET accounting effective → allowed (200)', async () => {
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_OK);

    const res = await getWorkflowStatus(workflowRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toEqual({ completed: false, count: 0 });
  });

  it('A2: GET accounting disabled → 403 MODULE_NOT_ENTITLED', async () => {
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_DISABLED);

    const res = await getWorkflowStatus(workflowRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
  });

  it('A3: GET accounting NOT_CONFIGURED → 403 MODULE_NOT_ENTITLED', async () => {
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_NOT_CONFIGURED);

    const res = await getWorkflowStatus(workflowRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
  });

  it('A4: POST accounting disabled → 403 MODULE_NOT_ENTITLED', async () => {
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_DISABLED);

    const res = await postAccount(accountsPostRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MODULE_NOT_ENTITLED');
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-1', 'accounting');
  });

  it('A5: entitlement enabled but RBAC denies → FORBIDDEN from prior security, entitlement never consulted', async () => {
    testMembershipRole = 'viewer';
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_OK);

    const res = await postAccount(accountsPostRequest('tenant-1'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
    expect(mockResolveEntitlement).not.toHaveBeenCalled();
  });

  it('A6: guard resolves entitlement for the active tenant company from context', async () => {
    mockResolveEntitlement.mockResolvedValue(ENTITLEMENT_OK);

    const res = await getWorkflowStatus(workflowRequest('tenant-6'), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
    expect(mockResolveEntitlement).toHaveBeenCalledWith('tenant-6', 'accounting');
  });
});
