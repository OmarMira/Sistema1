import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDatabase,
  createTestCompany,
  createTestGlAccount,
} from '../helpers/factories';
import { saveContext } from '@/lib/services/entity-context-service';
import {
  listEntityContexts,
  updateEntityContext,
  removeEntityContext,
  bulkRemoveEntityContexts,
} from '@/lib/services/entity-context-crud-service';
import { db } from '@/lib/db';

describe('listEntityContexts()', () => {
  let companyId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    await clearDatabase();
    const co = await createTestCompany('CRUD Test Co');
    companyId = co.id;
    const other = await createTestCompany('Other Co');
    otherCompanyId = other.id;

    // Seed 4 contexts in companyId
    await saveContext({ companyId, pattern: 'UBER', role: 'GASTO_OPERATIVO' });
    await saveContext({ companyId, pattern: 'LYFT', role: 'GASTO_OPERATIVO' });
    await saveContext({ companyId, pattern: 'HOME DEPOT', role: 'PROVEEDOR' });
    await saveContext({ companyId, pattern: 'TURO', role: 'INGRESO' });
    // Seed 1 in other company
    await saveContext({ companyId: otherCompanyId, pattern: 'AMAZON', role: 'PROVEEDOR' });
  });

  it('returns paginated results with total count', async () => {
    const result = await listEntityContexts(companyId, 1, 10);
    expect(result.data).toHaveLength(4);
    expect(result.pagination.total).toBe(4);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.limit).toBe(10);
    expect(result.pagination.totalPages).toBe(1);
  });

  it('paginates correctly with small limit', async () => {
    const page1 = await listEntityContexts(companyId, 1, 2);
    expect(page1.data).toHaveLength(2);
    expect(page1.pagination.totalPages).toBe(2);

    const page2 = await listEntityContexts(companyId, 2, 2);
    expect(page2.data).toHaveLength(2);
    expect(page2.pagination.page).toBe(2);

    // Different data on each page (sorted by createdAt desc by default)
    const ids1 = page1.data.map((e) => e.id);
    const ids2 = page2.data.map((e) => e.id);
    expect(ids1).not.toEqual(ids2);
  });

  it('filters by search pattern', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'desc', 'HOME');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].pattern).toBe('home depot');
  });

  it('filters by search partial match', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'desc', 'dep');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].pattern).toBe('home depot');
  });

  it('filters by role', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'desc', undefined, 'GASTO_OPERATIVO');
    expect(result.data).toHaveLength(2);
    expect(result.data.every((e) => e.role === 'GASTO_OPERATIVO')).toBe(true);
  });

  it('returns empty result when search matches nothing', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'desc', 'ZZZZNOMATCH');
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it('returns empty result when role matches nothing', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'desc', undefined, 'OTRO');
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it('does NOT include other company contexts', async () => {
    const result = await listEntityContexts(otherCompanyId, 1, 10);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].pattern).toBe('amazon');
  });

  it('sorts by createdAt asc', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'asc');
    expect(result.data).toHaveLength(4);
    // First created should be earliest
    const dates = result.data.map((e) => new Date(e.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
    }
  });

  it('sorts by pattern asc', async () => {
    const result = await listEntityContexts(companyId, 1, 10, 'pattern', 'asc');
    const patterns = result.data.map((e) => e.pattern);
    expect(patterns).toEqual(['home depot', 'lyft', 'turo', 'uber']);
  });

  it('includes glAccount relation when available', async () => {
    const gl = await createTestGlAccount({ companyId, code: '5010', name: 'Proveedores' });
    await saveContext({
      companyId,
      pattern: 'AMAZON',
      role: 'PROVEEDOR',
      glAccountId: gl.id,
    });

    const result = await listEntityContexts(companyId, 1, 10, 'createdAt', 'desc', 'AMAZON');
    expect(result.data[0].glAccount).not.toBeNull();
    expect(result.data[0].glAccount!.code).toBe('5010');
  });
});

