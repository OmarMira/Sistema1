import { db } from '@/lib/db';
import { readFileSync } from 'fs';
import { join } from 'path';

export type BudgetComparison = {
  accountCode: string;
  accountName: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number;
  status: 'OK' | 'WARNING' | 'CRITICAL';
};

export async function getVarianceReport(
  companyId: string,
  year: number,
  month: number,
): Promise<BudgetComparison[]> {
  // 1. Cargar Presupuestos
  const budgetsPath = join(process.cwd(), 'data/budgets.json');
  const allBudgets = JSON.parse(readFileSync(budgetsPath, 'utf-8'));
  const monthBudgets = allBudgets[year]?.[month] || {};

  // 2. Calcular Reales (Agregación Nativa PostgreSQL)
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const actualsAgg = await db.journalLine.groupBy({
    by: ['glAccountId'],
    _sum: { debit: true, credit: true },
    where: {
      entry: { companyId, status: 'posted', date: { gte: start, lte: end } },
      glAccount: { isActive: true },
    },
  });

  // 3. Mapear y Calcular Varianza
  const accounts = await db.glAccount.findMany({
    where: { companyId, isActive: true },
    select: { id: true, code: true, name: true, normalBalance: true },
  });
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  const results: BudgetComparison[] = [];

  // Iterar sobre cuentas con presupuesto O movimiento real
  const allCodes = new Set<string>([
    ...Object.keys(monthBudgets),
    ...actualsAgg
      .map((a) => accountMap.get(a.glAccountId)?.code)
      .filter((c): c is string => typeof c === 'string'),
  ]);

  for (const code of allCodes) {
    const account = accounts.find((a) => a.code === code);
    if (!account) continue;

    const budgetVal = monthBudgets[code] || 0;

    // Calcular saldo real según normalBalance
    const realData = actualsAgg.find((a) => accountMap.get(a.glAccountId)?.code === code);
    const d = realData?._sum.debit ?? 0;
    const c = realData?._sum.credit ?? 0;
    const actualVal = account.normalBalance === 'credit' ? c - d : d - c;

    const variance = actualVal - budgetVal;
    const variancePercent = budgetVal !== 0 ? (variance / Math.abs(budgetVal)) * 100 : 100;

    // Determinar estado (Lógica simple para ejemplo, configurable)
    let status: 'OK' | 'WARNING' | 'CRITICAL' = 'OK';
    if (Math.abs(variancePercent) > 10) status = 'WARNING';
    if (Math.abs(variancePercent) > 25) status = 'CRITICAL';

    results.push({
      accountCode: code,
      accountName: account.name,
      budget: budgetVal,
      actual: actualVal,
      variance: Math.round(variance * 100) / 100,
      variancePercent: Math.round(variancePercent * 100) / 100,
      status,
    });
  }

  return results.sort((a, b) => Math.abs(b.variancePercent) - Math.abs(a.variancePercent));
}
