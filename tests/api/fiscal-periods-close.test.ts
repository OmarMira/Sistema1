import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

describe('H5 — POST /api/fiscal-periods/close', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('cierra ejercicio exitosamente: crea asiento, audit log y bloquea periodos', async () => {
    const user = await createTestUser('h5-close@example.com');
    const company = await createTestCompany('H5 Close');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue', accountType: 'revenue', normalBalance: 'credit' });
    const expenseGl = await createTestGlAccount({ companyId: company.id, code: '5010', name: 'Expense', accountType: 'expense', normalBalance: 'debit' });
    const closingGl = await createTestGlAccount({ companyId: company.id, code: '3090', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit' });

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
            { glAccountId: revenueGl.id, debit: 0, credit: 10000 },
          ],
        },
      },
    });

    await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Expense entry',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: expenseGl.id, debit: 6000, credit: 0 },
          ],
        },
      },
    });

    const { POST } = await import('../../src/app/api/fiscal-periods/close/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/fiscal-periods/close?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            year: 2025,
            config: {
              type: 'CALENDAR',
              startMonth: 1,
              closingAccountCode: '3090',
              periodsPerYear: 12,
              allowShortPeriods: false,
            },
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.entryId).toBeDefined();

    const entry = await db.journalEntry.findUnique({
      where: { id: body.entryId },
      include: { lines: true },
    });
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('posted');
    expect(entry!.lines.length).toBeGreaterThanOrEqual(2);

    const debitTotal = entry!.lines.reduce((s, l) => s + Number(l.debit), 0);
    const creditTotal = entry!.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(Math.abs(debitTotal - creditTotal)).toBeLessThan(0.01);

    const hasClosingLine = entry!.lines.some((l) => l.glAccountId === closingGl.id);
    expect(hasClosingLine).toBe(true);

    const auditLogs = await db.auditLog.findMany({
      where: { companyId: company.id, action: 'YEAR_CLOSED' },
    });
    expect(auditLogs).toHaveLength(1);

    const lockedPeriods = await db.fiscalPeriod.findMany({
      where: { companyId: company.id, isLocked: true },
    });
    expect(lockedPeriods.length).toBeGreaterThanOrEqual(12);
  });

  it('rechaza si los periodos no estan bloqueados', async () => {
    const user = await createTestUser('h5-not-locked@example.com');
    const company = await createTestCompany('H5 Not Locked');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    await createTestGlAccount({ companyId: company.id, code: '3090', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit' });

    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'P1',
        startDate: new Date('2025-01-01T00:00:00.000Z'),
        endDate: new Date('2025-01-28T00:00:00.000Z'),
        isLocked: false,
      },
    });

    const { POST } = await import('../../src/app/api/fiscal-periods/close/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/fiscal-periods/close?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            year: 2025,
            config: {
              type: 'CALENDAR',
              startMonth: 1,
              closingAccountCode: '3090',
              periodsPerYear: 1,
              allowShortPeriods: false,
            },
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('incompletos');
  });
});