describe('updateEntityContext()', () => {
  let companyId: string;
  let otherCompanyId: string;
  let entityId: string;

  beforeEach(async () => {
    await clearDatabase();
    const co = await createTestCompany('Update Test Co');
    companyId = co.id;
    const other = await createTestCompany('Other Co');
    otherCompanyId = other.id;

    const ctx = await saveContext({
      companyId,
      pattern: 'UBER',
      role: 'GASTO_OPERATIVO',
    });
    entityId = ctx.id;
  });

  it('updates role successfully', async () => {
    const updated = await updateEntityContext(companyId, entityId, {
      role: 'INGRESO',
    });

    expect(updated).not.toBeNull();
    expect(updated!.role).toBe('INGRESO');

    // Verify in DB
    const dbCtx = await db.entityContext.findUnique({ where: { id: entityId } });
    expect(dbCtx!.role).toBe('INGRESO');
  });

  it('updates glAccountId', async () => {
    const gl = await createTestGlAccount({ companyId, code: '4010', name: 'Ingresos' });

    const updated = await updateEntityContext(companyId, entityId, {
      glAccountId: gl.id,
    });

    expect(updated!.glAccountId).toBe(gl.id);
    expect(updated!.glAccount).not.toBeNull();
    expect(updated!.glAccount!.code).toBe('4010');
  });

  it('updates roles array as JSON', async () => {
    const updated = await updateEntityContext(companyId, entityId, {
      roles: ['INGRESO', 'GASTO_OPERATIVO'],
    });

    const parsed = JSON.parse(updated!.roles!);
    expect(parsed).toEqual(['INGRESO', 'GASTO_OPERATIVO']);
  });

  it('updates transactionDirection', async () => {
    const updated = await updateEntityContext(companyId, entityId, {
      transactionDirection: 'credit',
    });

    expect(updated!.transactionDirection).toBe('credit');
  });

  it('returns null when entity does not exist', async () => {
    const result = await updateEntityContext(companyId, 'non-existent-id', {
      role: 'INGRESO',
    });
    expect(result).toBeNull();
  });

  it('returns null when entity belongs to a different company', async () => {
    const result = await updateEntityContext(otherCompanyId, entityId, {
      role: 'INGRESO',
    });
    expect(result).toBeNull();

    // Original record should remain unchanged
    const dbCtx = await db.entityContext.findUnique({ where: { id: entityId } });
    expect(dbCtx!.role).toBe('GASTO_OPERATIVO');
  });

  it('throws GL_ACCOUNT_NOT_FOUND when glAccount does not exist', async () => {
    await expect(
      updateEntityContext(companyId, entityId, {
        glAccountId: 'fake-gl-id',
      }),
    ).rejects.toThrow('GL_ACCOUNT_NOT_FOUND');
  });

  it('throws GL_ACCOUNT_NOT_FOUND when glAccount belongs to different company', async () => {
    const otherGl = await createTestGlAccount({ companyId: otherCompanyId, code: '9999', name: 'Other Co GL' });

    await expect(
      updateEntityContext(companyId, entityId, {
        glAccountId: otherGl.id,
      }),
    ).rejects.toThrow('GL_ACCOUNT_NOT_FOUND');
  });

  it('sets glAccountId to null when explicitly passed', async () => {
    const gl = await createTestGlAccount({ companyId, code: '4010', name: 'Ingresos' });
    await updateEntityContext(companyId, entityId, { glAccountId: gl.id });

    // Now clear it
    const updated = await updateEntityContext(companyId, entityId, {
      glAccountId: null,
    });
    expect(updated!.glAccountId).toBeNull();
  });

  it('uppercases the role', async () => {
    const updated = await updateEntityContext(companyId, entityId, {
      role: 'proveedor',
    });
    expect(updated!.role).toBe('PROVEEDOR');
  });
});

