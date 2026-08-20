import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST as invitePOST } from '@/app/api/users/route';
import { GET as usersGET } from '@/app/api/users/route';
import { PUT as settingsPUT } from '@/app/api/settings/route';
import { GET as insightsGET } from '@/app/api/assistant/insights/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-RC21]', ...args);

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function asUser(email: string, membershipRole: 'viewer' | 'employee' | 'company_admin') {
  const user = await createTestUser(email);
  const company = await createTestCompany('RC21 Tenant');
  await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: membershipRole } });
  const token = await createSession(user.id);
  return { user, company, token };
}

async function asSuperAdmin(email: string) {
  const user = await db.user.create({
    data: {
      email,
      passwordHash: 'hashed_password_placeholder',
      firstName: 'Super',
      lastName: 'Admin',
      platformRole: 'super_admin',
    },
  });
  const token = await createSession(user.id);
  return { user, token };
}

const inviteBody = (email: string) => ({
  email,
  firstName: 'F1',
  lastName: 'User',
  password: 'password123',
  role: 'company_admin',
});

describe('RC2-1 — Users GET: tenant authority via CompanyMember.role only', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it('A1: User.role=company_admin + membership viewer → 403, sensitive list query NOT executed', async () => {
    const { company, token } = await asUser('rc21-get-viewer@example.com', 'viewer');
    const listSpy = vi.spyOn(db.companyMember, 'findMany');

    const res = await usersGET(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('A1 GET viewer status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('A2: membership employee → 403, sensitive list query NOT executed', async () => {
    const { company, token } = await asUser('rc21-get-employee@example.com', 'employee');
    const listSpy = vi.spyOn(db.companyMember, 'findMany');

    const res = await usersGET(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('A2 GET employee status:', res.status);
    expect(res.status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('A3: membership company_admin → 200', async () => {
    const { company, token } = await asUser('rc21-get-admin@example.com', 'company_admin');
    const res = await usersGET(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('A3 GET admin status:', res.status);
    expect(res.status).toBe(200);
  });

  it('A4: super_admin WITHOUT membership → 200 (global bypass preserved)', async () => {
    const { company } = await asUser('rc21-seed-other@example.com', 'company_admin');
    const { token } = await asSuperAdmin('rc21-super-get@example.com');

    const res = await usersGET(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('A4 GET super_admin status:', res.status);
    expect(res.status).toBe(200);
  });
});

describe('RC2-1 — Users POST (invite): tenant authority via CompanyMember.role only', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it('B1: membership viewer → 403, 0 user.create + 0 companyMember.create', async () => {
    const { company, token } = await asUser('rc21-post-viewer@example.com', 'viewer');
    const userSpy = vi.spyOn(db.user, 'create');
    const memberSpy = vi.spyOn(db.companyMember, 'create');

    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(inviteBody('rc21-victim-a@example.com')),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const created = await db.user.findUnique({ where: { email: 'rc21-victim-a@example.com' } });
    log('B1 POST viewer status:', res.status, '| error:', JSON.stringify(body.error), '| victim exists:', created !== null);
    expect(res.status).toBe(403);
    expect(userSpy).not.toHaveBeenCalled();
    expect(memberSpy).not.toHaveBeenCalled();
    expect(created).toBeNull();
  });

  it('B2: membership employee → 403, 0 mutaciones', async () => {
    const { company, token } = await asUser('rc21-post-employee@example.com', 'employee');
    const userSpy = vi.spyOn(db.user, 'create');
    const memberSpy = vi.spyOn(db.companyMember, 'create');

    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(inviteBody('rc21-victim-b@example.com')),
      }),
      { params: Promise.resolve({}) },
    );
    log('B2 POST employee status:', res.status);
    expect(res.status).toBe(403);
    expect(userSpy).not.toHaveBeenCalled();
    expect(memberSpy).not.toHaveBeenCalled();
  });

  it('B3: membership company_admin → invite flow allowed (201)', async () => {
    const { company, token } = await asUser('rc21-post-admin@example.com', 'company_admin');
    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(inviteBody('rc21-victim-c@example.com')),
      }),
      { params: Promise.resolve({}) },
    );
    const created = await db.user.findUnique({ where: { email: 'rc21-victim-c@example.com' } });
    log('B3 POST admin status:', res.status, '| victim role:', created?.platformRole);
    expect(res.status).toBe(201);
    expect(created).not.toBeNull();
  });

  it('B4: super_admin WITHOUT membership → invite flow allowed (201)', async () => {
    const { company } = await asUser('rc21-seed-other2@example.com', 'company_admin');
    const { token } = await asSuperAdmin('rc21-super-post@example.com');
    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(inviteBody('rc21-victim-d@example.com')),
      }),
      { params: Promise.resolve({}) },
    );
    log('B4 POST super_admin status:', res.status);
    expect(res.status).toBe(201);
  });

  it('B5: User.role=company_admin + membership viewer → 403 (D2 case at POST)', async () => {
    const { company, token } = await asUser('rc21-post-global-admin@example.com', 'viewer');
    const userSpy = vi.spyOn(db.user, 'create');
    const memberSpy = vi.spyOn(db.companyMember, 'create');

    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(inviteBody('rc21-victim-e@example.com')),
      }),
      { params: Promise.resolve({}) },
    );
    log('B5 POST User.role=company_admin + membership viewer status:', res.status);
    expect(res.status).toBe(403);
    expect(userSpy).not.toHaveBeenCalled();
    expect(memberSpy).not.toHaveBeenCalled();
  });
});

