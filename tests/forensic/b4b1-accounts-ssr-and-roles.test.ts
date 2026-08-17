import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

import AccountsServerPage from '@/app/accounts/page';
import { POST as accountsPOST } from '@/app/api/accounts/route';
import { PUT as accountsPUT, DELETE as accountsDELETE } from '@/app/api/accounts/[id]/route';

const log = (...args: unknown[]) => console.log('[EVIDENCE-B4B1]', ...args);

// SSR session cookie state: mocked ONLY at the next/headers boundary.
const cookieState = vi.hoisted(() => ({
  sessionToken: null as string | null,
  companyId: null as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        if (name === 'companyId') {
          return cookieState.companyId ? { name, value: cookieState.companyId } : undefined;
        }
        return cookieState.sessionToken ? { name, value: cookieState.sessionToken } : undefined;
      },
    }),
}));

function mockCookies(sessionToken: string | null, companyId: string | null) {
  cookieState.sessionToken = sessionToken;
  cookieState.companyId = companyId;
}

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

const createdCompanyIds = new Set<string>();

describe('B4B1 — RC5: Accounts SSR never queries glAccount without an authorized tenant', () => {
  let attacker: { id: string };
  let tenantA: { id: string };
  let tenantB: { id: string };
  let findManySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
    mockCookies(null, null);

    attacker = await createTestUser('attacker-b4b1-ssr@example.com');
    tenantA = await createTestCompany('B4B1 SSR Tenant A');
    tenantB = await createTestCompany('B4B1 SSR Tenant B');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);
    createdCompanyIds.add(tenantB.id);

    findManySpy = vi.spyOn(db.glAccount, 'findMany');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it('A. anonymous: 0 glAccount queries even when companyId cookie is forged', async () => {
    await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Victim B Cash' });
    mockCookies(null, tenantB.id);

    await AccountsServerPage();

    expect(findManySpy).not.toHaveBeenCalled();
  });

  it('B. member of A using companyId of B (cross-tenant): 0 glAccount queries', async () => {
    await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Victim B Cash' });
    const token = await createSession(attacker.id);
    mockCookies(token, tenantB.id);

    await AccountsServerPage();

    expect(findManySpy).not.toHaveBeenCalled();
  });

  it('C. deactivated company: 0 glAccount queries', async () => {
    const inactive = await createTestCompany('B4B1 SSR Inactive');
    createdCompanyIds.add(inactive.id);
    await createTestCompanyMember(attacker.id, inactive.id);
    await db.company.update({ where: { id: inactive.id }, data: { isActive: false } });

    const token = await createSession(attacker.id);
    mockCookies(token, inactive.id);

    await AccountsServerPage();

    expect(findManySpy).not.toHaveBeenCalled();
  });

  it('D. missing companyId cookie: fail-closed, 0 glAccount queries', async () => {
    const token = await createSession(attacker.id);
    mockCookies(token, null);

    await AccountsServerPage();

    expect(findManySpy).not.toHaveBeenCalled();
  });

  it('E. authorized member: exactly one query, scoped to own tenant only', async () => {
    await createTestGlAccount({ companyId: tenantA.id, code: '1000', name: 'Own A Cash' });
    await createTestGlAccount({ companyId: tenantB.id, code: '2000', name: 'Victim B Cash' });
    const token = await createSession(attacker.id);
    mockCookies(token, tenantA.id);

    await AccountsServerPage();

    expect(findManySpy).toHaveBeenCalledTimes(1);
    const arg = findManySpy.mock.calls[0][0] as { where: { companyId: string } };
    expect(arg.where.companyId).toBe(tenantA.id);
  });
});

