import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      findMany: vi.fn(async ({ where }: { where: { companyId: string } }) =>
        store.filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(async ({ where }: { where: { companyId: string; moduleKey: string } }) =>
        store.find((row) => matches(row, where)) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { companyId_moduleKey: { companyId: string; moduleKey: string } };
          create: Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>;
          update: Partial<Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>>;
        }) => {
          const target = where.companyId_moduleKey;
          const existing = store.find(
            (row) => row.companyId === target.companyId && row.moduleKey === target.moduleKey,
          );
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const now = new Date();
          const row: EntitlementRow = {
            id: `row-${++idCounter}`,
            createdAt: now,
            updatedAt: now,
            ...create,
          };
          store.push(row);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { companyId: string; moduleKey: string };
          data: Partial<Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>>;
        }) => {
          const targets = store.filter((row) => matches(row, where));
          for (const row of targets) {
            Object.assign(row, data, { updatedAt: new Date() });
          }
          return { count: targets.length };
        },
      ),
    },
  },
}));

import {
  listCompanyModuleEntitlements,
  getCompanyModuleEntitlement,
  enableCompanyModule,
  disableCompanyModule,
} from '@/lib/services/module-entitlements.service';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

beforeEach(() => {
  store.length = 0;
  idCounter = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('module-entitlements.service', () => {
  // E1
  it('enable creates an entitlement for tenant A', async () => {
    await enableCompanyModule(COMPANY_A, 'accounting');
    expect(store).toHaveLength(1);
    expect(store[0].companyId).toBe(COMPANY_A);
    expect(store[0].moduleKey).toBe('accounting');
  });

  // E2
  it('get for tenant A returns the correct row', async () => {
    await enableCompanyModule(COMPANY_A, 'banking');
    const row = await getCompanyModuleEntitlement(COMPANY_A, 'banking');
    expect(row).not.toBeNull();
    expect(row?.companyId).toBe(COMPANY_A);
    expect(row?.moduleKey).toBe('banking');
  });

  // E3
  it("tenant B cannot obtain tenant A's row (query is company-scoped)", async () => {
    await enableCompanyModule(COMPANY_A, 'sales');
    expect(await getCompanyModuleEntitlement(COMPANY_B, 'sales')).toBeNull();
    expect(await listCompanyModuleEntitlements(COMPANY_B)).toHaveLength(0);
    expect(await listCompanyModuleEntitlements(COMPANY_A)).toHaveLength(1);
  });

  // E4
  it('logical duplicate prevented: enabling the same key twice keeps exactly ONE row', async () => {
    await enableCompanyModule(COMPANY_A, 'purchases');
    await enableCompanyModule(COMPANY_A, 'purchases');
    expect(store).toHaveLength(1);
  });

  // E5
  it('the same moduleKey can exist in two different companies', async () => {
    await enableCompanyModule(COMPANY_A, 'inventory');
    await enableCompanyModule(COMPANY_B, 'inventory');
    expect(store).toHaveLength(2);
    expect(new Set(store.map((row) => row.companyId)).size).toBe(2);
  });

  // E6
  it('after enable: enabled=true, activatedAt not null, deactivatedAt null', async () => {
    const row = await enableCompanyModule(COMPANY_A, 'accounting');
    expect(row.enabled).toBe(true);
    expect(row.activatedAt).not.toBeNull();
    expect(row.deactivatedAt).toBeNull();
  });

  // E7
  it('after disable: enabled=false, deactivatedAt not null', async () => {
    await enableCompanyModule(COMPANY_A, 'accounting');
    const { count } = await disableCompanyModule(COMPANY_A, 'accounting');
    expect(count).toBe(1);
    const row = store[0];
    expect(row.enabled).toBe(false);
    expect(row.deactivatedAt).not.toBeNull();
  });

  // E8
  it('disable preserves the previous activatedAt value', async () => {
    await enableCompanyModule(COMPANY_A, 'accounting');
    const activatedBefore = store[0].activatedAt;

    vi.setSystemTime(new Date('2026-10-02T18:00:00.000Z'));
    await disableCompanyModule(COMPANY_A, 'accounting');

    expect(store[0].activatedAt).toEqual(activatedBefore);
  });

  // E9
  it('re-enable: enabled=true, activatedAt updated to the new time, deactivatedAt null', async () => {
    await enableCompanyModule(COMPANY_A, 'accounting');
    const firstActivation = store[0].activatedAt;

    vi.setSystemTime(new Date('2026-10-03T09:30:00.000Z'));
    await disableCompanyModule(COMPANY_A, 'accounting');
    const row = await enableCompanyModule(COMPANY_A, 'accounting');

    expect(row.enabled).toBe(true);
    expect(row.deactivatedAt).toBeNull();
    expect(row.activatedAt).toEqual(new Date('2026-10-03T09:30:00.000Z'));
    expect(row.activatedAt).not.toEqual(firstActivation);
  });

  // E10
  it('list returns ONLY rows of the requested company', async () => {
    await enableCompanyModule(COMPANY_A, 'accounting');
    await enableCompanyModule(COMPANY_A, 'banking');
    await enableCompanyModule(COMPANY_B, 'accounting');

    const rowsA = await listCompanyModuleEntitlements(COMPANY_A);
    const rowsB = await listCompanyModuleEntitlements(COMPANY_B);

    expect(rowsA).toHaveLength(2);
    expect(rowsA.every((row) => row.companyId === COMPANY_A)).toBe(true);
    expect(rowsB).toHaveLength(1);
    expect(rowsB.every((row) => row.companyId === COMPANY_B)).toBe(true);
  });
});
