import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestUser, createTestCompany, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { db } from '@/lib/db';

// ─── Route handler under test ──────────────────────────────────
import { POST } from '@/app/api/learning/auto-assignments/[id]/rollback/route';

// ─── Helper: create a test EntityContext ───────────────────────
async function createTestEntityContext(
  companyId: string,
  overrides: { autoAssignedAt?: Date | null } = {},
) {
  return db.entityContext.create({
    data: {
      companyId,
      pattern: `test-rollback-${Date.now()}-${Math.random()}`,
      role: 'PROVEEDOR',
      source: 'user',
      ...overrides,
    },
  });
}

describe('POST /api/learning/auto-assignments/[id]/rollback', () => {
  let token: string;
  let companyId: string;

  beforeEach(async () => {
    await clearDatabase();
    const user = await createTestUser('rollback-test@example.com');
    const company = await createTestCompany('Rollback Test Co');
    companyId = company.id;
    token = await createSession(user.id);
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('rollback auto-assigned entity succeeds (200)', async () => {
    const entityContext = await createTestEntityContext(companyId, { autoAssignedAt: new Date() });

    // Create a bank rule linked to the entity to verify cascade deletion
    await db.bankRule.create({
      data: {
        companyId,
        name: 'Rollback Test Rule',
        conditionType: 'description',
        conditionValue: 'test',
        entityContextId: entityContext.id,
      },
    });

    const req = new NextRequest('http://localhost/api/learning/auto-assignments/rollback', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await POST(req, { params: Promise.resolve({ id: entityContext.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('Auto-assignment rolled back');

    // Verify entity context no longer exists
    const deleted = await db.entityContext.findUnique({ where: { id: entityContext.id } });
    expect(deleted).toBeNull();

    // Verify bank rules linked to that entity are also deleted
    const rules = await db.bankRule.findMany({ where: { entityContextId: entityContext.id } });
    expect(rules).toHaveLength(0);
  });

  it('rollback manual assignment is rejected (400)', async () => {
    const entityContext = await createTestEntityContext(companyId, { autoAssignedAt: null });

    const req = new NextRequest('http://localhost/api/learning/auto-assignments/rollback', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await POST(req, { params: Promise.resolve({ id: entityContext.id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('manual assignment');
  });

  it('rollback non-existent entity returns 404', async () => {
    const req = new NextRequest('http://localhost/api/learning/auto-assignments/rollback', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'non-existent-id' }) });
    expect(res.status).toBe(404);
  });
});
