import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { hasCompanyAccess } from '@/lib/auth';
import { proxy } from '@/proxy';
import { GET as journalGET } from '@/app/api/journal/route';
import { GET as accountsGET } from '@/app/api/accounts/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
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

describe('F-6 — Sessions remain valid after user/company deactivation (dynamic PoC)', () => {
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
    const leftoverCompanies = await db.company.count({ where: { legalName: { in: ['Deactiv Corp'] } } });
    log('AFTER-ALL DB STATE: users =', leftoverUsers, '| deactivated companies =', leftoverCompanies);
  });

  it('hasCompanyAccess (the guard that checks isActive) is never called by the API layer', async () => {
    // Static-control assertion: the guard exists but is unreferenced (checked via grep earlier).
    // Here we only verify its behavior for the report: it WOULD block a deactivated user.
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

  it('a deactivated user can still use a valid session against a protected route (GET /api/journal)', async () => {
    const user = await createTestUser('deact-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    // Create a session BEFORE deactivation
    const token = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    const deactivated = await db.user.findUnique({ where: { id: user.id }, select: { isActive: true } });
    log('SEEDED: user.isActive =', deactivated?.isActive, '| session created BEFORE deactivation');

    // 1. proxy: only checks session presence
    const proxied = await proxy(new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
      method: 'GET',
      headers: authHeaders(token),
    }));
    log('PROXY CHECK: deactivated user GET /api/journal -> proxy status =', proxied.status);

    // 2. route: apiHandler resolves the session (expiry only) and membership (exists) — no isActive
    const res = await journalGET(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('ROUTE CHECK: deactivated user GET /api/journal -> status =', res.status, '| body keys =', JSON.stringify(Object.keys(body ?? {})));
    log('SESSION STILL VALID AFTER USER DEACTIVATION:', res.status === 200);
    expect(res.status).toBe(200);
  });

  it('a member of a deactivated company can still use a valid session (GET /api/accounts)', async () => {
    const user = await createTestUser('deact-corp-f6@example.com');
    const company = await createTestCompany('Deactiv Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    const deactivated = await db.company.findUnique({ where: { id: company.id }, select: { isActive: true } });
    log('SEEDED: company.isActive =', deactivated?.isActive, '| user isActive = true | session valid');

    const res = await accountsGET(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('ROUTE CHECK: member of deactivated company GET /api/accounts -> status =', res.status, '| accounts =', JSON.stringify(body.accounts));
    log('SESSION STILL VALID AFTER COMPANY DEACTIVATION:', res.status === 200);
    expect(res.status).toBe(200);
  });
});
