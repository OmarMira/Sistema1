import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModuleEntitlementError } from '@/lib/api-error';
import type { ModuleEntitlementResult } from '@/lib/services/module-entitlement-engine';

vi.mock('@/lib/services/module-entitlement-engine', () => ({
  resolveCompanyModuleEntitlement: vi.fn(),
}));

vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(),
}));

import { resolveCompanyModuleEntitlement } from '@/lib/services/module-entitlement-engine';
import { requireCompanyContext } from '@/lib/context-storage';
import {
  assertCompanyModuleEntitlement,
  requireModuleEntitlement,
} from '@/lib/module-entitlement-guard';

const mockedResolve = vi.mocked(resolveCompanyModuleEntitlement);
const mockedContext = vi.mocked(requireCompanyContext);

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

function entitlementResult(
  overrides: Partial<ModuleEntitlementResult> = {},
): ModuleEntitlementResult {
  return {
    moduleKey: 'accounting',
    implementationStatus: 'AVAILABLE',
    configured: true,
    commercialEnabled: true,
    effectiveEnabled: true,
    reason: 'EFFECTIVE_ENABLED',
    missingDependencies: [],
    ...overrides,
  };
}

async function captureError(
  promise: Promise<unknown>,
): Promise<ModuleEntitlementError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as ModuleEntitlementError;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('module-entitlement-guard', () => {
  // T1
  it('T1: EFFECTIVE_ENABLED with effectiveEnabled=true → allows and returns the resolution', async () => {
    const resolution = entitlementResult();
    mockedResolve.mockResolvedValueOnce(resolution);

    const result = await assertCompanyModuleEntitlement(COMPANY_A, 'accounting');

    expect(result).toBe(resolution);
    expect(result.effectiveEnabled).toBe(true);
    expect(mockedResolve).toHaveBeenCalledWith(COMPANY_A, 'accounting');
  });

  // T2
  it('T2: COMMERCIALLY_DISABLED → 403 MODULE_NOT_ENTITLED', async () => {
    mockedResolve.mockResolvedValueOnce(
      entitlementResult({
        effectiveEnabled: false,
        commercialEnabled: false,
        reason: 'COMMERCIALLY_DISABLED',
      }),
    );

    const error = await captureError(
      assertCompanyModuleEntitlement(COMPANY_A, 'accounting'),
    );

    expect(error).toBeInstanceOf(ModuleEntitlementError);
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('MODULE_NOT_ENTITLED');
  });

  // T3
  it('T3: NOT_CONFIGURED → 403 MODULE_NOT_ENTITLED', async () => {
    mockedResolve.mockResolvedValueOnce(
      entitlementResult({
        effectiveEnabled: false,
        configured: false,
        commercialEnabled: false,
        reason: 'NOT_CONFIGURED',
      }),
    );

    const error = await captureError(
      assertCompanyModuleEntitlement(COMPANY_A, 'banking'),
    );

    expect(error).toBeInstanceOf(ModuleEntitlementError);
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('MODULE_NOT_ENTITLED');
  });

  // T4
  it('T4: IMPLEMENTATION_UNAVAILABLE → 403 MODULE_UNAVAILABLE', async () => {
    mockedResolve.mockResolvedValueOnce(
      entitlementResult({
        effectiveEnabled: false,
        implementationStatus: 'UNAVAILABLE',
        reason: 'IMPLEMENTATION_UNAVAILABLE',
      }),
    );

    const error = await captureError(
      assertCompanyModuleEntitlement(COMPANY_A, 'inventory'),
    );

    expect(error).toBeInstanceOf(ModuleEntitlementError);
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('MODULE_UNAVAILABLE');
  });

  // T5
  it('T5: MISSING_DEPENDENCY → 403 MODULE_DEPENDENCY_MISSING', async () => {
    mockedResolve.mockResolvedValueOnce(
      entitlementResult({
        effectiveEnabled: false,
        reason: 'MISSING_DEPENDENCY',
        missingDependencies: ['accounting'],
      }),
    );

    const error = await captureError(
      assertCompanyModuleEntitlement(COMPANY_A, 'banking'),
    );

    expect(error).toBeInstanceOf(ModuleEntitlementError);
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('MODULE_DEPENDENCY_MISSING');
    expect(error?.details).toMatchObject({ missingDependencies: ['accounting'] });
  });

  // T6
  it('T6: requireModuleEntitlement uses exactly the companyId from requireCompanyContext()', async () => {
    mockedContext.mockReturnValueOnce({ userId: 'user-1', companyId: 'company-from-context' });
    mockedResolve.mockResolvedValueOnce(entitlementResult());

    const result = await requireModuleEntitlement('accounting');

    expect(mockedContext).toHaveBeenCalledTimes(1);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    expect(mockedResolve).toHaveBeenCalledWith('company-from-context', 'accounting');
    expect(result.effectiveEnabled).toBe(true);
  });

  // T7
  it('T7: explicit companyId A then B is transmitted exactly per call (no tenant reuse)', async () => {
    mockedResolve.mockResolvedValueOnce(entitlementResult());
    await assertCompanyModuleEntitlement(COMPANY_A, 'accounting');
    expect(mockedResolve).toHaveBeenLastCalledWith(COMPANY_A, 'accounting');

    mockedResolve.mockResolvedValueOnce(entitlementResult({ moduleKey: 'banking' }));
    await assertCompanyModuleEntitlement(COMPANY_B, 'banking');
    expect(mockedResolve).toHaveBeenLastCalledWith(COMPANY_B, 'banking');

    expect(mockedResolve).toHaveBeenCalledTimes(2);
    expect(mockedContext).not.toHaveBeenCalled();
  });

  // Fail closed: inconsistent EFFECTIVE_ENABLED
  it('fail-closed: EFFECTIVE_ENABLED with effectiveEnabled=false → MODULE_NOT_ENTITLED', async () => {
    mockedResolve.mockResolvedValueOnce(
      entitlementResult({
        effectiveEnabled: false,
        reason: 'EFFECTIVE_ENABLED',
      }),
    );

    const error = await captureError(
      assertCompanyModuleEntitlement(COMPANY_A, 'accounting'),
    );

    expect(error).toBeInstanceOf(ModuleEntitlementError);
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('MODULE_NOT_ENTITLED');
  });

  // Fail closed: unknown/unexpected reason
  it('fail-closed: unknown reason → MODULE_NOT_ENTITLED', async () => {
    const unexpected = {
      ...entitlementResult({ effectiveEnabled: false }),
      reason: 'SOME_FUTURE_REASON',
    } as ModuleEntitlementResult;
    mockedResolve.mockResolvedValueOnce(unexpected);

    const error = await captureError(
      assertCompanyModuleEntitlement(COMPANY_A, 'accounting'),
    );

    expect(error).toBeInstanceOf(ModuleEntitlementError);
    expect(error).not.toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('MODULE_NOT_ENTITLED');
  });
});
