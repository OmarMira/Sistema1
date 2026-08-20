import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { createSession, deleteAllUserSessions } from '@/lib/sessions';
import { authRateLimiter } from '@/lib/rate-limiter';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as passwordPOST } from '@/app/api/settings/password/route';
import { PATCH as adminPatchUser } from '@/app/api/admin/users/[id]/route';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';
import { GET as journalGET } from '@/app/api/journal/route';
import { clearDatabase } from '../helpers/factories';

// Partial mock of the sessions module: the real implementation is preserved,
// but deleteAllUserSessions can be forced to throw INSIDE the route's
// db.$transaction to prove the password update + audit + session deletion
// roll back together atomically.
const sessionsMock = vi.hoisted(() => ({ failNextDeleteAll: false }));
vi.mock('@/lib/sessions', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/sessions')>();
  return {
    ...mod,
    deleteAllUserSessions: async (
      userId: string,
      client?: Parameters<typeof mod.deleteAllUserSessions>[1],
    ): Promise<number> => {
      if (sessionsMock.failNextDeleteAll) {
        sessionsMock.failNextDeleteAll = false;
        throw new Error('forced session.deleteMany failure (transaction rollback)');
      }
      return mod.deleteAllUserSessions(userId, client);
    },
  };
});

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const createdUserIds = new Set<string>();
const createdCompanyIds = new Set<string>();

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

async function createUserWithPassword(email: string, password: string, platformRole = 'user') {
  const passwordHash = await hashPassword(password);
  const user = await db.user.create({
    data: { email, passwordHash, firstName: 'F8', lastName: 'Test', platformRole },
  });
  createdUserIds.add(user.id);
  return user;
}

async function createMembership(userId: string, companyId: string) {
  await db.companyMember.create({ data: { userId, companyId, role: 'company_admin' } });
}

async function journalStatus(token: string, companyId: string): Promise<number> {
  const res = await journalGET(buildRequest(`http://localhost/api/journal?companyId=${companyId}`, 'GET', token));
  return res.status;
}

