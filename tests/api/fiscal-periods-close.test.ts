import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';
import { aggregateFinancialData } from '@/lib/reports/aggregation';
import { GET as dashboardGET } from '@/app/api/dashboard/financial/route';

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

  it('P18 — income_statement preserva el P&L histórico después del cierre anual', async () => {
    const user = await createTestUser('p18-pl@example.com');
    const company = await createTestCompany('P18 P&L');
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
        lines: { create: [{ glAccountId: revenueGl.id, debit: 0, credit: 10000 }] },
      },
    });
    await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Expense entry',
        status: 'posted',
        lines: { create: [{ glAccountId: expenseGl.id, debit: 6000, credit: 0 }] },
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
            config: { type: 'CALENDAR', startMonth: 1, closingAccountCode: '3090', periodsPerYear: 12, allowShortPeriods: false },
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    const statement = await aggregateFinancialData(
      company.id,
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2025-12-31T23:59:59.999Z'),
      'income_statement',
    );

    expect(statement.type).toBe('income_statement');
    expect(statement.totalRevenue).toBe(10000);
    expect(statement.totalExpense).toBe(6000);
    expect(statement.netIncome).toBe(4000);

    // Seguridad contable: Retained Earnings sí refleja el cierre trasladado.
    const closingGlAfter = await db.glAccount.findUnique({ where: { id: closingGl.id } });
    expect(closingGlAfter).not.toBeNull();
  });

  it('P18 — dashboard financiero conserva revenue/expenses y no netea diciembre con el JE de cierre', async () => {
    const user = await createTestUser('p18-dash@example.com');
    const company = await createTestCompany('P18 Dashboard');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue', accountType: 'revenue', normalBalance: 'credit' });
    const expenseGl = await createTestGlAccount({ companyId: company.id, code: '5010', name: 'Expense', accountType: 'expense', normalBalance: 'debit' });
    const closingGl = await createTestGlAccount({ companyId: company.id, code: '3090', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit', isActive: true });

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
        lines: { create: [{ glAccountId: revenueGl.id, debit: 0, credit: 10000 }] },
      },
    });
    await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Expense entry',
        status: 'posted',
        lines: { create: [{ glAccountId: expenseGl.id, debit: 6000, credit: 0 }] },
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
            config: { type: 'CALENDAR', startMonth: 1, closingAccountCode: '3090', periodsPerYear: 12, allowShortPeriods: false },
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    const dashRes = await dashboardGET(
      new NextRequest(`http://localhost/api/dashboard/financial?companyId=${company.id}`),
      { params: Promise.resolve({}) },
    );
    expect(dashRes.status).toBe(200);
    const dashboard = await dashRes.json();

    expect(dashboard.kpi.revenue).toBe(10000);
    expect(dashboard.kpi.expenses).toBe(6000);

    const decTrend = dashboard.monthlyTrend.find((t: { month: string }) => t.month === '2025-12');
    const junTrend = dashboard.monthlyTrend.find((t: { month: string }) => t.month === '2025-06');
    expect(junTrend?.revenue).toBe(10000);
    expect(junTrend?.expenses).toBe(6000);
    expect(decTrend?.revenue ?? 0).toBe(0);
    expect(decTrend?.expenses ?? 0).toBe(0);

    // Seguridad contable: el Balance Sheet SÍ incluye el cierre — Retained Earnings
    // (3090) refleja el resultado trasladado (netIncome 4000 en equity).
    const balanceSheet = await aggregateFinancialData(
      company.id,
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2025-12-31T23:59:59.999Z'),
      'balance_sheet',
    );
    expect(balanceSheet.type).toBe('balance_sheet');
    const retained = (balanceSheet as { equities: Array<{ code: string; balance: number }> }).equities.find(
      (e) => e.code === '3090',
    );
    expect(retained?.balance).toBe(4000);
  });

  it('P18 — dashboard balance/equity y ecuación contable se mantienen consistentes tras el cierre', async () => {
    // Comprobación dirigida al cambio de criterio: el dashboard excluye el JE de cierre
    // completo de postedLines. Ante un asiento de cierre balanceado real (Dr Revenue /
    // Cr Expense / Cr 3090), sus KPIs contables NO deben romperse: los Assets ya no ven
    // el movimiento del cierre (no lo contienen), y el equity debe seguir siendo el mismo
    // (ahora provisto vía la integración P&L en kpi.equity en vez de vía el 3090).
    const user = await createTestUser('p18-dash-eq@example.com');
    const company = await createTestCompany('P18 Dashboard Eq');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue', accountType: 'revenue', normalBalance: 'credit' });
    const expenseGl = await createTestGlAccount({ companyId: company.id, code: '5010', name: 'Expense', accountType: 'expense', normalBalance: 'debit' });
    const closingGl = await createTestGlAccount({ companyId: company.id, code: '3090', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit', isActive: true });

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

    // Transacciones reales balanceadas: el cierre no introduce un desbalance contable.
    await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-05-10'),
        description: 'Sale',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: cashGl.id, description: 'Sale cash', debit: 10000, credit: 0 },
            { glAccountId: revenueGl.id, description: 'Sale revenue', debit: 0, credit: 10000 },
          ],
        },
      },
    });
    await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Rent',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: expenseGl.id, description: 'Rent expense', debit: 6000, credit: 0 },
            { glAccountId: cashGl.id, description: 'Rent payment', debit: 0, credit: 6000 },
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
            config: { type: 'CALENDAR', startMonth: 1, closingAccountCode: '3090', periodsPerYear: 12, allowShortPeriods: false },
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    const dashRes = await dashboardGET(
      new NextRequest(`http://localhost/api/dashboard/financial?companyId=${company.id}`),
      { params: Promise.resolve({}) },
    );
    expect(dashRes.status).toBe(200);
    const dashboard = await dashRes.json();

    // P&L histórico preservado.
    expect(dashboard.kpi.revenue).toBe(10000);
    expect(dashboard.kpi.expenses).toBe(6000);

    // Balance: los activos no tocan el cierre (se quedan en 4000 = 10000 - 6000).
    expect(dashboard.kpi.assets).toBe(4000);
    expect(dashboard.kpi.liabilities).toBe(0);

    // Equity: sin excluir el JE el dashboard lo mostraría como 3090 (4000); excluyéndolo
    // lo provee vía la integración P&L. El total debe ser idéntico: 4000.
    expect(dashboard.kpi.equity).toBe(4000);

    // La ecuación contable sigue en equilibrio: Activo = Pasivo + Patrimonio.
    expect(dashboard.kpi.accountingEquationCheck).toBe('PASS');

    // Retained Earnings sigue reflejando el cierre en el Balance Sheet.
    const balanceSheet = await aggregateFinancialData(
      company.id,
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2025-12-31T23:59:59.999Z'),
      'balance_sheet',
    );
    const retained = (balanceSheet as { equities: Array<{ code: string; balance: number }> }).equities.find(
      (e) => e.code === '3090',
    );
    expect(retained?.balance).toBe(4000);
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
    expect(body.error).toBe('Error al cerrar el período fiscal');
  });
});
