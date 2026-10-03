// GAP #11D-D — SSR commercial entitlement on the accounts page (S1–S3).
//
// S1 accounting effective => the SSR query runs
// S2 accounting disabled  => blocked before db.glAccount.findMany
// S3 the companyId passed to the entitlement check is exactly the SSR-
//     validated context value, never the raw cookie candidate
//
// The guard is NOT mocked. The 11B engine is instrumented as a spy, the same
// authorized pattern used by the API enforcement suites. The page stays a
// server component; no UI behaviour is changed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveEntitlement = vi.hoisted(() => vi.fn());
const mockGlAccountFindMany = vi.hoisted(() => vi.fn());
const mockRequireSsrCompanyContext = vi.hoisted(() => vi.fn());
const mockCookiesGet = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/module-entitlement-engine', () => ({
  resolveCompanyModuleEntitlement: mockResolveEntitlement,
}));
vi.mock('@/lib/db', () => ({
  db: { glAccount: { findMany: mockGlAccountFindMany } },
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: mockCookiesGet })),
}));
vi.mock('@/lib/ssr-context', () => ({
  requireSsrCompanyContext: mockRequireSsrCompanyContext,
}));
vi.mock('@/components/spa/AccountsClient', () => ({ AccountsClient: () => null }));
vi.mock('@/components/spa/AppShell', () => ({
  AppShell: ({ children }: { children?: unknown }) => children,
}));

import AccountsServerPage from '@/app/accounts/page';

const COOKIE_CANDIDATE = 'cookie-raw-candidate';
const VALIDATED_COMPANY_ID = 'validated-123';

const ACCOUNTING_EFFECTIVE = {
  moduleKey: 'accounting',
  implementationStatus: 'AVAILABLE',
  configured: true,
  commercialEnabled: true,
  effectiveEnabled: true,
  reason: 'EFFECTIVE_ENABLED',
  missingDependencies: [],
};

const ACCOUNTING_NOT_ENTITLED = {
  moduleKey: 'accounting',
  implementationStatus: 'AVAILABLE',
  configured: false,
  commercialEnabled: false,
  effectiveEnabled: false,
  reason: 'NOT_CONFIGURED',
  missingDependencies: [],
};

describe('accounts SSR commercial entitlement (11D-D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookiesGet.mockImplementation((name: string) =>
      name === 'companyId' ? { value: COOKIE_CANDIDATE } : undefined,
    );
    mockRequireSsrCompanyContext.mockResolvedValue({
      ok: true,
      userId: 'user-1',
      companyId: VALIDATED_COMPANY_ID,
    });
    mockResolveEntitlement.mockResolvedValue(ACCOUNTING_EFFECTIVE);
    mockGlAccountFindMany.mockResolvedValue([]);
  });

  it('S1: accounting effective => the SSR query runs', async () => {
    await AccountsServerPage();

    expect(mockGlAccountFindMany).toHaveBeenCalledTimes(1);
    expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
  });

  it('S2: accounting not entitled => blocked before db.glAccount.findMany', async () => {
    mockResolveEntitlement.mockResolvedValue(ACCOUNTING_NOT_ENTITLED);

    await AccountsServerPage();

    expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
    expect(mockGlAccountFindMany).not.toHaveBeenCalled();
  });

  it('S3: entitlement receives exactly the SSR-validated companyId, not the cookie candidate', async () => {
    await AccountsServerPage();

    // The page asks SSR validation with the raw cookie candidate...
    expect(mockRequireSsrCompanyContext).toHaveBeenCalledWith(COOKIE_CANDIDATE);
    // ...and hands ONLY the validated context value to the entitlement check.
    expect(mockResolveEntitlement).toHaveBeenCalledWith(VALIDATED_COMPANY_ID, 'accounting');
    expect(mockResolveEntitlement).not.toHaveBeenCalledWith(COOKIE_CANDIDATE, 'accounting');
    // The query, when allowed, stays scoped to the validated tenant.
    expect(mockGlAccountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: VALIDATED_COMPANY_ID } }),
    );
  });
});
