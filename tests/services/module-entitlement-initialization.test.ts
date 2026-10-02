import { describe, it, expect } from 'vitest';
import type { Prisma } from '@prisma/client';
import { initializeDefaultCompanyModuleEntitlements } from '@/lib/services/module-entitlement-initialization';

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

interface FakeUpsertArgs {
  where: { companyId_moduleKey: { companyId: string; moduleKey: string } };
  create: Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>;
  update: Partial<Omit<EntitlementRow, 'id' | 'createdAt' | 'updatedAt'>>;
}

interface FakeStore {
  rows: EntitlementRow[];
}

function createFakeTx(store: FakeStore): Prisma.TransactionClient {
  let idCounter = 0;
  const fake = {
    companyModuleEntitlement: {
      upsert: async ({ where, create, update }: FakeUpsertArgs): Promise<EntitlementRow> => {
        const target = where.companyId_moduleKey;
        const existing = store.rows.find(
          (row) => row.companyId === target.companyId && row.moduleKey === target.moduleKey,
        );
        if (existing) {
          // Apply the update payload verbatim: an empty update (the
          // initializer's idempotency guarantee) must change nothing.
          Object.assign(existing, update);
          return existing;
        }
        const now = new Date();
        const row: EntitlementRow = {
          id: `row-${++idCounter}`,
          createdAt: now,
          updatedAt: now,
          ...create,
        };
        store.rows.push(row);
        return row;
      },
    },
  };
  return fake as unknown as Prisma.TransactionClient;
}

function rowsFor(store: FakeStore, companyId: string): EntitlementRow[] {
  return store.rows.filter((row) => row.companyId === companyId);
}

function byModuleKey(rows: EntitlementRow[]): Map<string, EntitlementRow> {
  return new Map(rows.map((row) => [row.moduleKey, row]));
}

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

describe('module-entitlement-initialization', () => {
  // I1
  it('initializing an empty company creates exactly 5 rows', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    expect(store.rows).toHaveLength(5);
    expect(new Set(store.rows.map((row) => row.moduleKey)).size).toBe(5);
  });

  // I2
  it('accounting defaults to enabled=true', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    expect(byModuleKey(rowsFor(store, COMPANY_A)).get('accounting')?.enabled).toBe(true);
  });

  // I3
  it('banking defaults to enabled=true', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    expect(byModuleKey(rowsFor(store, COMPANY_A)).get('banking')?.enabled).toBe(true);
  });

  // I4
  it('purchases defaults to enabled=false', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    expect(byModuleKey(rowsFor(store, COMPANY_A)).get('purchases')?.enabled).toBe(false);
  });

  // I5
  it('sales defaults to enabled=false', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    expect(byModuleKey(rowsFor(store, COMPANY_A)).get('sales')?.enabled).toBe(false);
  });

  // I6
  it('inventory defaults to enabled=false', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    expect(byModuleKey(rowsFor(store, COMPANY_A)).get('inventory')?.enabled).toBe(false);
  });

  // I7
  it('enabled rows have activatedAt not null and deactivatedAt null', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    const rows = byModuleKey(rowsFor(store, COMPANY_A));
    for (const key of ['accounting', 'banking']) {
      expect(rows.get(key)?.activatedAt).not.toBeNull();
      expect(rows.get(key)?.deactivatedAt).toBeNull();
    }
  });

  // I8
  it('disabled rows have activatedAt null and deactivatedAt null', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    const rows = byModuleKey(rowsFor(store, COMPANY_A));
    for (const key of ['purchases', 'sales', 'inventory']) {
      expect(rows.get(key)?.activatedAt).toBeNull();
      expect(rows.get(key)?.deactivatedAt).toBeNull();
    }
  });

  // I9
  it('running the initializer twice keeps exactly 5 rows with unchanged values (idempotent)', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);
    const snapshot = structuredClone(store.rows);

    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);

    expect(store.rows).toHaveLength(5);
    expect(store.rows).toEqual(snapshot);
  });

  // I10
  it('a pre-existing entitlement row is preserved untouched', async () => {
    const store: FakeStore = { rows: [] };
    const preExistingActivatedAt = new Date('2026-01-15T08:00:00.000Z');
    store.rows.push({
      id: 'pre-existing-sales',
      companyId: COMPANY_A,
      moduleKey: 'sales',
      enabled: true,
      activatedAt: preExistingActivatedAt,
      deactivatedAt: null,
      createdAt: new Date('2026-01-15T08:00:00.000Z'),
      updatedAt: new Date('2026-01-15T08:00:00.000Z'),
    });

    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);

    const salesRow = byModuleKey(rowsFor(store, COMPANY_A)).get('sales');
    expect(store.rows).toHaveLength(5); // 1 pre-existing sales + 4 newly created
    expect(salesRow?.enabled).toBe(true);
    expect(salesRow?.activatedAt).toEqual(preExistingActivatedAt);
    expect(salesRow?.id).toBe('pre-existing-sales');
  });

  // I11
  it('tenant isolation: each company gets its own independent 5-row set', async () => {
    const store: FakeStore = { rows: [] };
    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_A);

    expect(rowsFor(store, COMPANY_A)).toHaveLength(5);
    expect(rowsFor(store, COMPANY_B)).toHaveLength(0);

    await initializeDefaultCompanyModuleEntitlements(createFakeTx(store), COMPANY_B);

    expect(rowsFor(store, COMPANY_A)).toHaveLength(5);
    expect(rowsFor(store, COMPANY_B)).toHaveLength(5);
    expect(store.rows).toHaveLength(10);
    expect(rowsFor(store, COMPANY_A).every((row) => row.companyId === COMPANY_A)).toBe(true);
    expect(rowsFor(store, COMPANY_B).every((row) => row.companyId === COMPANY_B)).toBe(true);
  });
});
