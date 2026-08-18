import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST as createPeriodPOST } from '@/app/api/fiscal-periods/route';
import { PATCH as patchPeriodPATCH } from '@/app/api/fiscal-periods/[id]/route';
import { POST as closePeriodPOST } from '@/app/api/fiscal-periods/close/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function makeSuperAdmin(userId: string) {
  await db.user.update({ where: { id: userId }, data: { role: 'super_admin' } });
}

async function addMember(userId: string, companyId: string, role: string) {
  await db.companyMember.create({ data: { userId, companyId, role } });
}

function createBody(name: string) {
  return JSON.stringify({ name, startDate: '2026-01-01', endDate: '2026-01-31' });
}

async function seedPeriod(companyId: string, name: string) {
  return db.fiscalPeriod.create({
    data: {
      companyId,
      name,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-31T23:59:59.999Z'),
      isLocked: false,
    },
  });
}

async function seedYearCloseScenario(companyId: string) {
  const revenueGl = await createTestGlAccount({
    companyId,
    code: '4010',
    name: 'Revenue',
    accountType: 'revenue',
    normalBalance: 'credit',
  });
  const expenseGl = await createTestGlAccount({
    companyId,
    code: '5010',
    name: 'Expense',
    accountType: 'expense',
    normalBalance: 'debit',
  });
  const closingGl = await createTestGlAccount({
    companyId,
    code: '3090',
    name: 'Retained Earnings',
    accountType: 'equity',
    normalBalance: 'credit',
    isActive: true,
  });

  for (let i = 1; i <= 12; i++) {
    const month = String(i).padStart(2, '0');
    await db.fiscalPeriod.create({
      data: {
        companyId,
        name: `P${i}`,
        startDate: new Date(`2025-${month}-01T00:00:00.000Z`),
        endDate: new Date(`2025-${month}-28T00:00:00.000Z`),
        isLocked: true,
      },
    });
  }

  await db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2025-06-15'),
      description: 'Revenue entry',
      status: 'posted',
      lines: { create: [{ glAccountId: revenueGl.id, debit: 0, credit: 10000 }] },
    },
  });
  await db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2025-06-15'),
      description: 'Expense entry',
      status: 'posted',
      lines: { create: [{ glAccountId: expenseGl.id, debit: 6000, credit: 0 }] },
    },
  });

  return { revenueGl, expenseGl, closingGl };
}

const CLOSE_BODY = JSON.stringify({
  year: 2025,
  config: {
    type: 'CALENDAR',
    startMonth: 1,
    closingAccountCode: '3090',
    periodsPerYear: 12,
    allowShortPeriods: false,
  },
});

