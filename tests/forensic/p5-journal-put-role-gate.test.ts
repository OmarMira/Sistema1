import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { PUT as journalPutPUT } from '@/app/api/journal/[id]/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function makeSuperAdmin(userId: string) {
  await db.user.update({ where: { id: userId }, data: { platformRole: 'super_admin' } });
}

async function addMember(userId: string, companyId: string, role: string) {
  await db.companyMember.create({ data: { userId, companyId, role } });
}

async function seedDraftEntry(companyId: string, status = 'draft') {
  const gl1 = await createTestGlAccount({ companyId, code: '1000', name: 'Cash' });
  const gl2 = await createTestGlAccount({ companyId, code: '2000', name: 'AP' });
  const entry = await db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2026-03-01'),
      description: 'Draft entry',
      status,
      lines: {
        create: [
          { glAccountId: gl1.id, debit: 100, credit: 0 },
          { glAccountId: gl2.id, debit: 0, credit: 100 },
        ],
      },
    },
  });
  return { gl1, gl2, entry };
}

const UPDATE_BODY = JSON.stringify({ description: 'Updated draft description' });

describe('P5 — PUT /api/journal/[id] (draft edit) role gate', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('company_admin can update a draft entry (200)', async () => {
    const user = await createTestUser('p5-put-admin@example.com');
    const company = await createTestCompany('P5 Put Admin');
    await createTestCompanyMember(user.id, company.id);
    const { entry } = await seedDraftEntry(company.id);
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT company_admin: status =', res.status);
    expect(res.status).toBe(200);

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { description: true } });
    expect(stored?.description).toBe('Updated draft description');
  });

  it('employee can update a draft entry (200)', async () => {
    const user = await createTestUser('p5-put-employee@example.com');
    const company = await createTestCompany('P5 Put Employee');
    await addMember(user.id, company.id, 'employee');
    const { entry } = await seedDraftEntry(company.id);
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT employee: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('super_admin bypass keeps draft update allowed without membership (200)', async () => {
    const user = await createTestUser('p5-put-super@example.com');
    await makeSuperAdmin(user.id);
    const company = await createTestCompany('P5 Put Super');
    const { entry } = await seedDraftEntry(company.id);
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT super_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('viewer cannot update a draft entry (403) and the entry stays unchanged', async () => {
    const user = await createTestUser('p5-put-viewer@example.com');
    const company = await createTestCompany('P5 Put Viewer');
    await addMember(user.id, company.id, 'viewer');
    const { entry } = await seedDraftEntry(company.id);
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT viewer: status =', res.status);
    expect(res.status).toBe(403);

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { description: true } });
    expect(stored?.description).toBe('Draft entry');
  });

  it('user without membership cannot update a draft entry (403)', async () => {
    const user = await createTestUser('p5-put-nomem@example.com');
    const company = await createTestCompany('P5 Put NoMem');
    const { entry } = await seedDraftEntry(company.id);
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT no-membership: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('inactive company blocks draft update (403)', async () => {
    const user = await createTestUser('p5-put-inactive@example.com');
    const company = await createTestCompany('P5 Put Inactive');
    await createTestCompanyMember(user.id, company.id);
    const { entry } = await seedDraftEntry(company.id);
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT inactive company: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('unauthenticated request is rejected (401)', async () => {
    const company = await createTestCompany('P5 Put Anon');
    const { entry } = await seedDraftEntry(company.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT no-session: status =', res.status);
    expect(res.status).toBe(401);
  });

  it('member of another company cannot update a foreign draft entry (403)', async () => {
    const attacker = await createTestUser('p5-put-attacker@example.com');
    const attackerCompany = await createTestCompany('P5 Put Attacker');
    await createTestCompanyMember(attacker.id, attackerCompany.id);
    const victimCompany = await createTestCompany('P5 Put Victim');
    const { entry } = await seedDraftEntry(victimCompany.id);
    const token = await createSession(attacker.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT cross-tenant: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('nonexistent entry returns 404', async () => {
    const user = await createTestUser('p5-put-missing@example.com');
    const company = await createTestCompany('P5 Put Missing');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest('http://localhost/api/journal/entry-does-not-exist', {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: 'entry-does-not-exist' }) },
    );
    log('PUT nonexistent entry: status =', res.status);
    expect(res.status).toBe(404);
  });

  it('posted entry cannot be updated (400)', async () => {
    const user = await createTestUser('p5-put-posted@example.com');
    const company = await createTestCompany('P5 Put Posted');
    await createTestCompanyMember(user.id, company.id);
    const { entry } = await seedDraftEntry(company.id, 'posted');
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT posted entry: status =', res.status);
    expect(res.status).toBe(400);
  });

  it('void entry cannot be updated (400)', async () => {
    const user = await createTestUser('p5-put-void@example.com');
    const company = await createTestCompany('P5 Put Void');
    await createTestCompanyMember(user.id, company.id);
    const { entry } = await seedDraftEntry(company.id, 'void');
    const token = await createSession(user.id);

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: UPDATE_BODY,
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT void entry: status =', res.status);
    expect(res.status).toBe(400);
  });

  it('D2-H10: PUT draft cambia date hacia período cerrado → rechazo (403) → fecha original intacta', async () => {
    const user = await createTestUser('p5-put-d2h10@example.com');
    const company = await createTestCompany('P5 Put D2H10');
    await createTestCompanyMember(user.id, company.id);
    const { entry } = await seedDraftEntry(company.id);
    const token = await createSession(user.id);

    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'June 2026 Closed',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-30T23:59:59.999Z'),
        isLocked: true,
      },
    });

    const res = await journalPutPUT(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ date: '2026-06-15' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    log('PUT D2-H10 locked period: status =', res.status);
    expect(res.status).toBe(403);

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { date: true } });
    expect(stored?.date.toISOString()).toBe(new Date('2026-03-01').toISOString());
  });
});