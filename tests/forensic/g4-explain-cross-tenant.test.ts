import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { clearDatabase, createTestUser, createTestCompany, createTestCompanyMember } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-G4-RC4]', ...args);

const createdCompanyIds = new Set<string>();
const createdKnowledgeIds = new Set<string>();

async function createKnowledgeEntity(companyId: string, canonicalName: string) {
  const entity = await db.companyKnowledge.create({
    data: {
      companyId,
      canonicalName,
      type: 'COMPANY',
      aliases: [],
      source: 'company_knowledge',
      status: 'active',
      version: 1,
      metadata: {},
    },
  });
  createdKnowledgeIds.add(entity.id);
  await db.knowledgeAudit.create({
    data: {
      knowledgeId: entity.id,
      action: 'create',
      version: 1,
      changedByUserId: 'test-user',
      source: 'company_knowledge',
      reason: 'Entity created',
    },
  });
  return entity;
}

async function cleanup() {
  if (createdKnowledgeIds.size > 0) {
    await db.knowledgeAudit.deleteMany({ where: { knowledgeId: { in: [...createdKnowledgeIds] } } }).catch(() => {});
    await db.companyKnowledge.deleteMany({ where: { id: { in: [...createdKnowledgeIds] } } }).catch(() => {});
    createdKnowledgeIds.clear();
  }
  if (createdCompanyIds.size > 0) {
    await db.companyMember.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: [...createdCompanyIds] } } }).catch(() => {});
    createdCompanyIds.clear();
  }
  await clearDatabase();
}

describe('G4-RC4 — Cross-tenant read via /api/company-knowledge/[id]/explain', () => {
  beforeEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('member of Company B cannot obtain explain payload nor audit trail of entity belonging to Company A', async () => {
    const tenantA = await createTestCompany('G4 RC4 Tenant A');
    createdCompanyIds.add(tenantA.id);
    const tenantB = await createTestCompany('G4 RC4 Tenant B');
    createdCompanyIds.add(tenantB.id);

    // Entity belongs to tenant A
    const entityA = await createKnowledgeEntity(tenantA.id, 'Secret Entity A');

    // Attacker member of tenant B only
    const attacker = await createTestUser('attacker-g4rc4@example.com');
    await createTestCompanyMember(attacker.id, tenantB.id);
    const token = await createSession(attacker.id);

    // Insight spies on the DB queries
    const payloadSpy = vi.spyOn(db.companyKnowledge, 'findFirst');
    const auditSpy = vi.spyOn(db.knowledgeAudit, 'findMany');

    const req = new NextRequest(
      `http://localhost/api/company-knowledge/${entityA.id}/explain?companyId=${tenantB.id}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const { GET } = await import('@/app/api/company-knowledge/[id]/explain/route');
    const res = await GET(req, { params: Promise.resolve({ id: entityA.id }) });

    log('CROSS-TENANT EXPLAIN status:', res.status);
    const body = await res.json();
    log('CROSS-TENANT EXPLAIN body:', JSON.stringify(body));

    expect(res.status).toBe(404);
    expect(body).not.toHaveProperty('canonicalName');
    expect(body).not.toHaveProperty('auditHistory');

    // The queries themselves must be tenant-scoped, never returning A data to B
    expect(payloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId: tenantB.id }) }),
    );
    // Audit trail must never be queried for a tenant-mismatched knowledge id
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('owner member of Company A obtains own entity explain payload + audit trail', async () => {
    const tenantA = await createTestCompany('G4 RC4 Own Tenant');
    createdCompanyIds.add(tenantA.id);
    const entityA = await createKnowledgeEntity(tenantA.id, 'Own Entity A');

    const owner = await createTestUser('owner-g4rc4@example.com');
    await createTestCompanyMember(owner.id, tenantA.id);
    const token = await createSession(owner.id);

    const req = new NextRequest(
      `http://localhost/api/company-knowledge/${entityA.id}/explain?companyId=${tenantA.id}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const { GET } = await import('@/app/api/company-knowledge/[id]/explain/route');
    const res = await GET(req, { params: Promise.resolve({ id: entityA.id }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canonicalName).toBe('Own Entity A');
    expect(Array.isArray(body.auditHistory)).toBe(true);
    expect(body.auditHistory.length).toBeGreaterThanOrEqual(1);
  });
});