describe('P5 — POST /api/fiscal-periods (create) role gate', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('company_admin can create a fiscal period (200)', async () => {
    const user = await createTestUser('p5-create-admin@example.com');
    const company = await createTestCompany('P5 Create Admin');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-ADMIN'),
      }),
    );
    log('CREATE company_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('super_admin bypass keeps create allowed without membership (200)', async () => {
    const user = await createTestUser('p5-create-super@example.com');
    await makeSuperAdmin(user.id);
    const company = await createTestCompany('P5 Create Super');
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-SUPER'),
      }),
    );
    log('CREATE super_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('employee cannot create a fiscal period (403)', async () => {
    const user = await createTestUser('p5-create-employee@example.com');
    const company = await createTestCompany('P5 Create Employee');
    await addMember(user.id, company.id, 'employee');
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-EMPLOYEE'),
      }),
    );
    log('CREATE employee: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('viewer cannot create a fiscal period (403)', async () => {
    const user = await createTestUser('p5-create-viewer@example.com');
    const company = await createTestCompany('P5 Create Viewer');
    await addMember(user.id, company.id, 'viewer');
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-VIEWER'),
      }),
    );
    log('CREATE viewer: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('user without membership cannot create (403)', async () => {
    const user = await createTestUser('p5-create-nomem@example.com');
    const company = await createTestCompany('P5 Create NoMem');
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-NOMEM'),
      }),
    );
    log('CREATE no-membership: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('inactive company blocks create (403)', async () => {
    const user = await createTestUser('p5-create-inactive@example.com');
    const company = await createTestCompany('P5 Create Inactive');
    await createTestCompanyMember(user.id, company.id);
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-INACTIVE'),
      }),
    );
    log('CREATE inactive company: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('unauthenticated request is rejected (401)', async () => {
    const company = await createTestCompany('P5 Create Anon');

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody('P5-CREATE-ANON'),
      }),
    );
    log('CREATE no-session: status =', res.status);
    expect(res.status).toBe(401);
  });

  it('missing companyId is rejected (400)', async () => {
    const user = await createTestUser('p5-create-nocid@example.com');
    const token = await createSession(user.id);

    const res = await createPeriodPOST(
      new NextRequest('http://localhost/api/fiscal-periods', {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-NOCID'),
      }),
    );
    log('CREATE missing companyId: status =', res.status);
    expect(res.status).toBe(400);
  });

  it('member of another company cannot create for a foreign tenant (403)', async () => {
    const attacker = await createTestUser('p5-create-attacker@example.com');
    const attackerCompany = await createTestCompany('P5 Create Attacker');
    await createTestCompanyMember(attacker.id, attackerCompany.id);
    const victimCompany = await createTestCompany('P5 Create Victim');
    const token = await createSession(attacker.id);

    const res = await createPeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods?companyId=${victimCompany.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: createBody('P5-CREATE-CROSS'),
      }),
    );
    log('CREATE cross-tenant: status =', res.status);
    expect(res.status).toBe(403);
  });
});

