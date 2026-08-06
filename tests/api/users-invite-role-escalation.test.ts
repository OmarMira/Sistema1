import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST as invitePOST } from '@/app/api/users/route';
import { POST as adminCreatePOST } from '@/app/api/admin/users/route';
import { PATCH as adminUpdatePATCH } from '@/app/api/admin/users/[id]/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function inviteUser(token: string, companyId: string, body: Record<string, string>) {
  return invitePOST(
    new NextRequest(`http://localhost/api/users?companyId=${companyId}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

async function adminCreateUser(token: string, body: Record<string, string>) {
  return adminCreatePOST(
    new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

async function adminUpdateUser(token: string, id: string) {
  return adminUpdatePATCH(
    new NextRequest(`http://localhost/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ role: 'super_admin' }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const inviteBody = (email: string, role: string) => ({
  email,
  firstName: 'F1',
  lastName: 'User',
  password: 'password123',
  role,
});

describe('F-1 — company_admin cannot invite a global super_admin user (remediation)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('Q1: company_admin POST /api/users with role=super_admin is rejected with 400', async () => {
    const actor = await createTestUser('f1-actor@example.com');
    const company = await createTestCompany('F1 Co');
    await createTestCompanyMember(actor.id, company.id);
    const token = await createSession(actor.id);

    const res = await inviteUser(token, company.id, inviteBody('f1-victim@example.com', 'super_admin'));
    const created = await db.user.findUnique({ where: { email: 'f1-victim@example.com' } });
    const payload = await res.json();

    log('Q1: company_admin invites role=super_admin -> status =', res.status, '| error =', JSON.stringify(payload.error));
    log('Q1: user created? =', created !== null, '| role stored =', created?.role);
    expect(res.status).toBe(400);
    expect(payload.error).toBe('Validation failed');
    expect(created).toBeNull();
  });

  it('Q2: company_admin POST /api/users with role=employee is accepted (201)', async () => {
    const actor = await createTestUser('f1-actor2@example.com');
    const company = await createTestCompany('F1 Co');
    await createTestCompanyMember(actor.id, company.id);
    const token = await createSession(actor.id);

    const res = await inviteUser(token, company.id, inviteBody('f1-employee@example.com', 'employee'));
    const created = await db.user.findUnique({ where: { email: 'f1-employee@example.com' } });

    log('Q2: company_admin invites role=employee -> status =', res.status, '| role stored =', created?.role);
    expect(res.status).toBe(201);
    expect(created?.role).toBe('employee');
  });

  it('Q3: super_admin POST /api/admin/users with role=super_admin is accepted (201) — global admin flow intact', async () => {
    const superAdmin = await createTestUser('f1-super@example.com');
    await db.user.update({ where: { id: superAdmin.id }, data: { role: 'super_admin' } });
    const token = await createSession(superAdmin.id);

    const res = await adminCreateUser(token, inviteBody('f1-new-super@example.com', 'super_admin'));
    const created = await db.user.findUnique({ where: { email: 'f1-new-super@example.com' } });

    log('Q3: super_admin creates role=super_admin via /api/admin/users -> status =', res.status, '| role stored =', created?.role);
    expect(res.status).toBe(201);
    expect(created?.role).toBe('super_admin');
  });

  it('Q4: super_admin POST /api/admin/users with role=viewer is accepted (201)', async () => {
    const superAdmin = await createTestUser('f1-super2@example.com');
    await db.user.update({ where: { id: superAdmin.id }, data: { role: 'super_admin' } });
    const token = await createSession(superAdmin.id);

    const res = await adminCreateUser(token, inviteBody('f1-new-viewer@example.com', 'viewer'));
    const created = await db.user.findUnique({ where: { email: 'f1-new-viewer@example.com' } });

    log('Q4: super_admin creates role=viewer via /api/admin/users -> status =', res.status, '| role stored =', created?.role);
    expect(res.status).toBe(201);
    expect(created?.role).toBe('viewer');
  });

  it('Q5: company_admin cannot promote an existing user via the only update route (PATCH /api/admin/users/[id] -> 403)', async () => {
    const actor = await createTestUser('f1-actor3@example.com');
    const victim = await createTestUser('f1-victim3@example.com');
    const company = await createTestCompany('F1 Co');
    await createTestCompanyMember(actor.id, company.id);
    const token = await createSession(actor.id);

    const res = await adminUpdateUser(token, victim.id);
    const roleAfter = (await db.user.findUnique({ where: { id: victim.id } }))?.role;

    log('Q5: company_admin PATCH /api/admin/users/[id] role=super_admin -> status =', res.status, '| victim role after =', roleAfter);
    expect(res.status).toBe(403);
    expect(roleAfter).toBe('company_admin');
  });

  it('Q6: updateUserSchema rejects an unknown role with the standard validation contract (400)', async () => {
    const superAdmin = await createTestUser('f1-super3@example.com');
    await db.user.update({ where: { id: superAdmin.id }, data: { role: 'super_admin' } });
    const victim = await createTestUser('f1-victim6@example.com');
    const token = await createSession(superAdmin.id);

    const res = await adminUpdatePATCH(
      new NextRequest(`http://localhost/api/admin/users/${victim.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ role: 'root' }),
      }),
      { params: Promise.resolve({ id: victim.id }) },
    );
    const payload = await res.json();
    const roleAfter = (await db.user.findUnique({ where: { id: victim.id } }))?.role;

    log('Q6: super_admin PATCH with unknown role -> status =', res.status, '| error =', JSON.stringify(payload.error), '| role after =', roleAfter);
    expect(res.status).toBe(400);
    expect(payload.error).toBe('Validation failed');
    expect(roleAfter).toBe('company_admin');
  });
});
