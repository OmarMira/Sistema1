import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { proxy } from '@/proxy';
import { GET as accountsGET, POST as accountsPOST } from '@/app/api/accounts/route';
import { GET as accountByIdGET, PUT as accountByIdPUT, DELETE as accountByIdDELETE } from '@/app/api/accounts/[id]/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
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

describe('F-2 — Cross-tenant IDOR on chart of accounts (regression)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    if (ids.length === 0) return;
    const filter = { companyId: { in: ids } };
    await db.glAccount.deleteMany({ where: filter }).catch(() => {});
    await db.companyMember.deleteMany({ where: filter }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  });

  afterAll(async () => {
    const leftoverUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    const leftoverCompanies = await db.company.count({ where: { legalName: { in: ['Tenant A Corp', 'Tenant B Corp'] } } });
    log('AFTER-ALL DB STATE: users =', leftoverUsers, '| tenant companies =', leftoverCompanies);
  });

  it('The proxy does not gate tenants (200) — the 403 must come from apiHandler membership', async () => {
    const attacker = await createTestUser('attacker-f2proxy@example.com');
    const tenantA = await createTestCompany('Tenant A Corp');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);

    const victimB = await createTestCompany('Tenant B Corp');
    createdCompanyIds.add(victimB.id);

    const token = await createSession(attacker.id);
    const req = new NextRequest(`http://localhost/api/accounts?companyId=${victimB.id}`, {
      method: 'GET',
      headers: authHeaders(token),
    });
    const proxied = await proxy(req);
    const status = proxied.status;
    const bodyText = status === 200 ? '(next/streaming)' : await proxied.text();
    log('PROXY CHECK: GET /api/accounts?companyId=<victim> -> proxy status =', status, '| body =', bodyText);
    expect(status).toBe(200);

    const res = await accountsGET(req, { params: Promise.resolve({}) });
    const body = await res.json();
    log('POST-PROXY HANDLER: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });

  it('GET /api/accounts?companyId=<victim> returns 403 and leaks no rows to a non-member', async () => {
    const attacker = await createTestUser('attacker-f2@example.com');
    const tenantA = await createTestCompany('Tenant A Corp');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);

    const victimB = await createTestCompany('Tenant B Corp');
    const victimGl = await createTestGlAccount({
      companyId: victimB.id,
      code: '9999',
      name: 'Victim Secret Account',
    });
    createdCompanyIds.add(victimB.id);
    log('SEEDED: attacker member of Tenant A only | victim company B id =', victimB.id, '| victim account =', victimGl.code, victimGl.name);

    const token = await createSession(attacker.id);

    // 1. Control: GET with attacker OWN company returns only Tenant A accounts (no victim data)
    const resOwn = await accountsGET(
      new NextRequest(`http://localhost/api/accounts?companyId=${tenantA.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const ownBody = await resOwn.json();
    const ownCodes = (ownBody.accounts ?? []).map((a: { code: string }) => a.code);
    log('CONTROL GET (own tenant): status =', resOwn.status, '| codes =', JSON.stringify(ownCodes));
    expect(resOwn.status).toBe(200);
    expect(ownCodes).not.toContain('9999');

    // 2. ATTACK: GET with the victim companyId (attacker is NOT a member of Tenant B)
    const resVictim = await accountsGET(
      new NextRequest(`http://localhost/api/accounts?companyId=${victimB.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const victimBody = await resVictim.json();
    const victimCodes = (victimBody.accounts ?? []).map((a: { code: string }) => a.code);
    log('ATTACK GET (victim tenant): status =', resVictim.status, '| codes =', JSON.stringify(victimCodes));
    log('VICTIM ACCOUNT LEAKED:', victimCodes.includes('9999'));
    expect(resVictim.status).toBe(403);
    expect(victimBody.error).toBe('Forbidden');
    expect(victimCodes).not.toContain('9999');
    expect(victimCodes).not.toContain(victimGl.code);
  });

  it('POST /api/accounts?companyId=<victim> returns 403 and creates no account in the victim tenant', async () => {
    const attacker = await createTestUser('attacker-f2b@example.com');
    const tenantA = await createTestCompany('Tenant A Corp');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);

    const victimB = await createTestCompany('Tenant B Corp');
    createdCompanyIds.add(victimB.id);
    log('SEEDED: attacker member of Tenant A only | victim company B id =', victimB.id);

    const token = await createSession(attacker.id);
    const res = await accountsPOST(
      new NextRequest(`http://localhost/api/accounts?companyId=${victimB.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          code: '7777',
          name: 'Injected Into Victim',
          accountType: 'asset',
          normalBalance: 'debit',
        }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('ATTACK POST (victim tenant): status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');

    const created = await db.glAccount.findUnique({
      where: { companyId_code: { companyId: victimB.id, code: '7777' } },
    });
    log('DB CHECK: account 7777 exists in victim tenant B =', Boolean(created));
    expect(created).toBeNull();
  });

  it('PUT /api/accounts/[id]?companyId=<victim> returns 403 and modifies no victim account', async () => {
    const attacker = await createTestUser('attacker-f2c@example.com');
    const tenantA = await createTestCompany('Tenant A Corp');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);

    const victimB = await createTestCompany('Tenant B Corp');
    const victimGl = await createTestGlAccount({
      companyId: victimB.id,
      code: '5555',
      name: 'Victim Account to Modify',
    });
    createdCompanyIds.add(victimB.id);
    log('SEEDED: attacker member of Tenant A only | victim account =', victimGl.code, victimGl.name, '| id =', victimGl.id);

    const token = await createSession(attacker.id);
    const res = await accountByIdPUT(
      new NextRequest(`http://localhost/api/accounts/${victimGl.id}?companyId=${victimB.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'DEFACED by attacker' }),
      }),
      { params: Promise.resolve({ id: victimGl.id }) },
    );
    const body = await res.json();
    log('ATTACK PUT (victim account): status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');

    const stored = await db.glAccount.findUnique({ where: { id: victimGl.id } });
    log('DB CHECK: victim account name after PUT =', stored?.name, '| code =', stored?.code);
    expect(stored).not.toBeNull();
    expect(stored?.name).toBe('Victim Account to Modify');
    expect(stored?.code).toBe('5555');
  });

  it('DELETE /api/accounts/[id]?companyId=<victim> returns 403 and deletes no victim account', async () => {
    const attacker = await createTestUser('attacker-f2d@example.com');
    const tenantA = await createTestCompany('Tenant A Corp');
    await createTestCompanyMember(attacker.id, tenantA.id);
    createdCompanyIds.add(tenantA.id);

    const victimB = await createTestCompany('Tenant B Corp');
    const victimGl = await createTestGlAccount({
      companyId: victimB.id,
      code: '4444',
      name: 'Victim Account to Delete',
    });
    createdCompanyIds.add(victimB.id);
    log('SEEDED: attacker member of Tenant A only | victim account =', victimGl.code, victimGl.name, '| id =', victimGl.id);

    const token = await createSession(attacker.id);
    const res = await accountByIdDELETE(
      new NextRequest(`http://localhost/api/accounts/${victimGl.id}?companyId=${victimB.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({ id: victimGl.id }) },
    );
    const body = await res.json();
    log('ATTACK DELETE (victim account): status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');

    const stored = await db.glAccount.findUnique({ where: { id: victimGl.id } });
    log('DB CHECK: victim account exists after DELETE =', Boolean(stored));
    expect(stored).not.toBeNull();
  });

  it('super_admin keeps legitimate cross-tenant access (bypass is intentional)', async () => {
    const admin = await createTestUser('superadmin-f2@example.com');
    await db.user.update({ where: { id: admin.id }, data: { platformRole: 'super_admin' } });

    const victimB = await createTestCompany('Tenant B Corp');
    const victimGl = await createTestGlAccount({
      companyId: victimB.id,
      code: '8888',
      name: 'Victim Account Visible To Super Admin',
    });
    createdCompanyIds.add(victimB.id);
    log('SEEDED: super_admin (no membership) | victim company B id =', victimB.id, '| victim account =', victimGl.code);

    const token = await createSession(admin.id);
    const res = await accountsGET(
      new NextRequest(`http://localhost/api/accounts?companyId=${victimB.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const codes = (body.accounts ?? []).map((a: { code: string }) => a.code);
    log('SUPER_ADMIN GET (victim tenant): status =', res.status, '| codes =', JSON.stringify(codes));
    expect(res.status).toBe(200);
    expect(codes).toContain('8888');
  });
});