describe('B4B1 — RC3: Accounts write routes require CompanyMember.role company_admin (server-side)', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  async function memberWithRole(email: string, role: 'viewer' | 'employee' | 'company_admin') {
    const user = await createTestUser(email);
    const company = await createTestCompany('B4B1 Role Co');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role } });
    createdCompanyIds.add(company.id);
    const token = await createSession(user.id);
    return { user, company, token };
  }

  async function superAdminWithCompany(email: string) {
    const user = await db.user.create({
      data: {
        email,
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Super',
        lastName: 'Admin',
        role: 'super_admin',
      },
    });
    const company = await createTestCompany('B4B1 Super Co');
    createdCompanyIds.add(company.id);
    const token = await createSession(user.id);
    return { user, company, token };
  }

  const validCreateBody = (companyId: string) => ({
    companyId,
    code: '3000',
    name: 'New Asset Account',
    accountType: 'asset',
    normalBalance: 'debit',
  });

  it('POST: viewer → 403 and 0 create mutations', async () => {
    const { company, token } = await memberWithRole('viewer-b4b1-post@example.com', 'viewer');
    const createSpy = vi.spyOn(db.glAccount, 'create');

    const res = await accountsPOST(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(validCreateBody(company.id)),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('POST viewer status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('POST: employee → 403 and 0 create mutations', async () => {
    const { company, token } = await memberWithRole('employee-b4b1-post@example.com', 'employee');
    const createSpy = vi.spyOn(db.glAccount, 'create');

    const res = await accountsPOST(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(validCreateBody(company.id)),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('POST employee status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('POST: company_admin → 201, account created', async () => {
    const { company, token } = await memberWithRole('admin-b4b1-post@example.com', 'company_admin');
    const createSpy = vi.spyOn(db.glAccount, 'create');

    const res = await accountsPOST(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(validCreateBody(company.id)),
      }),
      { params: Promise.resolve({}) },
    );
    log('POST company_admin status:', res.status);
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('POST: super_admin → 201 via existing bypass', async () => {
    const { company, token } = await superAdminWithCompany('super-b4b1-post@example.com');

    const res = await accountsPOST(
      new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(validCreateBody(company.id)),
      }),
      { params: Promise.resolve({}) },
    );
    log('POST super_admin status:', res.status);
    expect(res.status).toBe(201);
  });

  it('PUT: viewer → 403 and 0 update mutations', async () => {
    const { company, token } = await memberWithRole('viewer-b4b1-put@example.com', 'viewer');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const updateSpy = vi.spyOn(db.glAccount, 'update');

    const res = await accountsPUT(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: company.id, name: 'Hijacked' }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    const body = await res.json();
    log('PUT viewer status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('PUT: employee → 403 and 0 update mutations', async () => {
    const { company, token } = await memberWithRole('employee-b4b1-put@example.com', 'employee');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const updateSpy = vi.spyOn(db.glAccount, 'update');

    const res = await accountsPUT(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: company.id, name: 'Hijacked' }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    const body = await res.json();
    log('PUT employee status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('PUT: company_admin → 200, account updated', async () => {
    const { company, token } = await memberWithRole('admin-b4b1-put@example.com', 'company_admin');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });

    const res = await accountsPUT(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: company.id, name: 'Updated Cash' }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    log('PUT company_admin status:', res.status);
    expect(res.status).toBe(200);
  });

  it('PUT: super_admin → 200 via existing bypass', async () => {
    const { company, token } = await superAdminWithCompany('super-b4b1-put@example.com');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });

    const res = await accountsPUT(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: company.id, name: 'Updated by Super' }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    log('PUT super_admin status:', res.status);
    expect(res.status).toBe(200);
  });

  it('DELETE: viewer → 403 and 0 delete mutations', async () => {
    const { company, token } = await memberWithRole('viewer-b4b1-del@example.com', 'viewer');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const deleteSpy = vi.spyOn(db.glAccount, 'delete');

    const res = await accountsDELETE(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    const body = await res.json();
    log('DELETE viewer status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('DELETE: employee → 403 and 0 delete mutations', async () => {
    const { company, token } = await memberWithRole('employee-b4b1-del@example.com', 'employee');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const deleteSpy = vi.spyOn(db.glAccount, 'delete');

    const res = await accountsDELETE(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    const body = await res.json();
    log('DELETE employee status:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('DELETE: company_admin → 200, account deleted', async () => {
    const { company, token } = await memberWithRole('admin-b4b1-del@example.com', 'company_admin');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });

    const res = await accountsDELETE(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    log('DELETE company_admin status:', res.status);
    expect(res.status).toBe(200);
  });

  it('DELETE: super_admin → 200 via existing bypass', async () => {
    const { company, token } = await superAdminWithCompany('super-b4b1-del@example.com');
    const account = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });

    const res = await accountsDELETE(
      new NextRequest(`http://localhost/api/accounts/${account.id}?companyId=${company.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    log('DELETE super_admin status:', res.status);
    expect(res.status).toBe(200);
  });
});
