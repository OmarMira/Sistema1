import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

import CompanyKnowledgePage from '@/app/company-knowledge/page';
import EntityDetailPage from '@/app/company-knowledge/[id]/page';
import EditEntityPage from '@/app/company-knowledge/[id]/edit/page';

const log = (...args: unknown[]) => console.log('[EVIDENCE-G3]', ...args);

// SSR session cookie state: mocked ONLY at the next/headers boundary.
// The companyId cookie is the canonical tenant candidate (§7.2/§7.3 alignment).
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

async function createKnowledgeEntity(companyId: string, canonicalName: string, type: string) {
  const entity = await db.companyKnowledge.create({
    data: {
      companyId,
      canonicalName,
      type: type as 'COMPANY',
      aliases: [],
      source: 'test',
      status: 'active',
      version: 1,
    },
  });
  createdKnowledgeIds.add(entity.id);
  return entity;
}

async function cleanupKnowledge() {
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
}

function mockCookies(token: string | null, companyId: string | null) {
  cookieState.sessionToken = token;
  cookieState.companyId = companyId;
}

describe('G3 — SSR isolation: company-knowledge pages (real page boundary)', () => {
  let attacker: { id: string };
  let tenantA: { id: string };
  let tenantB: { id: string };

  let listSpy: ReturnType<typeof vi.spyOn>;
  let firstSpy: ReturnType<typeof vi.spyOn>;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanupKnowledge();
    await clearDatabase();
    mockCookies(null, null);
    vi.restoreAllMocks();

    attacker = await createTestUser('attacker-g3@example.com');
    tenantA = await createTestCompany('G3 Tenant A');
    tenantB = await createTestCompany('G3 Tenant B');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);
    createdCompanyIds.add(tenantB.id);

    listSpy = vi.spyOn(db.companyKnowledge, 'findMany');
    firstSpy = vi.spyOn(db.companyKnowledge, 'findFirst');
    auditSpy = vi.spyOn(db.knowledgeAudit, 'findMany');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupKnowledge();
    await clearDatabase();
  });

  it('A. list: user A cannot obtain tenant B list (0 findMany calls)', async () => {
    await createKnowledgeEntity(tenantB.id, 'Victim B Entity', 'COMPANY');
    const token = await createSession(attacker.id);
    mockCookies(token, tenantB.id);

    const html = renderToStaticMarkup(
      await CompanyKnowledgePage({ searchParams: Promise.resolve({ companyId: tenantB.id }) }),
    );
    log('LIST ATTACK (companyId=B):', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Access denied');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('B. detail: user A cannot open detail of entity belonging to B (0 findFirst calls)', async () => {
    const entityB = await createKnowledgeEntity(tenantB.id, 'Victim B Entity', 'COMPANY');
    const token = await createSession(attacker.id);
    mockCookies(token, tenantB.id);

    const html = renderToStaticMarkup(
      await EntityDetailPage({ params: Promise.resolve({ id: entityB.id }) }),
    );
    log('DETAIL ATTACK (companyId=B):', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Access denied');
    expect(firstSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('C. edit: user A cannot obtain edit form of entity belonging to B (0 findFirst calls)', async () => {
    const entityB = await createKnowledgeEntity(tenantB.id, 'Victim B Entity', 'COMPANY');
    const token = await createSession(attacker.id);
    mockCookies(token, tenantB.id);

    const html = renderToStaticMarkup(
      await EditEntityPage({ params: Promise.resolve({ id: entityB.id }) }),
    );
    log('EDIT ATTACK (companyId=B):', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Access denied');
    expect(firstSpy).not.toHaveBeenCalled();
  });

  it('D. anonymous never reaches companyKnowledge (0 calls, all methods)', async () => {
    await createKnowledgeEntity(tenantA.id, 'Own A Entity', 'COMPANY');
    mockCookies(null, tenantA.id);

    const html = renderToStaticMarkup(
      await CompanyKnowledgePage({ searchParams: Promise.resolve({ companyId: tenantA.id }) }),
    );
    log('ANONYMOUS LIST:', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Authentication required');
    expect(listSpy).not.toHaveBeenCalled();

    await EntityDetailPage({ params: Promise.resolve({ id: 'any-id' }) });
    expect(firstSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('E. manipulated companyId does not authorize access (0 calls)', async () => {
    await createKnowledgeEntity(tenantB.id, 'Victim B Entity', 'COMPANY');
    const token = await createSession(attacker.id);
    mockCookies(token, tenantB.id);

    const html = renderToStaticMarkup(
      await CompanyKnowledgePage({ searchParams: Promise.resolve({ companyId: tenantB.id }) }),
    );
    log('MANIPULATED companyId (B):', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Access denied');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('F. missing companyId is fail-closed (0 calls)', async () => {
    const token = await createSession(attacker.id);
    mockCookies(token, null);

    const html = renderToStaticMarkup(
      await CompanyKnowledgePage({ searchParams: Promise.resolve({}) }),
    );
    log('MISSING companyId:', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Company context required');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('G. authorized user obtains own tenant data only', async () => {
    const ownA = await createKnowledgeEntity(tenantA.id, 'Own A Entity', 'COMPANY');
    await createKnowledgeEntity(tenantB.id, 'Victim B Entity', 'COMPANY');
    const token = await createSession(attacker.id);
    mockCookies(token, tenantA.id);

    const html = renderToStaticMarkup(
      await CompanyKnowledgePage({ searchParams: Promise.resolve({ companyId: tenantA.id }) }),
    );
    log('AUTHORIZED LIST:', JSON.stringify(html.slice(0, 200)));
    expect(html).toContain('Own A Entity');
    expect(html).not.toContain('Victim B Entity');
    expect(listSpy).toHaveBeenCalledTimes(1);
    const arg = listSpy.mock.calls[0][0] as { where: { companyId: string } };
    expect(arg.where.companyId).toBe(tenantA.id);
  });

  it('H. detail/edit: id of entity B under tenant A returns neutral not-found, no cross-tenant existence leak', async () => {
    const entityB = await createKnowledgeEntity(tenantB.id, 'Victim B Entity', 'COMPANY');
    const token = await createSession(attacker.id);
    mockCookies(token, tenantA.id);

    const detailHtml = renderToStaticMarkup(
      await EntityDetailPage({ params: Promise.resolve({ id: entityB.id }) }),
    );
    log('DETAIL B-entity under tenant A:', JSON.stringify(detailHtml.slice(0, 120)));
    expect(detailHtml).toContain('Entity not found');
    expect(detailHtml).not.toContain('Victim B Entity');
    expect(firstSpy).toHaveBeenCalledTimes(1);
    const detailArg = firstSpy.mock.calls[0][0] as { where: { id: string; companyId: string } };
    expect(detailArg.where.companyId).toBe(tenantA.id);
    expect(auditSpy).not.toHaveBeenCalled();

    const editHtml = renderToStaticMarkup(
      await EditEntityPage({ params: Promise.resolve({ id: entityB.id }) }),
    );
    log('EDIT B-entity under tenant A:', JSON.stringify(editHtml.slice(0, 120)));
    expect(editHtml).toContain('Entity not found');
    expect(editHtml).not.toContain('Victim B Entity');
  });

  it('I. removed/nonexistent membership: fail-closed SSR with no tenant data', async () => {
    const orphanCompany = await createTestCompany('G3 Orphan Company');
    createdCompanyIds.add(orphanCompany.id);
    const entity = await createKnowledgeEntity(orphanCompany.id, 'Orphan Entity', 'COMPANY');
    const token = await createSession(attacker.id);

    mockCookies(token, orphanCompany.id);
    const html = renderToStaticMarkup(
      await CompanyKnowledgePage({ searchParams: Promise.resolve({ companyId: orphanCompany.id }) }),
    );
    log('MEMBERSHIP-MISSING LIST:', JSON.stringify(html.slice(0, 120)));
    expect(html).toContain('Access denied');
    expect(listSpy).not.toHaveBeenCalled();

    const detailHtml = renderToStaticMarkup(
      await EntityDetailPage({ params: Promise.resolve({ id: entity.id }) }),
    );
    log('MEMBERSHIP-MISSING DETAIL:', JSON.stringify(detailHtml.slice(0, 120)));
    expect(detailHtml).toContain('Access denied');
    expect(firstSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('J. concurrent resolutions with distinct companyId arguments do not share tenant state', async () => {
    const { requireSsrCompanyContext } = await import('@/lib/ssr-context');
    await createTestCompanyMember(attacker.id, tenantB.id);
    const token = await createSession(attacker.id);
    mockCookies(token, null);

    const [ctxA, ctxB] = await Promise.all([
      requireSsrCompanyContext(tenantA.id),
      requireSsrCompanyContext(tenantB.id),
    ]);
    log('CONCURRENT CONTEXT A:', JSON.stringify(ctxA));
    log('CONCURRENT CONTEXT B:', JSON.stringify(ctxB));

    expect(ctxA.ok).toBe(true);
    expect(ctxB.ok).toBe(true);
    if (!ctxA.ok || !ctxB.ok) {
      throw new Error('expected both concurrent resolutions to authorize');
    }
    expect(ctxA.companyId).toBe(tenantA.id);
    expect(ctxB.companyId).toBe(tenantB.id);
    expect(ctxA.companyId).not.toBe(tenantB.id);
    expect(ctxB.companyId).not.toBe(tenantA.id);

    const residual = await requireSsrCompanyContext(undefined);
    log('RESIDUAL CONTEXT:', JSON.stringify(residual));
    expect(residual).toEqual({ ok: false, reason: 'missing-company' });
  });
});