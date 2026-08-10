import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestUser, createTestCompany, clearDatabase, createTestCompanyMember } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { db } from '@/lib/db';

import { POST } from '../../src/app/api/learning/auto-assignments/[id]/rollback/route';

async function createTestEntityContext(companyId: string) {
  return db.entityContext.create({
    data: {
      companyId,
      pattern: `test-rollback-x-${Date.now()}-${Math.random()}`,
      role: 'PROVEEDOR',
      source: 'user',
      autoAssignedAt: new Date(),
    },
  });
}

describe('P12 — POST /api/learning/auto-assignments/[id]/rollback (aislamiento de tenant)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('rechaza que el usuario de A revierta un auto-assignment de la empresa B (403, datos de B intactos)', async () => {
    const userA = await createTestUser('p12-a@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const ctxB = await createTestEntityContext(companyB.id);
    await db.bankRule.create({
      data: {
        companyId: companyB.id,
        name: 'B Rule',
        conditionType: 'description',
        conditionValue: 'SECRET-B',
        entityContextId: ctxB.id,
      },
    });

    const res = await POST(
      new NextRequest(`http://localhost/api/learning/auto-assignments/rollback?companyId=${companyA.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
      { params: Promise.resolve({ id: ctxB.id }) },
    );

    expect(res.status).toBe(403);

    const afterCtx = await db.entityContext.findUnique({ where: { id: ctxB.id } });
    expect(afterCtx).toBeTruthy();
    const afterRule = await db.bankRule.findFirst({ where: { entityContextId: ctxB.id } });
    expect(afterRule).toBeTruthy();
  });

  it('permite que el usuario de A revierta un auto-assignment propio (200, borrado)', async () => {
    const userA = await createTestUser('p12-b@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const ctxA = await createTestEntityContext(companyA.id);
    await db.bankRule.create({
      data: {
        companyId: companyA.id,
        name: 'A Rule',
        conditionType: 'description',
        conditionValue: 'A',
        entityContextId: ctxA.id,
      },
    });

    const res = await POST(
      new NextRequest(`http://localhost/api/learning/auto-assignments/rollback?companyId=${companyA.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
      { params: Promise.resolve({ id: ctxA.id }) },
    );

    expect(res.status).toBe(200);

    const afterCtx = await db.entityContext.findUnique({ where: { id: ctxA.id } });
    expect(afterCtx).toBeNull();
    const afterRule = await db.bankRule.findFirst({ where: { entityContextId: ctxA.id } });
    expect(afterRule).toBeNull();
  });
});