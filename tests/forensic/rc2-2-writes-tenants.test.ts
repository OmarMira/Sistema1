import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { AuthService } from '@/lib/services/auth.service';
import type { RegisterInput } from '@/lib/validations/auth';
import { POST as invitePOST } from '@/app/api/users/route';
import { POST as adminUsersPOST } from '@/app/api/admin/users/route';
import { PATCH as adminUsersPATCH } from '@/app/api/admin/users/[id]/route';
import { POST as adminMembersPOST } from '@/app/api/admin/companies/[id]/users/route';
import {
  createTestUser,
  createTestCompany,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-RC22]', ...args);

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function asSuperAdmin(email: string) {
  const user = await db.user.create({
    data: {
      email,
      passwordHash: 'hashed_password_placeholder',
      firstName: 'Super',
      lastName: 'Admin',
      role: 'super_admin',
    },
  });
  const token = await createSession(user.id);
  return { user, token };
}

async function asCompanyAdmin(email: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany('RC22 Tenant');
  await db.companyMember.create({
    data: { userId: user.id, companyId: company.id, role: 'company_admin' },
  });
  const token = await createSession(user.id);
  return { user, company, token };
}

describe('RC2-2 — REGISTER write path', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it('W1.1: register writes User.role=user and CompanyMember.role=company_admin', async () => {
    const result = await AuthService.register({
      email: 'rc22-register@example.com',
      password: 'password123',
      firstName: 'Reg',
      lastName: 'User',
      companyName: 'RC22 Register Co',
      taxId: '12-3456789',
      entityType: 'BUSINESS',
    } as RegisterInput);

    const user = await db.user.findUnique({
      where: { id: result.user.id },
      select: { role: true },
    });
    const member = await db.companyMember.findFirst({
      where: { userId: result.user.id },
      select: { role: true },
    });
    log('W1.1 global role:', user?.role, '| membership role:', member?.role);
    expect(user?.role).toBe('user');
    expect(member?.role).toBe('company_admin');
  });
});

describe('RC2-2 — INVITE write path', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it('W2.1: new invite writes User.role=user, requested role ONLY on membership', async () => {
    const { company, token } = await asCompanyAdmin('rc22-inviter@example.com');
    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          email: 'rc22-invite-new@example.com',
          firstName: 'Inv',
          lastName: 'User',
          password: 'password123',
          role: 'viewer',
        }),
      }),
      { params: Promise.resolve({}) },
    );
    const created = await db.user.findUnique({
      where: { email: 'rc22-invite-new@example.com' },
      select: { role: true, companyMemberships: { select: { role: true } } },
    });
    log('W2.1 status:', res.status, '| global:', created?.role, '| membership:', created?.companyMemberships[0]?.role);
    expect(res.status).toBe(201);
    expect(created?.role).toBe('user');
    expect(created?.companyMemberships[0]?.role).toBe('viewer');
  });

  it('W2.2: invite existing user does NOT change User.role', async () => {
    const { company, token } = await asCompanyAdmin('rc22-inviter2@example.com');
    const existing = await db.user.create({
      data: {
        email: 'rc22-invite-exists@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Exist',
        lastName: 'User',
        role: 'super_admin',
      },
    });

    const res = await invitePOST(
      new NextRequest(`http://localhost/api/users?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          email: existing.email,
          firstName: 'Exist',
          lastName: 'User',
          password: 'password123',
          role: 'employee',
        }),
      }),
      { params: Promise.resolve({}) },
    );

    const after = await db.user.findUnique({
      where: { id: existing.id },
      select: { role: true, companyMemberships: { select: { role: true } } },
    });
    log('W2.2 status:', res.status, '| global preserved:', after?.role, '| membership:', after?.companyMemberships.at(-1)?.role);
    expect(res.status).toBe(201);
    expect(after?.role).toBe('super_admin');
    expect(after?.companyMemberships.at(-1)?.role).toBe('employee');
  });
});

describe('RC2-2 — ADMIN USERS write path (User.role whitelist)', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  const bodyJson = (overrides: Record<string, string>) =>
    JSON.stringify({
      email: 'rc22-admin-user@example.com',
      firstName: 'Adm',
      lastName: 'User',
      password: 'password123',
      role: 'user',
      ...overrides,
    });

  it('W3.1: create user → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super1@example.com');
    const res = await adminUsersPOST(
      new NextRequest('http://localhost/api/admin/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: bodyJson({}),
      }),
      { params: Promise.resolve({}) },
    );
    log('W3.1 create user status:', res.status);
    expect(res.status).toBe(201);
  });

  it('W3.2: create super_admin → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super2@example.com');
    const res = await adminUsersPOST(
      new NextRequest('http://localhost/api/admin/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: bodyJson({ role: 'super_admin' }),
      }),
      { params: Promise.resolve({}) },
    );
    log('W3.2 create super_admin status:', res.status);
    expect(res.status).toBe(201);
  });

  it('W3.3: create company_admin as User.role → 400', async () => {
    const { token } = await asSuperAdmin('rc22-super3@example.com');
    const res = await adminUsersPOST(
      new NextRequest('http://localhost/api/admin/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: bodyJson({ role: 'company_admin' }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('W3.3 create company_admin status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
    const created = await db.user.findUnique({ where: { email: 'rc22-admin-user@example.com' } });
    expect(created).toBeNull();
  });

  it('W3.4: patch to user → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super4@example.com');
    const target = await createTestUser('rc22-patch-user@example.com');
    const res = await adminUsersPATCH(
      new NextRequest(`http://localhost/api/admin/users/${target.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ role: 'user', firstName: 'Patched' }),
      }),
      { params: Promise.resolve({ id: target.id }) },
    );
    log('W3.4 patch user status:', res.status);
    expect(res.status).toBe(200);
  });

  it('W3.5: patch to super_admin → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super5@example.com');
    const target = await createTestUser('rc22-patch-super@example.com');
    const res = await adminUsersPATCH(
      new NextRequest(`http://localhost/api/admin/users/${target.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ role: 'super_admin', firstName: 'PatchedSuper' }),
      }),
      { params: Promise.resolve({ id: target.id }) },
    );
    log('W3.5 patch super_admin status:', res.status);
    expect(res.status).toBe(200);
  });

  it('W3.6: patch to company_admin → 400, User.role unchanged', async () => {
    const { token } = await asSuperAdmin('rc22-super6@example.com');
    const target = await db.user.create({
      data: {
        email: 'rc22-patch-admin@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Patch',
        lastName: 'Base',
        role: 'user',
      },
    });
    const res = await adminUsersPATCH(
      new NextRequest(`http://localhost/api/admin/users/${target.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ role: 'company_admin', firstName: 'PatchedBad' }),
      }),
      { params: Promise.resolve({ id: target.id }) },
    );
    const body = await res.json();
    log('W3.6 patch company_admin status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
    const after = await db.user.findUnique({ where: { id: target.id } });
    expect(after?.role).toBe('user');
  });
});

