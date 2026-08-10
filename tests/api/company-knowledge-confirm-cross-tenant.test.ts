import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestUser, createTestCompany, clearDatabase, createTestCompanyMember } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { db } from '@/lib/db';

import { POST as confirmCreateRoute } from '../../src/app/api/company-knowledge/confirm/route';
import { POST as confirmUpdateRoute } from '../../src/app/api/company-knowledge/[id]/confirm-update/route';

async function createKnowledge(companyId: string, canonicalName: string) {
  return db.companyKnowledge.create({
    data: {
      companyId,
      type: 'PERSON',
      canonicalName,
      aliases: [],
      metadata: {},
      source: 'company_knowledge',
      status: 'active',
    },
  });
}

async function createPendingUpdateApproval(knowledgeId: string, userId: string, canonicalName: string) {
  return db.pendingApproval.create({
    data: {
      knowledgeId,
      action: 'update',
      payload: {
        knowledgeId,
        before: { canonicalName },
        after: { canonicalName: 'HACKED-BY-TENANT-A' },
        updates: { canonicalName: 'HACKED-BY-TENANT-A' },
      },
      requestedBy: userId,
      status: 'pending',
    },
  });
}

async function createPendingCreateApproval(companyId: string, userId: string) {
  return db.pendingApproval.create({
    data: {
      knowledgeId: null,
      action: 'create',
      payload: {
        companyId,
        type: 'company',
        canonicalName: 'INTRUDER-CO',
        aliases: [],
        relationship: null,
        metadata: {},
        source: 'company_knowledge',
      },
      requestedBy: userId,
      status: 'pending',
    },
  });
}

describe('P13 — confirm/confirm-update company-knowledge (aislamiento de tenant)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    const testUsers = await db.user.findMany({
      where: { email: { contains: '@example.com' } },
      select: { id: true },
    });
    const memberships = await db.companyMember.findMany({
      where: { userId: { in: testUsers.map((u) => u.id) } },
      select: { companyId: true },
    });
    const companyIds = memberships.map((m) => m.companyId);
    if (companyIds.length > 0) {
      await db.knowledgeAudit.deleteMany({ where: { companyKnowledge: { companyId: { in: companyIds } } } }).catch(() => {});
      await db.pendingApproval.deleteMany({ where: { companyKnowledge: { companyId: { in: companyIds } } } }).catch(() => {});
      await db.companyKnowledge.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => {});
    }
    await clearDatabase();
  });

  it('rechaza que el usuario de A confirme un update de conocimiento de la empresa B (403, dato de B intacto)', async () => {
    const userA = await createTestUser('p13-a@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const userB = await createTestUser('p13-b@example.com');
    const knowledgeB = await createKnowledge(companyB.id, 'John Doe B');
    const pendingB = await createPendingUpdateApproval(knowledgeB.id, userB.id, 'John Doe B');

    const res = await confirmUpdateRoute(
      new NextRequest(`http://localhost/api/company-knowledge/${knowledgeB.id}/confirm-update?companyId=${companyA.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingApprovalId: pendingB.id }),
      }),
      { params: Promise.resolve({ id: knowledgeB.id }) },
    );

    expect(res.status).toBe(403);

    const afterB = await db.companyKnowledge.findUnique({ where: { id: knowledgeB.id } });
    expect(afterB?.canonicalName).toBe('John Doe B');
  });

  it('permite que el usuario de A confirme un update de conocimiento propio (200, aplicado)', async () => {
    const userA = await createTestUser('p13-c@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const knowledgeA = await createKnowledge(companyA.id, 'John Doe A');
    const pendingA = await createPendingUpdateApproval(knowledgeA.id, userA.id, 'John Doe A');

    const res = await confirmUpdateRoute(
      new NextRequest(`http://localhost/api/company-knowledge/${knowledgeA.id}/confirm-update?companyId=${companyA.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingApprovalId: pendingA.id }),
      }),
      { params: Promise.resolve({ id: knowledgeA.id }) },
    );

    expect(res.status).toBe(200);

    const afterA = await db.companyKnowledge.findUnique({ where: { id: knowledgeA.id } });
    expect(afterA?.canonicalName).toBe('HACKED-BY-TENANT-A');
  });

  it('rechaza que el usuario de A confirme un create de conocimiento para la empresa B (403, no se crea en B)', async () => {
    const userA = await createTestUser('p13-d@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const userB = await createTestUser('p13-e@example.com');
    const pendingB = await createPendingCreateApproval(companyB.id, userB.id);

    const res = await confirmCreateRoute(
      new NextRequest(`http://localhost/api/company-knowledge/confirm?companyId=${companyA.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingApprovalId: pendingB.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);

    const intruder = await db.companyKnowledge.findFirst({
      where: { companyId: companyB.id, canonicalName: 'INTRUDER-CO' },
    });
    expect(intruder).toBeNull();
  });

  it('permite que el usuario de A confirme un create de conocimiento propio (200, creado en A)', async () => {
    const userA = await createTestUser('p13-f@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const pendingA = await createPendingCreateApproval(companyA.id, userA.id);

    const res = await confirmCreateRoute(
      new NextRequest(`http://localhost/api/company-knowledge/confirm?companyId=${companyA.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingApprovalId: pendingA.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const created = await db.companyKnowledge.findFirst({
      where: { companyId: companyA.id, canonicalName: 'INTRUDER-CO' },
    });
    expect(created).toBeTruthy();
  });
});
