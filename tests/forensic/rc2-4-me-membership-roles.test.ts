import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { GET as meGET } from '@/app/api/auth/me/route';
import { createSession } from '@/lib/sessions';
import { clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-RC24]', ...args);

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function callMe(token: string): Promise<{ status: number; body: any }> {
  const res = await meGET(
    new NextRequest('http://localhost/api/auth/me', {
      method: 'GET',
      headers: authHeaders(token),
    }),
    { params: Promise.resolve({}) },
  );
  const body = await res.json();
  return { status: res.status, body };
}

describe('RC2-4 — /api/auth/me exposes CompanyMember.role per membership', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    const remaining = await db.user.count({ where: { email: { contains: '@example.com' } } });
    log('AFTER-ALL test users =', remaining);
  });

  it('ME-1: a role=user member gets companies with their tenant membership roles', async () => {
    const user = await db.user.create({
      data: {
        email: 'rc24-me1@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'RC24',
        lastName: 'MeOne',
        role: 'user',
      },
    });
    const companyA = await db.company.create({
      data: {
        legalName: 'RC24 Company A',
        entityType: 'BUSINESS',
        taxId: '20-1111111',
        isActive: true,
        isOnboardingComplete: true,
      },
    });
    const companyB = await db.company.create({
      data: {
        legalName: 'RC24 Company B',
        entityType: 'BUSINESS',
        taxId: '20-2222222',
        isActive: true,
        isOnboardingComplete: true,
      },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: companyA.id, role: 'company_admin' },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: companyB.id, role: 'viewer' },
    });

    const token = await createSession(user.id);
    const { status, body } = await callMe(token);

    log('ME-1: status =', status, '| user.role =', body.user?.role);
    log('ME-1: companies =', JSON.stringify(body.companies));

    expect(status).toBe(200);
    expect(body.user.role).toBe('user');
    const roleByCompany: Record<string, string | null> = {};
    for (const c of body.companies as Array<{ id: string; role: string | null }>) {
      roleByCompany[c.id] = c.role;
    }
    expect(roleByCompany[companyA.id]).toBe('company_admin');
    expect(roleByCompany[companyB.id]).toBe('viewer');
  });

  it('ME-2: super_admin gets all active companies with role=null (no invented membership)', async () => {
    const superUser = await db.user.create({
      data: {
        email: 'rc24-me2@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'RC24',
        lastName: 'Super',
        role: 'super_admin',
      },
    });
    const c1 = await db.company.create({
      data: {
        legalName: 'RC24 Super Co 1',
        entityType: 'BUSINESS',
        taxId: '20-3333333',
        isActive: true,
        isOnboardingComplete: true,
      },
    });
    const c2 = await db.company.create({
      data: {
        legalName: 'RC24 Super Co 2',
        entityType: 'BUSINESS',
        taxId: '20-4444444',
        isActive: true,
        isOnboardingComplete: true,
      },
    });
    const inactive = await db.company.create({
      data: {
        legalName: 'RC24 Inactive Co',
        entityType: 'BUSINESS',
        taxId: '20-5555555',
        isActive: false,
        isOnboardingComplete: true,
      },
    });
    // super_admin creates NO memberships — authority is global, not invented per company.

    const token = await createSession(superUser.id);
    const { status, body } = await callMe(token);

    log('ME-2: status =', status, '| user.role =', body.user?.role);
    log('ME-2: companies found =', (body.companies as unknown[]).length);
    log(
      'ME-2: roles =',
      JSON.stringify(
        (body.companies as Array<{ id: string; role: string | null }>)
          .filter((c) => [c1.id, c2.id, inactive.id].includes(c.id))
          .map((c) => ({ id: c.id, role: c.role })),
      ),
    );

    expect(status).toBe(200);
    expect(body.user.role).toBe('super_admin');
    const ids = (body.companies as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
    expect(ids).not.toContain(inactive.id);
    for (const c of body.companies as Array<{ id: string; role: string | null }>) {
      expect(c.role).toBeNull();
    }
    const membershipCount = await db.companyMember.count({ where: { userId: superUser.id } });
    expect(membershipCount).toBe(0);
  });

  it('ME-3: inactive memberships are excluded from normal member companies', async () => {
    const user = await db.user.create({
      data: {
        email: 'rc24-me3@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'RC24',
        lastName: 'MeThree',
        role: 'user',
      },
    });
    const activeCo = await db.company.create({
      data: {
        legalName: 'RC24 Active Co 3',
        entityType: 'BUSINESS',
        taxId: '20-6666666',
        isActive: true,
        isOnboardingComplete: true,
      },
    });
    const inactiveCo = await db.company.create({
      data: {
        legalName: 'RC24 Inactive Co 3',
        entityType: 'BUSINESS',
        taxId: '20-7777777',
        isActive: false,
        isOnboardingComplete: true,
      },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: activeCo.id, role: 'employee' },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: inactiveCo.id, role: 'company_admin' },
    });

    const token = await createSession(user.id);
    const { status, body } = await callMe(token);

    log('ME-3: status =', status, '| companies =', JSON.stringify(body.companies));

    expect(status).toBe(200);
    const ids = (body.companies as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(activeCo.id);
    expect(ids).not.toContain(inactiveCo.id);
    const active = (body.companies as Array<{ id: string; role: string | null }>).find(
      (c) => c.id === activeCo.id,
    );
    expect(active?.role).toBe('employee');
  });

  it('ME-4: a freshly registered member (role=user + membership company_admin, onboarding NOT complete) still gets the tenant role from /api/auth/me', async () => {
    // Mirrors the exact post-register state on the wire: User.role='user' (AuthService.register),
    // membership company_admin (created in the same TX), company with isOnboardingComplete=false
    // (schema default) which gates the UI to OnboardingWizard until hydrate() runs.
    const user = await db.user.create({
      data: {
        email: 'rc24-me4@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'RC24',
        lastName: 'Fresh',
        role: 'user',
      },
    });
    const company = await db.company.create({
      data: {
        legalName: 'RC24 Fresh Co',
        entityType: 'BUSINESS',
        taxId: '20-8888888',
        isActive: true,
        isOnboardingComplete: false,
      },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, role: 'company_admin' },
    });

    const token = await createSession(user.id);
    const { status, body } = await callMe(token);

    log('ME-4: status =', status, '| user.role =', body.user?.role);
    log('ME-4: companies =', JSON.stringify(body.companies));

    expect(status).toBe(200);
    expect(body.user.role).toBe('user');
    const listed = (body.companies as Array<{ id: string; role: string | null }>).find(
      (c) => c.id === company.id,
    );
    expect(listed).toBeDefined();
    expect(listed?.role).toBe('company_admin');
  });
});