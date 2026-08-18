import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { clearDatabase, createTestUser, createTestCompany, createTestCompanyMember } from '../helpers/factories';

import EntityDetailPage from '@/app/company-knowledge/[id]/page';
import EditEntityPage from '@/app/company-knowledge/[id]/edit/page';

const log = (...args: unknown[]) => console.log('[EVIDENCE-G4-AB-SSR]', ...args);

const cookieState = vi.hoisted(() => ({
  sessionToken: null as string | null,
  companyId: null as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      get: (name: string) => {
        if (name === 'companyId') {
          return cookieState.companyId ? { name, value: cookieState.companyId } : undefined;
        }
        return cookieState.sessionToken ? { name, value: cookieState.sessionToken } : undefined;
      },
    }),
  ),
}));

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
    await db.companyKnowledge.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.companyMember.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: [...createdCompanyIds] } } }).catch(() => {});
    createdCompanyIds.clear();
  }
  await clearDatabase();
}

describe('G4-AB-SSR — Server-rendered pages matrix (A/B)', () => {
  beforeEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    cookieState.sessionToken = null;
    cookieState.companyId = null;
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedTenants() {
    const tenantA = await createTestCompany('G4 AB SSR Tenant A');
    createdCompanyIds.add(tenantA.id);
    const tenantB = await createTestCompany('G4 AB SSR Tenant B');
    createdCompanyIds.add(tenantB.id);
    const attacker = await createTestUser('attacker-g4abssr@example.com');
    await createTestCompanyMember(attacker.id, tenantA.id);
    const ownerB = await createTestUser('owner-g4abssr@example.com');
    await createTestCompanyMember(ownerB.id, tenantB.id);
    return { tenantA, tenantB, attacker, ownerB };
  }

  async function establishSession(userId: string, companyId: string) {
    const token = await createSession(userId);
    cookieState.sessionToken = token;
    cookieState.companyId = companyId;
    return token;
  }

  it('A: SSR company-knowledge detail — member of A renders "Entity not found" for entity of B (no leak)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Victim SSR Secret Name B');
    await establishSession(attacker.id, tenantA.id);

    const html = renderToStaticMarkup(
      await EntityDetailPage({ params: Promise.resolve({ id: knowledgeB.id }) }),
    );
    log('A SSR detail html:', JSON.stringify(html.slice(0, 200)));
    expect(html).toContain('Entity not found');
    expect(html).not.toContain('Victim SSR Secret Name B');
  });

  it('B: SSR company-knowledge detail — owner renders own entity canonicalName + audit', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Own SSR Visible Name B');
    await establishSession(ownerB.id, tenantB.id);

    const html = renderToStaticMarkup(
      await EntityDetailPage({ params: Promise.resolve({ id: knowledgeB.id }) }),
    );
    log('B SSR detail html:', JSON.stringify(html.slice(0, 200)));
    expect(html).toContain('Own SSR Visible Name B');
    expect(html).not.toContain('Entity not found');
  });

  it('A: SSR company-knowledge edit — member of A renders "Entity not found" for edit page of B', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Victim SSR Edit Secret B');
    await establishSession(attacker.id, tenantA.id);

    const html = renderToStaticMarkup(
      await EditEntityPage({ params: Promise.resolve({ id: knowledgeB.id }) }),
    );
    log('A SSR edit html:', JSON.stringify(html.slice(0, 200)));
    expect(html).toContain('Entity not found');
    expect(html).not.toContain('Victim SSR Edit Secret B');
  });

  it('B: SSR company-knowledge edit — owner renders edit form with own canonicalName and version', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Own SSR Edit Name B');
    await establishSession(ownerB.id, tenantB.id);

    const html = renderToStaticMarkup(
      await EditEntityPage({ params: Promise.resolve({ id: knowledgeB.id }) }),
    );
    log('B SSR edit html:', JSON.stringify(html.slice(0, 200)));
    expect(html).toContain('Own SSR Edit Name B');
    expect(html).toContain('Current version');
    expect(html).not.toContain('Entity not found');
  });
});