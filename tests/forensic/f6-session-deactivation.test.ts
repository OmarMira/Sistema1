import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { hasCompanyAccess } from '@/lib/auth';
import { proxy } from '@/proxy';
import { GET as journalGET } from '@/app/api/journal/route';
import { GET as accountsGET } from '@/app/api/accounts/route';
import { GET as reportGET } from '@/app/api/reconciliation/report/route';
import { GET as diagnosticsGET } from '@/app/api/diagnostics/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const createdCompanyIds = new Set<string>();

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function makeSuperAdmin(userId: string) {
  return db.user.update({ where: { id: userId }, data: { role: 'super_admin' } });
}

describe('F-6 — Session activity validation (deactivation must invalidate access)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    if (ids.length === 0) return;
    const filter = { companyId: { in: ids } };
    await db.journalLine.deleteMany({ where: { entry: filter } }).catch(() => {});
    await db.journalEntry.deleteMany({ where: filter }).catch(() => {});
    await db.glAccount.deleteMany({ where: filter }).catch(() => {});
    await db.companyMember.deleteMany({ where: filter }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  });

  afterAll(async () => {
    const leftoverUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    log('AFTER-ALL DB STATE: users =', leftoverUsers);
  });

  it('guard control: hasCompanyAccess blocks deactivated users (dead code in production)', async () => {
    const user = await createTestUser('guard-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    const blocked = await hasCompanyAccess(user.id, company.id);
    log('CONTROL: hasCompanyAccess(user.isActive=false) =', blocked);
    expect(blocked).toBe(false);

    await db.user.update({ where: { id: user.id }, data: { isActive: true } });
    const allowed = await hasCompanyAccess(user.id, company.id);
    log('CONTROL: hasCompanyAccess(user.isActive=true) =', allowed);
    expect(allowed).toBe(true);
  });

  it('REQUIRED: deactivated user must get 401 on tenant route (GET /api/journal)', async () => {
    const user = await createTestUser('deact-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    log('SEEDED: user.isActive=false | session created BEFORE deactivation');

    const res = await journalGET(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('TENANT ROUTE: deactivated user GET /api/journal -> status =', res.status);
    expect(res.status).toBe(401);
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('pagination');
  });

  it('REQUIRED: deactivated super_admin must get 401 (no bypass for user activity)', async () => {
    const user = await createTestUser('super-deact-f6@example.com');
    await makeSuperAdmin(user.id);
    const company = await createTestCompany('Deactiv Corp');
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    log('SEEDED: super_admin isActive=false | session created BEFORE deactivation');

    const res = await journalGET(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('SUPER_ADMIN DEACTIVATED: GET /api/journal -> status =', res.status);
    expect(res.status).toBe(401);
  });

  it('REQUIRED: normal member of deactivated company must get 403 (GET /api/accounts)', async () => {
    const user = await createTestUser('member-deact-company-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    log('SEEDED: company.isActive=false | user isActive=true | session valid');

    const res = await accountsGET(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('DEACTIVATED COMPANY: member GET /api/accounts -> status =', res.status);
    expect(res.status).toBe(403);
  });

  it('CONTROL: active super_admin (NO membership) keeps access to deactivated company -> 200', async () => {
    const user = await createTestUser('super-active-f6@example.com');
    await makeSuperAdmin(user.id);
    const company = await createTestCompany('Deactiv Corp');
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    const membershipRows = await db.companyMember.count({ where: { userId: user.id } });
    log('SEEDED: super_admin active, NO membership rows =', membershipRows, '| company.isActive=false');

    const res = await accountsGET(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('SUPER_ADMIN + DEACTIVATED COMPANY: GET /api/accounts -> status =', res.status);
    expect(res.status).toBe(200);
  });

  it('CONTROL: removed membership keeps returning 403 (GET /api/journal)', async () => {
    const user = await createTestUser('no-membership-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.companyMember.deleteMany({ where: { userId: user.id } });
    log('SEEDED: session valid | membership row REMOVED');

    const res = await journalGET(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('REMOVED MEMBERSHIP: GET /api/journal -> status =', res.status);
    expect(res.status).toBe(403);
  });

  it('CONTROL: expired session keeps returning 401 without business execution (GET /api/journal)', async () => {
    const user = await createTestUser('expired-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    log('SEEDED: session EXPIRED (expiresAt in the past)');

    const res = await journalGET(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('EXPIRED SESSION: GET /api/journal -> status =', res.status);
    expect(res.status).toBe(401);
    expect(body).not.toHaveProperty('data');
  });

  it('REQUIRED: deactivated user must get 401 on direct reconciliation route (GET /api/reconciliation/report)', async () => {
    const user = await createTestUser('recon-deact-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    const gl = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const bank = await createTestBankAccount(company.id, gl.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    log('SEEDED: user.isActive=false | bankAccountId =', bank.id, '| companyId =', company.id);

    const res = await reportGET(
      new NextRequest(
        `http://localhost/api/reconciliation/report?bankAccountId=${bank.id}&companyId=${company.id}`,
        { method: 'GET', headers: authHeaders(token) },
      ),
    );
    log('DIRECT ROUTE: deactivated user GET /api/reconciliation/report -> status =', res.status);
    expect(res.status).toBe(401);
  });

  it('REQUIRED: deactivated user must get 401 on global route without company (GET /api/diagnostics)', async () => {
    const user = await createTestUser('global-deact-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    log('SEEDED: user.isActive=false | GET /api/diagnostics (requireMembership:false)');

    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    log('GLOBAL ROUTE: deactivated user GET /api/diagnostics -> status =', res.status);
    expect(res.status).toBe(401);
  });

  it('CONTROL: proxy only checks session presence (unchanged behavior, deactivated user still proxied)', async () => {
    const user = await createTestUser('proxy-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });

    const proxied = await proxy(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
    );
    log('PROXY CHECK: deactivated user GET /api/journal -> proxy status =', proxied.status);
    expect(proxied.status).toBe(200);
  });
});
