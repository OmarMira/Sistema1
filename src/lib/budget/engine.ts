import { db } from '@/lib/db';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fromCents, sumCents, toCents } from '@/lib/money';

export type BudgetComparison = {
  accountCode: string;
  accountName: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number;
  status: 'OK' | 'WARNING' | 'CRITICAL';
};

/** Account code -> budgeted amount for one company/month. */
export type MonthBudgets = Record<string, number>;

/**
 * On-disk budget file format (S6):
 *
 * {
 *   "companies": { "<companyId>": { "<year>": { "<month>": { "<accountCode>": number } } } },
 *   "legacy":    { "<year>": { "<month>": { "<accountCode>": number } } }
 * }
 *
 * A flat file of the pre-scoping format ("<year>": { "<month>": { ... } }) is legacy,
 * unscoped data: it is never attributed to a company.
 */
const BUDGETS_FILE_ENV = 'BUDGETS_FILE_PATH';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMonthBudgets(node: unknown): MonthBudgets {
  if (!isPlainObject(node)) return {};
  const budgets: MonthBudgets = {};
  for (const [accountCode, amount] of Object.entries(node)) {
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      budgets[accountCode] = amount;
    }
  }
  return budgets;
}

export function getBudgetsFilePath(): string {
  const override = process.env[BUDGETS_FILE_ENV];
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(process.cwd(), 'data', 'budgets.json');
}

/**
 * Reads the budget file. A missing, unreadable or malformed file means
 * "no budgets configured" and must never surface as a request error.
 */
function readBudgetFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Company-scoped budget lookup. Legacy unscoped entries (flat year-keyed data,
 * or data under an explicit "legacy" section) are attributed to no company,
 * so company-scoped lookups return an empty map rather than another tenant's numbers.
 */
export function getCompanyMonthBudgets(companyId: string, year: number, month: number): MonthBudgets {
  const file = readBudgetFile(getBudgetsFilePath());
  if (!isPlainObject(file)) return {};

  const companies = file.companies;
  if (!isPlainObject(companies)) return {};

  const company = companies[companyId];
  if (!isPlainObject(company)) return {};

  const yearNode = company[String(year)];
  if (!isPlainObject(yearNode)) return {};

  return toMonthBudgets(yearNode[String(month)]);
}

export async function getVarianceReport(
  companyId: string,
  year: number,
  month: number,
): Promise<BudgetComparison[]> {
  // 1. Cargar Presupuestos (por empresa)
  const monthBudgets = getCompanyMonthBudgets(companyId, year, month);

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

    // Calcular saldo real según normalBalance — S3: the groupBy `_sum` values
    // arrive as Prisma.Decimal, so the balance is derived in integer cents.
    const realData = actualsAgg.find((a) => accountMap.get(a.glAccountId)?.code === code);
    const debitCents = toCents(realData?._sum.debit ?? 0);
    const creditCents = toCents(realData?._sum.credit ?? 0);
    const actualCents =
      account.normalBalance === 'credit'
        ? sumCents(creditCents, -debitCents)
        : sumCents(debitCents, -creditCents);
    const actualVal = fromCents(actualCents);

    const varianceCents = sumCents(actualCents, -toCents(budgetVal));
    const variance = fromCents(varianceCents);
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
      variance,
      variancePercent: Math.round(variancePercent * 100) / 100,
      status,
    });
  }

  return results.sort((a, b) => Math.abs(b.variancePercent) - Math.abs(a.variancePercent));
}