describe('removeEntityContext()', () => {
  let companyId: string;
  let otherCompanyId: string;
  let entityId: string;

  beforeEach(async () => {
    await clearDatabase();
    const co = await createTestCompany('Delete Test Co');
    companyId = co.id;
    const other = await createTestCompany('Other Co');
    otherCompanyId = other.id;

    const ctx = await saveContext({
      companyId,
      pattern: 'DELETEME',
      role: 'GASTO_OPERATIVO',
    });
    entityId = ctx.id;
  });

  it('deletes the entity and returns true', async () => {
    const result = await removeEntityContext(companyId, entityId);
    expect(result).toBe(true);

    const dbCtx = await db.entityContext.findUnique({ where: { id: entityId } });
    expect(dbCtx).toBeNull();
  });

  it('returns false when entity does not exist', async () => {
    const result = await removeEntityContext(companyId, 'non-existent');
    expect(result).toBe(false);
  });

  it('returns false when entity belongs to a different company', async () => {
    const result = await removeEntityContext(otherCompanyId, entityId);
    expect(result).toBe(false);

    // Original should still exist
    const dbCtx = await db.entityContext.findUnique({ where: { id: entityId } });
    expect(dbCtx).not.toBeNull();
  });

  it('cannot delete an already-deleted entity', async () => {
    await removeEntityContext(companyId, entityId);
    const result = await removeEntityContext(companyId, entityId);
    expect(result).toBe(false);
  });
});

describe('bulkRemoveEntityContexts()', () => {
  let companyId: string;
  let otherCompanyId: string;
  let ids: string[];

  beforeEach(async () => {
    await clearDatabase();
    const co = await createTestCompany('Bulk Delete Test Co');
    companyId = co.id;
    const other = await createTestCompany('Other Co');
    otherCompanyId = other.id;

    const e1 = await saveContext({ companyId, pattern: 'ENT_1', role: 'GASTO_OPERATIVO' });
    const e2 = await saveContext({ companyId, pattern: 'ENT_2', role: 'PROVEEDOR' });
    const e3 = await saveContext({ companyId, pattern: 'ENT_3', role: 'INGRESO' });
    // One in other company
    await saveContext({ companyId: otherCompanyId, pattern: 'OTHER_ENT', role: 'OTRO' });
    ids = [e1.id, e2.id, e3.id];
  });

  it('deletes multiple entities and returns count', async () => {
    const count = await bulkRemoveEntityContexts(companyId, ids);
    expect(count).toBe(3);

    const remaining = await db.entityContext.findMany({ where: { companyId } });
    expect(remaining).toHaveLength(0);
  });

  it('deletes only entities belonging to the company', async () => {
    // Add an entity from other company to the ids
    const otherCtx = await saveContext({ companyId: otherCompanyId, pattern: 'OTHER_2', role: 'OTRO' });
    const mixedIds = [...ids, otherCtx.id];

    const count = await bulkRemoveEntityContexts(companyId, mixedIds);
    expect(count).toBe(3); // Only the 3 from companyId

    // Other company's entity should remain
    const otherRemaining = await db.entityContext.findMany({ where: { companyId: otherCompanyId } });
    expect(otherRemaining).toHaveLength(2);
  });

  it('returns 0 for already-deleted entities', async () => {
    await bulkRemoveEntityContexts(companyId, ids);
    const count = await bulkRemoveEntityContexts(companyId, ids);
    expect(count).toBe(0);
  });

  it('throws EMPTY_IDS when ids array is empty', async () => {
    await expect(
      bulkRemoveEntityContexts(companyId, []),
    ).rejects.toThrow('EMPTY_IDS');
  });

  it('handles partial delete when some ids do not exist', async () => {
    const count = await bulkRemoveEntityContexts(companyId, [...ids, 'non-existent-1', 'non-existent-2']);
    expect(count).toBe(3);
  });
});