describe('RC2-1 — Settings PUT: tenant authority via CompanyMember.role only', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  const updateBody = () => ({ legalName: 'Updated Legal Name' });

  it('C1: membership viewer → 403, 0 company.update + 0 auditLog.create', async () => {
    const { company, token } = await asUser('rc21-st-viewer@example.com', 'viewer');
    const updateSpy = vi.spyOn(db.company, 'update');
    const auditSpy = vi.spyOn(db.auditLog, 'create');

    const res = await settingsPUT(
      new NextRequest(`http://localhost/api/settings?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(updateBody()),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('C1 settings viewer status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('C2: membership employee → 403, 0 writes', async () => {
    const { company, token } = await asUser('rc21-st-employee@example.com', 'employee');
    const updateSpy = vi.spyOn(db.company, 'update');
    const auditSpy = vi.spyOn(db.auditLog, 'create');

    const res = await settingsPUT(
      new NextRequest(`http://localhost/api/settings?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(updateBody()),
      }),
      { params: Promise.resolve({}) },
    );
    log('C2 settings employee status:', res.status);
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('C3: platform user (non-super_admin) + membership viewer → 403 (isolation from global role)', async () => {
    const { company, token } = await asUser('rc21-st-global-admin@example.com', 'viewer');
    const res = await settingsPUT(
      new NextRequest(`http://localhost/api/settings?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(updateBody()),
      }),
      { params: Promise.resolve({}) },
    );
    log('C3 settings platform user + viewer status:', res.status);
    expect(res.status).toBe(403);
  });

  it('C4: membership company_admin → allowed, company updated', async () => {
    const { company, token } = await asUser('rc21-st-admin@example.com', 'company_admin');
    const res = await settingsPUT(
      new NextRequest(`http://localhost/api/settings?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(updateBody()),
      }),
      { params: Promise.resolve({}) },
    );
    const updated = await db.company.findUnique({ where: { id: company.id } });
    log('C4 settings admin status:', res.status, '| legalName after:', updated?.legalName);
    expect(res.status).toBe(200);
    expect(updated?.legalName).toBe('Updated Legal Name');
  });

  it('C5: super_admin WITHOUT membership → allowed (200)', async () => {
    const { company } = await asUser('rc21-seed-other3@example.com', 'company_admin');
    const { token } = await asSuperAdmin('rc21-super-st@example.com');
    const res = await settingsPUT(
      new NextRequest(`http://localhost/api/settings?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(updateBody()),
      }),
      { params: Promise.resolve({}) },
    );
    log('C5 settings super_admin status:', res.status);
    expect(res.status).toBe(200);
  });
});

describe('RC2-1 — Assistant Insights: global authority vs tenant authority separation', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  function installMotorSpies() {
    return {
      journalLines: vi.spyOn(db.journalLine, 'findMany'),
      journalAggregate: vi.spyOn(db.journalLine, 'aggregate'),
      bankTxCount: vi.spyOn(db.bankTransaction, 'count'),
      bankAccFindFirst: vi.spyOn(db.bankAccount, 'findFirst'),
    };
  }

  function assertZeroMotorQueries(spies: ReturnType<typeof installMotorSpies>) {
    expect(spies.journalLines).not.toHaveBeenCalled();
    expect(spies.journalAggregate).not.toHaveBeenCalled();
    expect(spies.bankTxCount).not.toHaveBeenCalled();
    expect(spies.bankAccFindFirst).not.toHaveBeenCalled();
  }

  it('D1: membership company_admin → 200, motor executed, normal structure', async () => {
    const { company, token } = await asUser('rc21-ins-admin@example.com', 'company_admin');
    const res = await insightsGET(
      new NextRequest(`http://localhost/api/assistant/insights?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
        body: null,
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('D1 insights company_admin status:', res.status, '| count:', body.insights?.length, '| ids:', JSON.stringify(body.insights?.map((i: { id?: string }) => i.id)));
    expect(res.status).toBe(200);
    expect(Array.isArray(body.insights)).toBe(true);
    expect(body.insights.some((i: { id?: string }) => i.id === 'exec_summary')).toBe(true);
  });

  it('D2: super_admin WITHOUT membership → 200, motor executed', async () => {
    const { company } = await asUser('rc21-seed-other4@example.com', 'company_admin');
    const { token } = await asSuperAdmin('rc21-super-ins@example.com');
    const res = await insightsGET(
      new NextRequest(`http://localhost/api/assistant/insights?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
        body: null,
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('D2 insights super_admin w/o membership status:', res.status, '| count:', body.insights?.length);
    expect(res.status).toBe(200);
    expect(Array.isArray(body.insights)).toBe(true);
  });

  it('D3: membership employee → 200 + insights:[], 0 motor queries', async () => {
    const { company, token } = await asUser('rc21-ins-employee@example.com', 'employee');
    const spies = installMotorSpies();
    const res = await insightsGET(
      new NextRequest(`http://localhost/api/assistant/insights?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
        body: null,
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('D3 insights employee status:', res.status, '| body:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(body.insights).toEqual([]);
    assertZeroMotorQueries(spies);
  });

  it('D4: membership viewer → 200 + insights:[], 0 motor queries', async () => {
    const { company, token } = await asUser('rc21-ins-viewer@example.com', 'viewer');
    const spies = installMotorSpies();
    const res = await insightsGET(
      new NextRequest(`http://localhost/api/assistant/insights?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
        body: null,
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('D4 insights viewer status:', res.status, '| body:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(body.insights).toEqual([]);
    assertZeroMotorQueries(spies);
  });

  it('D5: no membership + non-super_admin → 200 + insights:[], 0 motor queries', async () => {
    const user = await createTestUser('rc21-ins-nomember@example.com');
    const company = await createTestCompany('RC21 NoMember Co');
    const token = await createSession(user.id);
    const spies = installMotorSpies();
    const res = await insightsGET(
      new NextRequest(`http://localhost/api/assistant/insights?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
        body: null,
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('D5 insights no-membership status:', res.status, '| body:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(body.insights).toEqual([]);
    assertZeroMotorQueries(spies);
  });
});