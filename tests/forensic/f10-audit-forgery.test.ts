import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { requestContext } from '@/lib/context-storage';
import { POST as archivePOST } from '@/app/api/company-knowledge/[id]/archive/route';
import { POST as restorePOST } from '@/app/api/company-knowledge/[id]/restore/route';
import { POST as mergePOST } from '@/app/api/company-knowledge/[id]/merge/route';
import { POST as confirmPOST } from '@/app/api/company-knowledge/confirm/route';
import { archive } from '@/internal/company-knowledge';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const createdCompanyIds = new Set<string>();

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function createKnowledgeEntity(companyId: string, name: string) {
  return db.companyKnowledge.create({
    data: {
      companyId,
      type: 'COMPANY',
      canonicalName: name,
      aliases: [],
      status: 'active',
      source: 'company_knowledge',
    },
  });
}

function postCall(token: string | null, path: string, companyId: string | null, body: Record<string, unknown>) {
  const qs = companyId ? `?companyId=${companyId}` : '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost${path}${qs}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function lastAudit(knowledgeId: string, action: string) {
  return db.knowledgeAudit.findFirst({
    where: { knowledgeId, action },
    orderBy: { timestamp: 'desc' },
  });
}

describe('F-10 — KnowledgeAudit identity must come from the session (RED)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    await db.pendingApproval.deleteMany({}).catch(() => {});
    if (ids.length > 0) {
      const filter = { companyId: { in: ids } };
      await db.knowledgeAudit.deleteMany({ where: { companyKnowledge: filter } }).catch(() => {});
      await db.companyKnowledge.deleteMany({ where: filter }).catch(() => {});
      await db.companyMember.deleteMany({ where: filter }).catch(() => {});
      await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    }
    await clearDatabase();
  });

  afterAll(async () => {
    const audits = await db.knowledgeAudit.count();
    const knowledge = await db.companyKnowledge.count();
    log('AFTER-ALL DB STATE: knowledgeAudit =', audits, '| companyKnowledge =', knowledge);
  });

  it('R1: archive ignores a forged changedByUserId and records the session actor (RED)', async () => {
    const actor = await createTestUser('f10-r1-actor@example.com');
    const victim = await createTestUser('f10-r1-victim@example.com');
    const company = await createTestCompany('F10 R1 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const entity = await createKnowledgeEntity(company.id, 'R1 Entity');
    const token = await createSession(actor.id);

    const res = await archivePOST(
      postCall(token, `/api/company-knowledge/${entity.id}/archive`, company.id, { changedByUserId: victim.id, reason: 'f10 r1' }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    const audit = await lastAudit(entity.id, 'archive');

    log('R1: status =', res.status, '| forged =', victim.id, '| stored =', audit?.changedByUserId);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(actor.id);
    expect(audit?.changedByUserId).not.toBe(victim.id);
  });

  it('R2: archive rejects a non-existent identity and records the session actor (RED)', async () => {
    const actor = await createTestUser('f10-r2-actor@example.com');
    const company = await createTestCompany('F10 R2 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const entity = await createKnowledgeEntity(company.id, 'R2 Entity');
    const token = await createSession(actor.id);

    const res = await archivePOST(
      postCall(token, `/api/company-knowledge/${entity.id}/archive`, company.id, { changedByUserId: 'forged-nonexistent-user', reason: 'f10 r2' }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    const audit = await lastAudit(entity.id, 'archive');

    log('R2: status =', res.status, '| stored =', audit?.changedByUserId);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(actor.id);
  });

  it('R3: archive works WITHOUT the identity field and records the session actor (RED)', async () => {
    const actor = await createTestUser('f10-r3-actor@example.com');
    const company = await createTestCompany('F10 R3 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const entity = await createKnowledgeEntity(company.id, 'R3 Entity');
    const token = await createSession(actor.id);

    const res = await archivePOST(
      postCall(token, `/api/company-knowledge/${entity.id}/archive`, company.id, { reason: 'f10 r3' }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    const audit = await lastAudit(entity.id, 'archive');

    log('R3: status =', res.status, '| stored =', audit?.changedByUserId);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(actor.id);
  });

  it('R4: restore works WITHOUT the identity field and records the session actor (RED)', async () => {
    const actor = await createTestUser('f10-r4-actor@example.com');
    const company = await createTestCompany('F10 R4 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const entity = await createKnowledgeEntity(company.id, 'R4 Entity');
    await db.companyKnowledge.update({ where: { id: entity.id }, data: { status: 'archived' } });
    const token = await createSession(actor.id);

    const res = await restorePOST(
      postCall(token, `/api/company-knowledge/${entity.id}/restore`, company.id, { reason: 'f10 r4' }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    const audit = await lastAudit(entity.id, 'restore');

    log('R4: status =', res.status, '| stored =', audit?.changedByUserId);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(actor.id);
  });

  it('R5: merge keeps its 2 audits, both attributed to the session actor (RED)', async () => {
    const actor = await createTestUser('f10-r5-actor@example.com');
    const company = await createTestCompany('F10 R5 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const source = await createKnowledgeEntity(company.id, 'R5 Source');
    const target = await createKnowledgeEntity(company.id, 'R5 Target');
    const token = await createSession(actor.id);

    const res = await mergePOST(
      postCall(token, `/api/company-knowledge/${target.id}/merge`, company.id, {
        sourceKnowledgeId: source.id,
        fieldResolutions: {},
        changedByUserId: 'forged-merge-user',
      }),
      { params: Promise.resolve({ id: target.id }) },
    );
    const audits = await db.knowledgeAudit.findMany({ where: { action: 'merge' } });

    log('R5: status =', res.status, '| audit entries =', audits.length, '| stored =', audits.map((a) => a.changedByUserId).join(','));
    expect(res.status).toBe(200);
    expect(audits.length).toBe(2);
    for (const a of audits) expect(a.changedByUserId).toBe(actor.id);
  });

  it('R6: confirmCreate records the session actor, ignoring a forged confirmedByUserId (RED)', async () => {
    const actor = await createTestUser('f10-r6-actor@example.com');
    const company = await createTestCompany('F10 R6 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const pending = await db.pendingApproval.create({
      data: {
        action: 'create',
        payload: {
          companyId: company.id,
          type: 'company',
          canonicalName: 'R6 Pending',
          aliases: [],
          metadata: {},
          source: 'company_knowledge',
        },
        requestedBy: 'system',
        status: 'pending',
      },
    });
    const token = await createSession(actor.id);

    const res = await confirmPOST(
      postCall(token, '/api/company-knowledge/confirm', company.id, {
        pendingApprovalId: pending.id,
        confirmedByUserId: 'forged-confirm-user',
      }),
      { params: Promise.resolve({}) },
    );
    const created = await db.companyKnowledge.findFirst({ where: { canonicalName: 'R6 Pending' } });
    const audit = created ? await lastAudit(created.id, 'create') : null;

    log('R6: status =', res.status, '| stored =', audit?.changedByUserId);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(actor.id);
  });

  it('R7: an audited operation without a session fails with a controlled 401, not a Prisma/500 error', async () => {
    const company = await createTestCompany('F10 R7 Co');
    createdCompanyIds.add(company.id);
    const entity = await createKnowledgeEntity(company.id, 'R7 Entity');

    const res = await archivePOST(
      postCall(null, `/api/company-knowledge/${entity.id}/archive`, company.id, { reason: 'f10 r7' }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    const body = await res.json();

    log('R7: status =', res.status, '| error type =', typeof body.error);
    expect(res.status).toBe(401);
    expect(String(body.error)).not.toContain('Prisma');
    expect(res.status).not.toBe(500);
  });

  it('R8: the actor propagates through AsyncLocalStorage into appendAuditEntry (direct service call)', async () => {
    const actor = await createTestUser('f10-r8-actor@example.com');
    const company = await createTestCompany('F10 R8 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);
    const entity = await createKnowledgeEntity(company.id, 'R8 Entity');

    await requestContext.run({ userId: actor.id, companyId: company.id }, async () => {
      await archive({ knowledgeId: entity.id, companyId: company.id, reason: 'f10 r8' });
    });
    const audit = await lastAudit(entity.id, 'archive');

    log('R8: stored =', audit?.changedByUserId, '| session actor =', actor.id);
    expect(audit?.changedByUserId).toBe(actor.id);
  });

  it('R9: a super_admin actor is recorded with their real userId (RED)', async () => {
    const superAdmin = await db.user.create({
      data: {
        email: 'f10-r9-super@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'F10',
        lastName: 'Super',
        role: 'super_admin',
      },
    });
    const company = await createTestCompany('F10 R9 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(superAdmin.id, company.id);
    const entity = await createKnowledgeEntity(company.id, 'R9 Entity');
    const token = await createSession(superAdmin.id);

    const res = await archivePOST(
      postCall(token, `/api/company-knowledge/${entity.id}/archive`, company.id, { changedByUserId: 'forged-super', reason: 'f10 r9' }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    const audit = await lastAudit(entity.id, 'archive');

    log('R9: status =', res.status, '| stored =', audit?.changedByUserId, '| super_admin id =', superAdmin.id);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(superAdmin.id);
  });
});