describe('P5 — PATCH /api/fiscal-periods/[id] (lock/unlock) role gate', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('company_admin can lock a fiscal period (200)', async () => {
    const user = await createTestUser('p5-patch-admin@example.com');
    const company = await createTestCompany('P5 Patch Admin');
    await createTestCompanyMember(user.id, company.id);
    const period = await seedPeriod(company.id, 'P5-PATCH-ADMIN');
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH company_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('super_admin bypass keeps lock allowed without membership (200)', async () => {
    const user = await createTestUser('p5-patch-super@example.com');
    await makeSuperAdmin(user.id);
    const company = await createTestCompany('P5 Patch Super');
    const period = await seedPeriod(company.id, 'P5-PATCH-SUPER');
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH super_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('employee cannot lock/unlock a fiscal period (403)', async () => {
    const user = await createTestUser('p5-patch-employee@example.com');
    const company = await createTestCompany('P5 Patch Employee');
    await addMember(user.id, company.id, 'employee');
    const period = await seedPeriod(company.id, 'P5-PATCH-EMPLOYEE');
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH employee: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('viewer cannot lock/unlock a fiscal period (403)', async () => {
    const user = await createTestUser('p5-patch-viewer@example.com');
    const company = await createTestCompany('P5 Patch Viewer');
    await addMember(user.id, company.id, 'viewer');
    const period = await seedPeriod(company.id, 'P5-PATCH-VIEWER');
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH viewer: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('user without membership cannot lock/unlock (403)', async () => {
    const user = await createTestUser('p5-patch-nomem@example.com');
    const company = await createTestCompany('P5 Patch NoMem');
    const period = await seedPeriod(company.id, 'P5-PATCH-NOMEM');
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH no-membership: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('inactive company blocks lock/unlock (403)', async () => {
    const user = await createTestUser('p5-patch-inactive@example.com');
    const company = await createTestCompany('P5 Patch Inactive');
    await createTestCompanyMember(user.id, company.id);
    const period = await seedPeriod(company.id, 'P5-PATCH-INACTIVE');
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH inactive company: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('unauthenticated request is rejected (401)', async () => {
    const company = await createTestCompany('P5 Patch Anon');
    const period = await seedPeriod(company.id, 'P5-PATCH-ANON');

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${company.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH no-session: status =', res.status);
    expect(res.status).toBe(401);
  });

  it('missing companyId is rejected (400)', async () => {
    const user = await createTestUser('p5-patch-nocid@example.com');
    const company = await createTestCompany('P5 Patch NoCid');
    const period = await seedPeriod(company.id, 'P5-PATCH-NOCID');
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH missing companyId: status =', res.status);
    expect(res.status).toBe(400);
  });

  it('nonexistent period in the company returns 404', async () => {
    const user = await createTestUser('p5-patch-missing@example.com');
    const company = await createTestCompany('P5 Patch Missing');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/period-does-not-exist?companyId=${company.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: 'period-does-not-exist' }) },
    );
    log('PATCH nonexistent period: status =', res.status);
    expect(res.status).toBe(404);
  });

  it('member of another company cannot lock/unlock a foreign period (403)', async () => {
    const attacker = await createTestUser('p5-patch-attacker@example.com');
    const attackerCompany = await createTestCompany('P5 Patch Attacker');
    await createTestCompanyMember(attacker.id, attackerCompany.id);
    const victimCompany = await createTestCompany('P5 Patch Victim');
    const period = await seedPeriod(victimCompany.id, 'P5-PATCH-VICTIM');
    const token = await createSession(attacker.id);

    const res = await patchPeriodPATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${period.id}?companyId=${victimCompany.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isLocked: true }),
      }),
      { params: Promise.resolve({ id: period.id }) },
    );
    log('PATCH cross-tenant: status =', res.status);
    expect(res.status).toBe(403);
  });
});

describe('P5 — POST /api/fiscal-periods/close (year close) role gate', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('company_admin can close the fiscal year (200)', async () => {
    const user = await createTestUser('p5-close-admin@example.com');
    const company = await createTestCompany('P5 Close Admin');
    await createTestCompanyMember(user.id, company.id);
    await seedYearCloseScenario(company.id);
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE company_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('employee can close the fiscal year (200)', async () => {
    const user = await createTestUser('p5-close-employee@example.com');
    const company = await createTestCompany('P5 Close Employee');
    await addMember(user.id, company.id, 'employee');
    await seedYearCloseScenario(company.id);
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE employee: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('super_admin bypass keeps close allowed without membership (200)', async () => {
    const user = await createTestUser('p5-close-super@example.com');
    await makeSuperAdmin(user.id);
    const company = await createTestCompany('P5 Close Super');
    await seedYearCloseScenario(company.id);
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE super_admin: status =', res.status);
    expect(res.status).toBe(200);
  });

  it('viewer cannot close the fiscal year (403)', async () => {
    const user = await createTestUser('p5-close-viewer@example.com');
    const company = await createTestCompany('P5 Close Viewer');
    await addMember(user.id, company.id, 'viewer');
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE viewer: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('user without membership cannot close (403)', async () => {
    const user = await createTestUser('p5-close-nomem@example.com');
    const company = await createTestCompany('P5 Close NoMem');
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE no-membership: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('inactive company blocks close (403)', async () => {
    const user = await createTestUser('p5-close-inactive@example.com');
    const company = await createTestCompany('P5 Close Inactive');
    await createTestCompanyMember(user.id, company.id);
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE inactive company: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('unauthenticated request is rejected (401)', async () => {
    const company = await createTestCompany('P5 Close Anon');

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE no-session: status =', res.status);
    expect(res.status).toBe(401);
  });

  it('missing companyId is rejected (400)', async () => {
    const user = await createTestUser('p5-close-nocid@example.com');
    const token = await createSession(user.id);

    const res = await closePeriodPOST(
      new NextRequest('http://localhost/api/fiscal-periods/close', {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE missing companyId: status =', res.status);
    expect(res.status).toBe(400);
  });

  it('member of another company cannot close a foreign tenant (403)', async () => {
    const attacker = await createTestUser('p5-close-attacker@example.com');
    const attackerCompany = await createTestCompany('P5 Close Attacker');
    await createTestCompanyMember(attacker.id, attackerCompany.id);
    const victimCompany = await createTestCompany('P5 Close Victim');
    const token = await createSession(attacker.id);

    const res = await closePeriodPOST(
      new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${victimCompany.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: CLOSE_BODY,
      }),
      { params: Promise.resolve({}) },
    );
    log('CLOSE cross-tenant: status =', res.status);
    expect(res.status).toBe(403);
  });
});