describe('RC2-2 — ADMIN MEMBERSHIP write path (CompanyMember.role whitelist)', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  async function assignAs(token: string, companyId: string, role: string) {
    const target = await createTestUser(`rc22-mem-${role}-member@example.com`);
    return adminMembersPOST(
      new NextRequest(`http://localhost/api/admin/companies/${companyId}/users`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ userId: target.id, role }),
      }),
      { params: Promise.resolve({ id: companyId }) },
    );
  }

  it('W4.1: company_admin membership → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super-mem1@example.com');
    const company = await createTestCompany('RC22 Mem Co');
    const res = await assignAs(token, company.id, 'company_admin');
    log('W4.1 company_admin status:', res.status);
    expect(res.status).toBe(201);
  });

  it('W4.2: employee membership → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super-mem2@example.com');
    const company = await createTestCompany('RC22 Mem Co 2');
    const res = await assignAs(token, company.id, 'employee');
    log('W4.2 employee status:', res.status);
    expect(res.status).toBe(201);
  });

  it('W4.3: viewer membership → allowed', async () => {
    const { token } = await asSuperAdmin('rc22-super-mem3@example.com');
    const company = await createTestCompany('RC22 Mem Co 3');
    const res = await assignAs(token, company.id, 'viewer');
    log('W4.3 viewer status:', res.status);
    expect(res.status).toBe(201);
  });

  it('W4.4: super_admin membership → 400', async () => {
    const { token } = await asSuperAdmin('rc22-super-mem4@example.com');
    const company = await createTestCompany('RC22 Mem Co 4');
    const res = await assignAs(token, company.id, 'super_admin');
    const body = await res.json();
    log('W4.4 super_admin status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
  });

  it('W4.5: arbitrary string membership → 400', async () => {
    const { token } = await asSuperAdmin('rc22-super-mem5@example.com');
    const company = await createTestCompany('RC22 Mem Co 5');
    const res = await assignAs(token, company.id, 'root');
    const body = await res.json();
    log('W4.5 arbitrary status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
  });
});