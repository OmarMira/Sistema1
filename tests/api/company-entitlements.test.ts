import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireActiveTenantAccess: vi.fn(),
  userFindUnique: vi.fn(),
  listCompanyModuleEntitlements: vi.fn(),
  members: new Set<string>(),
  authorityCompanyId: undefined as string | undefined,
  rawContext: { current: undefined as { userId: string; companyId: string } | undefined },
}));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: h.getSessionUserId }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, limit: 100, remaining: 99, resetAt: 999999 })),
}));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/rbac', () => ({ requireActiveTenantAccess: h.requireActiveTenantAccess }));
vi.mock('@/lib/db', () => ({
  db: { user: { findUnique: h.userFindUnique } },
}));
vi.mock('@/lib/context-storage', () => ({
  requestContext: {
    run: async (ctx: { userId: string; companyId: string }, fn: () => unknown) => {
      h.rawContext.current = ctx;
      try {
        return await fn();
      } finally {
        h.rawContext.current = undefined;
      }
    },
  },
  getRequestContext: () => h.rawContext.current,
  requireCompanyContext: () => {
    const ctx = h.rawContext.current;
    if (!ctx?.companyId) {
      throw Object.assign(new Error('Company context required'), {
        statusCode: 403,
        code: 'COMPANY_CONTEXT_REQUIRED',
      });
    }
    return { userId: ctx.userId, companyId: h.authorityCompanyId ?? ctx.companyId };
  },
  requireCurrentUserId: () => {
    const ctx = h.rawContext.current;
    if (!ctx?.userId) throw new Error('AUTH_REQUIRED');
    return ctx.userId;
  },
}));
vi.mock('@/lib/services/module-entitlements.service', () => ({
  listCompanyModuleEntitlements: h.listCompanyModuleEntitlements,
  getCompanyModuleEntitlement: vi.fn(),
  enableCompanyModule: vi.fn(),
  disableCompanyModule: vi.fn(),
}));

import { GET } from '@/app/api/company/entitlements/route';
import * as routeModule from '@/app/api/company/entitlements/route';
import {
  listCompanyModuleEntitlements,
  enableCompanyModule,
  disableCompanyModule,
} from '@/lib/services/module-entitlements.service';

const ROUTE_CONTEXT = { params: Promise.resolve({}) };

function getRequest(companyId: string) {
  return new NextRequest(
    `http://localhost/api/company/entitlements?companyId=${encodeURIComponent(companyId)}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.members.clear();
  h.authorityCompanyId = undefined;
  h.rawContext.current = undefined;
  h.getSessionUserId.mockResolvedValue('user-1');
  h.userFindUnique.mockResolvedValue({ platformRole: 'company_admin' });
  h.requireActiveTenantAccess.mockImplementation(async (companyId: string) => {
    if (!h.members.has(companyId)) {
      throw Object.assign(new Error('Forbidden tenant'), {
        statusCode: 403,
        code: 'TENANT_ACCESS_DENIED',
      });
    }
  });
  h.listCompanyModuleEntitlements.mockResolvedValue([]);
});

describe('GET /api/company/entitlements — read-only nav entitlement endpoint', () => {
  it('endpoint is read-only: exports GET only, no mutation paths', () => {
    expect(typeof routeModule.GET).toBe('function');
    expect(routeModule.POST).toBeUndefined();
    expect(routeModule.PUT).toBeUndefined();
    expect(routeModule.PATCH).toBeUndefined();
    expect(routeModule.DELETE).toBeUndefined();
  });

  it('T12: response companyId comes from requireCompanyContext, never from the query parameter', async () => {
    h.members.add('company-query-requested');
    h.authorityCompanyId = 'company-context-authorized';
    h.listCompanyModuleEntitlements.mockResolvedValue([
      { moduleKey: 'accounting', enabled: true },
    ]);

    const response = await GET(getRequest('company-query-requested'), ROUTE_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.companyId).toBe('company-context-authorized');
    expect(body.companyId).not.toBe('company-query-requested');
    expect(listCompanyModuleEntitlements).toHaveBeenCalledTimes(1);
    expect(listCompanyModuleEntitlements).toHaveBeenCalledWith('company-context-authorized');
  });

  it('T13: arbitrary companyId without membership cannot select another tenant', async () => {
    h.members.add('company-own');
    h.listCompanyModuleEntitlements.mockResolvedValue([
      { moduleKey: 'accounting', enabled: true },
    ]);

    const response = await GET(getRequest('company-victim'), ROUTE_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBeDefined();
    expect(body.entitlements).toBeUndefined();
    expect(listCompanyModuleEntitlements).not.toHaveBeenCalled();
    expect(h.requireActiveTenantAccess).toHaveBeenCalledWith('company-victim', {
      userId: 'user-1',
      role: 'company_admin',
    });
  });

  it('T14: tenant A only receives rows A; tenant B only receives rows B', async () => {
    h.members.add('company-a');
    h.members.add('company-b');

    const rowsA = [
      { moduleKey: 'accounting', enabled: true },
      { moduleKey: 'banking', enabled: true },
    ];
    const rowsB = [{ moduleKey: 'accounting', enabled: false }];
    h.listCompanyModuleEntitlements.mockImplementation(async (companyId: string) =>
      companyId === 'company-a' ? rowsA : rowsB,
    );

    const responseA = await GET(getRequest('company-a'), ROUTE_CONTEXT);
    const bodyA = await responseA.json();
    expect(responseA.status).toBe(200);
    expect(bodyA.companyId).toBe('company-a');
    expect(bodyA.entitlements).toEqual(rowsA);

    const responseB = await GET(getRequest('company-b'), ROUTE_CONTEXT);
    const bodyB = await responseB.json();
    expect(responseB.status).toBe(200);
    expect(bodyB.companyId).toBe('company-b');
    expect(bodyB.entitlements).toEqual(rowsB);
    expect(bodyA.entitlements).not.toEqual(bodyB.entitlements);

    expect(listCompanyModuleEntitlements).toHaveBeenCalledTimes(2);
    expect(listCompanyModuleEntitlements).toHaveBeenNthCalledWith(1, 'company-a');
    expect(listCompanyModuleEntitlements).toHaveBeenNthCalledWith(2, 'company-b');
    expect(enableCompanyModule).not.toHaveBeenCalled();
    expect(disableCompanyModule).not.toHaveBeenCalled();
  });

  it('response is the minimal nav payload (no extra fields)', async () => {
    h.members.add('company-a');
    h.listCompanyModuleEntitlements.mockResolvedValue([{ moduleKey: 'banking', enabled: true }]);

    const response = await GET(getRequest('company-a'), ROUTE_CONTEXT);
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(['companyId', 'entitlements']);
    expect(Object.keys(body.entitlements[0]).sort()).toEqual(['enabled', 'moduleKey']);
  });

  it('uses exactly one entitlement read per request (batch, no per-module queries)', async () => {
    h.members.add('company-a');
    h.listCompanyModuleEntitlements.mockResolvedValue([]);

    await GET(getRequest('company-a'), ROUTE_CONTEXT);

    expect(listCompanyModuleEntitlements).toHaveBeenCalledTimes(1);
  });
});