describe('F-8 — password changes invalidate ALL sessions (policy C, RED)', () => {
  beforeEach(async () => {
    sessionsMock.failNextDeleteAll = false;
    authRateLimiter.clear();
    await clearDatabase();
  });

  afterEach(async () => {
    authRateLimiter.clear();
    const userIds = [...createdUserIds];
    createdUserIds.clear();
    if (userIds.length > 0) {
      await db.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
      await db.auditLog.deleteMany({ where: { action: 'change_password', userId: { in: userIds } } }).catch(() => {});
      await db.auditLog.deleteMany({ where: { action: 'update_user', userId: { in: userIds } } }).catch(() => {});
    }
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
    log('AFTER-ALL DB STATE: sessions for test users =', sessions);
  });

  it('V1: voluntary password change invalidates ALL existing sessions (current included) -> both 401', async () => {
    const user = await createUserWithPassword('f8-v1@example.com', 'ViejaPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 V1 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await createMembership(user.id, company.id);

    const tokenA = await createSession(user.id);
    const tokenB = await createSession(user.id);
    const before = await db.session.count({ where: { userId: user.id } });
    log('V1-SEEDED: active sessions before change =', before);

    const change = await passwordPOST(
      buildRequest('http://localhost/api/settings/password', 'POST', tokenA, {
        currentPassword: 'ViejaPass1!',
        newPassword: 'NuevaPass2!',
      }),
      { params: Promise.resolve({}) },
    );
    const after = await db.session.count({ where: { userId: user.id } });

    const statusA = await journalStatus(tokenA, company.id);
    const statusB = await journalStatus(tokenB, company.id);
    log('V1: change status =', change.status, '| sessions after change =', after, '| tokenA journal ->', statusA, '| tokenB journal ->', statusB);
    expect(change.status).toBe(200);
    expect(after).toBe(0);
    expect(statusA).toBe(401);
    expect(statusB).toBe(401);
  });

  it('V2: old password stops working; new password creates a working session', async () => {
    const user = await createUserWithPassword('f8-v2@example.com', 'ViejaPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 V2 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await createMembership(user.id, company.id);

    const token = await createSession(user.id);
    const change = await passwordPOST(
      buildRequest('http://localhost/api/settings/password', 'POST', token, {
        currentPassword: 'ViejaPass1!',
        newPassword: 'NuevaPass2!',
      }),
      { params: Promise.resolve({}) },
    );

    const oldLogin = await loginPOST(
      buildRequest('http://localhost/api/auth/login', 'POST', null, { email: user.email, password: 'ViejaPass1!' }, { 'x-forwarded-for': '10.9.5.1' }),
      { params: Promise.resolve({}) },
    );
    const newLogin = await loginPOST(
      buildRequest('http://localhost/api/auth/login', 'POST', null, { email: user.email, password: 'NuevaPass2!' }, { 'x-forwarded-for': '10.9.5.2' }),
      { params: Promise.resolve({}) },
    );
    const newToken = newLogin.cookies.get('session')?.value ?? null;
    const statusNew = newToken ? await journalStatus(newToken, company.id) : -1;

    log('V2: change =', change.status, '| old login ->', oldLogin.status, '| new login ->', newLogin.status, '| new session on journal ->', statusNew);
    expect(change.status).toBe(200);
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
    expect(statusNew).toBe(200);
  });

  it('A1: admin password reset invalidates ALL sessions of the target user (RED today)', async () => {
    const admin = await createUserWithPassword('f8-admin@example.com', 'AdminPass1!', 'super_admin');
    const target = await createUserWithPassword('f8-target@example.com', 'TargetPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 A1 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await createMembership(target.id, company.id);

    const adminToken = await createSession(admin.id);
    const targetTokenA = await createSession(target.id);
    const targetTokenB = await createSession(target.id);
    log('A1-SEEDED: target sessions before reset =', await db.session.count({ where: { userId: target.id } }));

    const patch = await adminPatchUser(
      buildRequest(`http://localhost/api/admin/users/${target.id}`, 'PATCH', adminToken, { password: 'ResetPass9!' }),
      { params: Promise.resolve({ id: target.id }) },
    );
    const after = await db.session.count({ where: { userId: target.id } });

    const statusA = await journalStatus(targetTokenA, company.id);
    const statusB = await journalStatus(targetTokenB, company.id);
    log('A1: reset status =', patch.status, '| target sessions after reset =', after, '| targetTokenA ->', statusA, '| targetTokenB ->', statusB);
    expect(patch.status).toBe(200);
    expect(after).toBe(0);
    expect(statusA).toBe(401);
    expect(statusB).toBe(401);
  });

  it('S1: deleteAllUserSessions removes every session for one user and leaves other users intact', async () => {
    const userA = await createUserWithPassword('f8-s1a@example.com', 'ViejaPass1!');
    const userB = await createUserWithPassword('f8-s1b@example.com', 'ViejaPass1!');
    await createSession(userA.id);
    await createSession(userA.id);
    await createSession(userA.id);
    await createSession(userB.id);
    log('S1-SEEDED: sessions A =', await db.session.count({ where: { userId: userA.id } }), '| B =', await db.session.count({ where: { userId: userB.id } }));

    const deleted = await deleteAllUserSessions(userA.id);
    const afterA = await db.session.count({ where: { userId: userA.id } });
    const afterB = await db.session.count({ where: { userId: userB.id } });
    log('S1: deleted =', deleted, '| sessions A after =', afterA, '| sessions B after =', afterB);
    expect(deleted).toBe(3);
    expect(afterA).toBe(0);
    expect(afterB).toBe(1);
  });

  it('N1: admin update WITHOUT password does NOT invalidate sessions (contract guard)', async () => {
    const admin = await createUserWithPassword('f8-n1admin@example.com', 'AdminPass1!', 'super_admin');
    const target = await createUserWithPassword('f8-n1@example.com', 'TargetPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 N1 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await createMembership(target.id, company.id);

    const adminToken = await createSession(admin.id);
    const tokenA = await createSession(target.id);
    const tokenB = await createSession(target.id);

    const patch = await adminPatchUser(
      buildRequest(`http://localhost/api/admin/users/${target.id}`, 'PATCH', adminToken, { firstName: 'Renamed' }),
      { params: Promise.resolve({ id: target.id }) },
    );
    const after = await db.session.count({ where: { userId: target.id } });
    const updated = await db.user.findUnique({ where: { id: target.id }, select: { firstName: true, passwordHash: true } });
    const statusA = await journalStatus(tokenA, company.id);
    const statusB = await journalStatus(tokenB, company.id);

    log('N1: patch(firstName) status =', patch.status, '| firstName now =', updated?.firstName, '| sessions after =', after, '| tokenA ->', statusA, '| tokenB ->', statusB);
    expect(patch.status).toBe(200);
    expect(updated?.firstName).toBe('Renamed');
    expect(after).toBe(2);
    expect(statusA).toBe(200);
    expect(statusB).toBe(200);
  });

  it('R1: voluntary change rolls back hash, sessions and audit when session deletion fails', async () => {
    const user = await createUserWithPassword('f8-r1@example.com', 'ViejaPass1!');
    const tokenA = await createSession(user.id);
    await createSession(user.id);
    const beforeHash = (await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }))?.passwordHash;
    const beforeSessions = await db.session.count({ where: { userId: user.id } });

    sessionsMock.failNextDeleteAll = true;
    const res = await passwordPOST(
      buildRequest('http://localhost/api/settings/password', 'POST', tokenA, {
        currentPassword: 'ViejaPass1!',
        newPassword: 'NuevaPass2!',
      }),
      { params: Promise.resolve({}) },
    );

    const afterHash = (await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }))?.passwordHash;
    const afterSessions = await db.session.count({ where: { userId: user.id } });
    const audits = await db.auditLog.count({ where: { action: 'change_password', userId: user.id } });
    log('R1: status =', res.status, '| hash unchanged =', afterHash === beforeHash, '| sessions =', afterSessions, '| change_password audits =', audits);
    expect(res.status).not.toBe(200);
    expect(afterHash).toBe(beforeHash);
    expect(afterSessions).toBe(beforeSessions);
    expect(audits).toBe(0);
  });

  it('R2: admin reset rolls back hash, sessions and audit when session deletion fails', async () => {
    const admin = await createUserWithPassword('f8-r2admin@example.com', 'AdminPass1!', 'super_admin');
    const target = await createUserWithPassword('f8-r2@example.com', 'TargetPass1!');
    const adminToken = await createSession(admin.id);
    await createSession(target.id);
    await createSession(target.id);
    const beforeHash = (await db.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } }))?.passwordHash;
    const beforeSessions = await db.session.count({ where: { userId: target.id } });

    sessionsMock.failNextDeleteAll = true;
    const res = await adminPatchUser(
      buildRequest(`http://localhost/api/admin/users/${target.id}`, 'PATCH', adminToken, { password: 'ResetPass9!' }),
      { params: Promise.resolve({ id: target.id }) },
    );

    const afterHash = (await db.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } }))?.passwordHash;
    const afterSessions = await db.session.count({ where: { userId: target.id } });
    const audits = await db.auditLog.count({ where: { action: 'update_user', entityId: target.id } });
    log('R2: status =', res.status, '| hash unchanged =', afterHash === beforeHash, '| sessions =', afterSessions, '| update_user audits =', audits);
    expect(res.status).not.toBe(200);
    expect(afterHash).toBe(beforeHash);
    expect(afterSessions).toBe(beforeSessions);
    expect(audits).toBe(0);
  });

  it('L1: logout still invalidates ONLY the presented session (unchanged behavior)', async () => {
    const user = await createUserWithPassword('f8-l1@example.com', 'ViejaPass1!');
    const company = await db.company.create({ data: { legalName: 'F8 L1 Co', entityType: 'BUSINESS', taxId: '12-3456789' } });
    createdCompanyIds.add(company.id);
    await createMembership(user.id, company.id);

    const tokenA = await createSession(user.id);
    const tokenB = await createSession(user.id);
    const before = await db.session.count({ where: { userId: user.id } });

    const logout = await logoutPOST(buildRequest('http://localhost/api/auth/logout', 'POST', tokenA));
    const after = await db.session.count({ where: { userId: user.id } });
    const statusA = await journalStatus(tokenA, company.id);
    const statusB = await journalStatus(tokenB, company.id);

    log('L1: sessions before logout =', before, '| logout status =', logout.status, '| after =', after, '| logged-out ->', statusA, '| sibling ->', statusB);
    expect(logout.status).toBe(200);
    expect(after).toBe(before - 1);
    expect(statusA).toBe(401);
    expect(statusB).toBe(200);
  });
});
