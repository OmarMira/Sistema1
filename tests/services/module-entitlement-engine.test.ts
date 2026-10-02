import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '@/lib/api-error';

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

const store: EntitlementRow[] = [];
let idCounter = 0;

function matches(row: EntitlementRow, where: { companyId?: string; moduleKey?: string }): boolean {
  if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
  if (where.moduleKey !== undefined && row.moduleKey !== where.moduleKey) return false;
  return true;
}

vi.mock('@/lib/db', () => ({
  db: {
    companyModuleEntitlement: {
      findFirst: vi.fn(async ({ where }: { where: { companyId: string; moduleKey: string } }) =>
        store.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { companyId: string } }) =>
        store.filter((row) => matches(row, where)),
      ),
    },
  },
}));

import { resolveCompanyModuleEntitlement } from '@/lib/services/module-entitlement-engine';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

function seedEntitlement(companyId: string, moduleKey: string, enabled: boolean): void {
  const now = new Date('2026-10-02T12:00:00.000Z');
  store.push({
    id: `row-${++idCounter}`,
    companyId,
    moduleKey,
    enabled,
    activatedAt: enabled ? now : null,
    deactivatedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(() => {
  store.length = 0;
  idCounter = 0;
});

describe('module-entitlement-engine', () => {
  // B1
  it('AVAILABLE module with enabled row and no dependencies → EFFECTIVE_ENABLED', async () => {
    seedEntitlement(COMPANY_A, 'accounting', true);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'accounting');
    expect(result).toEqual({
      moduleKey: 'accounting',
      implementationStatus: 'AVAILABLE',
      configured: true,
      commercialEnabled: true,
      effectiveEnabled: true,
      reason: 'EFFECTIVE_ENABLED',
      missingDependencies: [],
    });
  });

  // B2
  it('enabled=false row → COMMERCIALLY_DISABLED, not effective, still configured', async () => {
    seedEntitlement(COMPANY_A, 'accounting', false);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'accounting');
    expect(result.reason).toBe('COMMERCIALLY_DISABLED');
    expect(result.effectiveEnabled).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.commercialEnabled).toBe(false);
    expect(result.missingDependencies).toEqual([]);
  });

  // B3
  it('no entitlement row → NOT_CONFIGURED with configured=false', async () => {
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'accounting');
    expect(result.reason).toBe('NOT_CONFIGURED');
    expect(result.configured).toBe(false);
    expect(result.commercialEnabled).toBe(false);
    expect(result.effectiveEnabled).toBe(false);
    expect(result.missingDependencies).toEqual([]);
  });

  // B4
  it('UNAVAILABLE module with enabled=true row → IMPLEMENTATION_UNAVAILABLE (checked before disabled)', async () => {
    seedEntitlement(COMPANY_A, 'inventory', true);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'inventory');
    expect(result.reason).toBe('IMPLEMENTATION_UNAVAILABLE');
    expect(result.effectiveEnabled).toBe(false);
    expect(result.commercialEnabled).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.implementationStatus).toBe('UNAVAILABLE');
    expect(result.missingDependencies).toEqual([]);
  });

  // B5
  it('PARTIAL module with enabled row and satisfied dependency → EFFECTIVE_ENABLED with status PARTIAL', async () => {
    seedEntitlement(COMPANY_A, 'purchases', true);
    seedEntitlement(COMPANY_A, 'accounting', true);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'purchases');
    expect(result.effectiveEnabled).toBe(true);
    expect(result.reason).toBe('EFFECTIVE_ENABLED');
    expect(result.implementationStatus).toBe('PARTIAL');
    expect(result.missingDependencies).toEqual([]);
  });

  // B6
  it('banking enabled + accounting effective → banking EFFECTIVE_ENABLED', async () => {
    seedEntitlement(COMPANY_A, 'banking', true);
    seedEntitlement(COMPANY_A, 'accounting', true);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'banking');
    expect(result.moduleKey).toBe('banking');
    expect(result.effectiveEnabled).toBe(true);
    expect(result.reason).toBe('EFFECTIVE_ENABLED');
    expect(result.missingDependencies).toEqual([]);
  });

  // B7
  it('banking enabled + accounting NOT_CONFIGURED → MISSING_DEPENDENCY [accounting]', async () => {
    seedEntitlement(COMPANY_A, 'banking', true);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'banking');
    expect(result.reason).toBe('MISSING_DEPENDENCY');
    expect(result.missingDependencies).toEqual(['accounting']);
    expect(result.effectiveEnabled).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.commercialEnabled).toBe(true);
  });

  // B8
  it('tenant isolation: company A effective while company B has no rows → NOT_CONFIGURED', async () => {
    seedEntitlement(COMPANY_A, 'accounting', true);
    const resultA = await resolveCompanyModuleEntitlement(COMPANY_A, 'accounting');
    const resultB = await resolveCompanyModuleEntitlement(COMPANY_B, 'accounting');
    expect(resultA.effectiveEnabled).toBe(true);
    expect(resultA.reason).toBe('EFFECTIVE_ENABLED');
    expect(resultB.reason).toBe('NOT_CONFIGURED');
    expect(resultB.configured).toBe(false);
    expect(resultB.effectiveEnabled).toBe(false);
  });

  // B9
  it('unknown module key → throws ValidationError', async () => {
    await expect(
      resolveCompanyModuleEntitlement(COMPANY_A, 'not-a-module'),
    ).rejects.toThrow(ValidationError);
    await expect(resolveCompanyModuleEntitlement(COMPANY_A, 'not-a-module')).rejects.toThrow(
      'Unknown module key: not-a-module',
    );
  });

  // B10
  it('deterministic: two identical calls return deep-equal results', async () => {
    seedEntitlement(COMPANY_A, 'purchases', true);
    seedEntitlement(COMPANY_A, 'accounting', true);
    const first = await resolveCompanyModuleEntitlement(COMPANY_A, 'purchases');
    const second = await resolveCompanyModuleEntitlement(COMPANY_A, 'purchases');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  // B11
  it('purchases enabled + accounting disabled → MISSING_DEPENDENCY [accounting]', async () => {
    seedEntitlement(COMPANY_A, 'purchases', true);
    seedEntitlement(COMPANY_A, 'accounting', false);
    const result = await resolveCompanyModuleEntitlement(COMPANY_A, 'purchases');
    expect(result.reason).toBe('MISSING_DEPENDENCY');
    expect(result.missingDependencies).toEqual(['accounting']);
    expect(result.effectiveEnabled).toBe(false);
  });

  // B12
  it('sales enabled + accounting missing or disabled → MISSING_DEPENDENCY [accounting]', async () => {
    seedEntitlement(COMPANY_A, 'sales', true);
    const missingAccounting = await resolveCompanyModuleEntitlement(COMPANY_A, 'sales');
    expect(missingAccounting.reason).toBe('MISSING_DEPENDENCY');
    expect(missingAccounting.missingDependencies).toEqual(['accounting']);

    seedEntitlement(COMPANY_A, 'accounting', false);
    const disabledAccounting = await resolveCompanyModuleEntitlement(COMPANY_A, 'sales');
    expect(disabledAccounting.reason).toBe('MISSING_DEPENDENCY');
    expect(disabledAccounting.missingDependencies).toEqual(['accounting']);
    expect(disabledAccounting.effectiveEnabled).toBe(false);
  });
});
