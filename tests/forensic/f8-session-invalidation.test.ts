import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { createSession } from '@/lib/sessions';
import { authRateLimiter } from '@/lib/rate-limiter';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as passwordPOST } from '@/app/api/settings/password/route';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';
import { GET as journalGET } from '@/app/api/journal/route';
import { clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const createdUserIds = new Set<string>();
const createdCompanyIds = new Set<string>();

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function buildRequest(
  url: string,
  method: string,
  token: string | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new NextRequest(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createUserWithPassword(email: string, password: string) {
  const passwordHash = await hashPassword(password);
  const user = await db.user.create({
    data: { email, passwordHash, firstName: 'F8', lastName: 'Test', role: 'company_admin' },
  });
  createdUserIds.add(user.id);
  return user;
}

describe('F-8 — Sessions survive password change; logout destroys only the presented token (dynamic PoC)', () => {
  beforeEach(async () => {
    authRateLimiter.clear();
    await clearDatabase();
  });

  afterEach(async () => {
    authRateLimiter.clear();
    const userIds = [...createdUserIds];
    createdUserIds.clear();
    await db.auditLog.deleteMany({ where: { action: 'change_password', userId: { in: userIds } } }).catch(() => {});
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:10.9' } } }).catch(() => {});
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'email:f8-' } } }).catch(() => {});
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    if (ids.length > 0) {
      const filter = { companyId: { in: ids } };
      await db.journalLine.deleteMany({ where: { entry: filter } }).catch(() => {});
      await db.journalEntry.deleteMany({ where: filter }).catch(() => {});
      await db.companyMember.deleteMany({ where: filter }).catch(() => {});
      await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    }
    await clearDatabase();
  });

  afterAll(async () => {
    const sessions = await db.session.count({ where: { user: { email: { contains: '@example.com' } } } });
    const auditChanges = await db.auditLog.count({ where: { action: 'change_password' } });
    log('AFTER-ALL DB STATE: sessions for test users =', sessions, '| change_password audit logs =', auditChanges);
  });

  it('Q1: password change does not delete any existing session (session count unchanged)', async () => {
    const user = await createUserWithPassword('f8-a@example.com', 'ViejaPass1!');
    const token = await createSession(user.id);
    const before = await db.session.count({ where: { userId: user.id } });

    const res = await passwordPOST(
      buildRequest('http://localhost/api/settings/password', 'POST', token, {
        currentPassword: 'ViejaPass1!',
        newPassword: 'NuevaPass2!',
      }),
      { params: Promise.resolve({}) },
    );
    const after = await db.session.count({ where: { userId: user.id } });

    log('Q1: sessions before password change =', before, '| change status =', res.status, '| sessions after =', after);
    expect(res.status).toBe(200);
    expect(after).toBe(before);
  });

  it('Q2: a session created BEFORE the password change still authorizes protected requests', async () => {
    const user = await createUserWithPassword('f8-b@example.com', 'ViejaPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'company_admin' } });

    const tokenBefore = await createSession(user.id);

    const change = await passwordPOST(
      buildRequest('http://localhost/api/settings/password', 'POST', tokenBefore, {
        currentPassword: 'ViejaPass1!',
        newPassword: 'NuevaPass2!',
      }),
      { params: Promise.resolve({}) },
    );

    const res = await journalGET(
      buildRequest(`http://localhost/api/journal?companyId=${company.id}`, 'GET', tokenBefore),
      { params: Promise.resolve({}) },
    );
    log('Q2: password change status =', change.status, '| GET /api/journal with pre-change session ->', res.status);
    log('Q2-SURVIVES: session created before password change still accepted after =', res.status === 200);
    expect(change.status).toBe(200);
    expect(res.status).toBe(200);
  });

  it('Q3 (control): new logins DO respect the new password hash', async () => {
    const user = await createUserWithPassword('f8-c@example.com', 'ViejaPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'company_admin' } });

    const token = await createSession(user.id);
    const change = await passwordPOST(
      buildRequest('http://localhost/api/settings/password', 'POST', token, {
        currentPassword: 'ViejaPass1!',
        newPassword: 'NuevaPass2!',
      }),
      { params: Promise.resolve({}) },
    );

    const oldLogin = await loginPOST(
      buildRequest('http://localhost/api/auth/login', 'POST', null, {
        email: user.email,
        password: 'ViejaPass1!',
      }, { 'x-forwarded-for': '10.9.4.1' }),
      { params: Promise.resolve({}) },
    );
    const newLogin = await loginPOST(
      buildRequest('http://localhost/api/auth/login', 'POST', null, {
        email: user.email,
        password: 'NuevaPass2!',
      }, { 'x-forwarded-for': '10.9.4.2' }),
      { params: Promise.resolve({}) },
    );
    log('Q3: change status =', change.status, '| login with OLD password ->', oldLogin.status, '| login with NEW password ->', newLogin.status);
    expect(change.status).toBe(200);
    expect(oldLogin.status).not.toBe(200);
    expect(newLogin.status).toBe(200);
  });

  it('Q4: logout destroys only the presented session; other sessions remain valid', async () => {
    const user = await createUserWithPassword('f8-d@example.com', 'ViejaPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'company_admin' } });

    const tokenA = await createSession(user.id);
    const tokenB = await createSession(user.id);
    const before = await db.session.count({ where: { userId: user.id } });

    const logout = await logoutPOST(buildRequest('http://localhost/api/auth/logout', 'POST', tokenA));
    const after = await db.session.count({ where: { userId: user.id } });

    const resA = await journalGET(buildRequest(`http://localhost/api/journal?companyId=${company.id}`, 'GET', tokenA), { params: Promise.resolve({}) });
    const resB = await journalGET(buildRequest(`http://localhost/api/journal?companyId=${company.id}`, 'GET', tokenB), { params: Promise.resolve({}) });

    log('Q4: sessions before logout =', before, '| logout status =', logout.status, '| sessions after =', after);
    log('Q4: logged-out token GET /api/journal ->', resA.status, '| sibling token GET /api/journal ->', resB.status);
    log('Q4-ONLY-PRESENTED: other sessions remain valid after logout =', resB.status === 200);
    expect(logout.status).toBe(200);
    expect(after).toBe(before - 1);
    expect(resA.status).not.toBe(200);
    expect(resB.status).toBe(200);
  });
});
