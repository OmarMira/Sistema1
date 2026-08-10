import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PATCH } from '../../src/app/api/fiscal-periods/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

const closeConfig = {
  type: 'CALENDAR',
  startMonth: 1,
  closingAccountCode: '3090',
  periodsPerYear: 12,
  allowShortPeriods: false,
};

async function createCompanyWithClose(company: Awaited<ReturnType<typeof createTestCompany>>, userId: string, token: string) {
  await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue', accountType: 'revenue', normalBalance: 'credit' });
  await createTestGlAccount({ companyId: company.id, code: '5010', name: 'Expense', accountType: 'expense', normalBalance: 'debit' });
  await createTestGlAccount({ companyId: company.id, code: '3090', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit' });

  for (let i = 1; i <= 12; i++) {
    const month = String(i).padStart(2, '0');
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: `P${i}`,
        startDate: new Date(`2025-${month}-01T00:00:00.000Z`),
        endDate: new Date(`2025-${month}-28T00:00:00.000Z`),
        isLocked: true,
      },
    });
  }

  await db.journalEntry.create({
    data: {
      companyId: company.id,
      date: new Date('2025-06-15'),
      description: 'Revenue entry',
      status: 'posted',
      lines: {
        create: [
          { glAccountId: (await db.glAccount.findFirst({ where: { companyId: company.id, code: '4010' } }))!.id, debit: 0, credit: 10000 },
        ],
      },
    },
  });

  const { POST } = await import('../../src/app/api/fiscal-periods/close/route');
  const closeRes = await POST(
    new NextRequest(`http://localhost/api/fiscal-periods/close?companyId=${company.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: 2025, config: closeConfig }),
    }),
    { params: Promise.resolve({}) },
  );

  return { company, closeBody: await closeRes.json(), closeStatus: closeRes.status };
}

function unlockRequest(id: string, companyId: string, token: string) {
  return new NextRequest(`http://localhost/api/fiscal-periods/${id}?companyId=${companyId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isLocked: false }),
  });
}

describe('P17 — PATCH /api/fiscal-periods/[id] unlock con cobertura fiscal real', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('tras cierre 2025: desbloquea enero 2026 (período NO cubierto por el cierre)', async () => {
    const user = await createTestUser('p17-unlock-2026@example.com');
    const company = await createTestCompany('Unlock Co A');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const { company: wiredCompany, closeStatus } = await createCompanyWithClose(company, user.id, token);
    expect(closeStatus).toBe(200);
    expect(wiredCompany.id).toBe(company.id);

    const yearClosed = await db.auditLog.findFirst({
      where: { companyId: wiredCompany.id, action: 'YEAR_CLOSED' },
    });
    expect(yearClosed).not.toBeNull();

    const jan2026 = await db.fiscalPeriod.create({
      data: {
        companyId: wiredCompany.id,
        name: 'January 2026',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date('2026-01-31T00:00:00.000Z'),
        isLocked: true,
      },
    });

    const res = await PATCH(unlockRequest(jan2026.id, wiredCompany.id, token), {
      params: Promise.resolve({ id: jan2026.id }),
    });
    expect(res.status).toBe(200);

    const reloaded = await db.fiscalPeriod.findUnique({ where: { id: jan2026.id } });
    expect(reloaded?.isLocked).toBe(false);
  });

  it('tras cierre 2025: NO desbloquea período de 2025 (cubierto por el cierre)', async () => {
    const user = await createTestUser('p17-locked-2025@example.com');
    const company = await createTestCompany('Unlock Co B');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const { closeStatus } = await createCompanyWithClose(company, user.id, token);
    expect(closeStatus).toBe(200);

    const dec2025 = await db.fiscalPeriod.findFirst({
      where: { companyId: company.id, name: 'P12' },
    });
    expect(dec2025).not.toBeNull();
    expect(dec2025!.isLocked).toBe(true);

    const res = await PATCH(unlockRequest(dec2025!.id, company.id, token), {
      params: Promise.resolve({ id: dec2025!.id }),
    });
    expect(res.status).toBe(400);

    const reloaded = await db.fiscalPeriod.findUnique({ where: { id: dec2025!.id } });
    expect(reloaded?.isLocked).toBe(true);
  });
});