import type { Transaction } from '@/lib/constants/financial-dashboard-types';
import { buildMonthlyBalances } from '@/lib/financial-dashboard-monthly';
export interface BankMovement extends Transaction {
  statementId: string;
  ignored: boolean;
}
export interface BankStatementFact {
  id: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  closingBalance: number;
}
export interface BankActivityData {
  account: {
    id: string;
    accountName: string;
    bankName: string;
    currency: string;
  } | null;
  accounts: NonNullable<BankActivityData['account']>[];
  years: number[];
  year: number | null;
  statements: BankStatementFact[];
  transactions: BankMovement[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}
export interface BankFilters {
  start: string;
  end: string;
  reconciliation: string;
  months: Set<string>;
  income: Set<string>;
  expenses: Set<string>;
}
export const cents = (value: number) => Math.round(value * 100);
export const signedCents = (tx: BankMovement) => cents(tx.monto) * (tx.tipo === 'credito' ? 1 : -1);
export function savedCategory(tx: Transaction): string {
  return tx.glAccountName?.trim() || tx.cuenta_contable?.trim().replace(/^\d+\s+/, '') || 'Sin asignar';
}
export function filterBankMovements(rows: BankMovement[], filters: BankFilters): BankMovement[] {
  if (filters.start && filters.end && filters.start > filters.end) return [];
  return rows.filter(tx => (!filters.start || tx.fecha >= filters.start) && (!filters.end || tx.fecha <= filters.end) && filters.months.has(tx.fecha.slice(5, 7)) && (filters.reconciliation === 'all' || tx.conciliado === (filters.reconciliation === 'reconciled')) && (tx.tipo === 'credito' ? filters.income : filters.expenses).has(savedCategory(tx)));
}
export function bankTotals(rows: BankMovement[]) {
  const incoming = rows.filter(t => t.tipo === 'credito').reduce((sum, t) => sum + cents(t.monto), 0);
  const outgoing = rows.filter(t => t.tipo === 'debito').reduce((sum, t) => sum + cents(t.monto), 0);
  return {
    incoming: incoming / 100,
    outgoing: outgoing / 100,
    net: (incoming - outgoing) / 100
  };
}
export function bankCategories(rows: BankMovement[], type: 'credito' | 'debito') {
  const categories = new Map<string, number>();
  for (const row of rows.filter(t => t.tipo === type)) {
    const category = savedCategory(row);
    categories.set(category, (categories.get(category) ?? 0) + cents(row.monto));
  }
  const total = [...categories.values()].reduce((sum, amount) => sum + amount, 0);
  return [...categories].map(([name, value]) => ({
    name,
    value: value / 100,
    percentage: total ? value / total * 100 : 0
  })).sort((a, b) => b.value - a.value);
}
export function statementContext(data: BankActivityData) {
  const statements = [...data.statements].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const first = statements[0];
  const last = [...statements].sort((a, b) => a.endDate.localeCompare(b.endDate)).at(-1);
  const start = first?.startDate ?? `${data.year}-01-01`;
  const end = last?.endDate ?? `${data.year}-12-31`;
  const withinYear = !!first && start >= `${data.year}-01-01` && end <= `${data.year}-12-31`;
  const continuous = statements.every((statement, i) => {
    if (!i) return true;
    const previous = statements[i - 1];
    const nextDay = new Date(previous.endDate + 'T00:00:00.000Z');
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return statement.startDate === nextDay.toISOString().slice(0, 10) && cents(statement.openingBalance) === cents(previous.closingBalance);
  });
  const complete = data.transactions.length === data.total && !data.hasMore;
  const covered = data.transactions.every(t => statements.some(s => s.id === t.statementId && t.fecha >= s.startDate && t.fecha <= s.endDate));
  const matches = withinYear && covered && statements.every(s => cents(s.openingBalance) + data.transactions.filter(t => t.statementId === s.id).reduce((sum, t) => sum + signedCents(t), 0) === cents(s.closingBalance));
  return {
    start,
    end,
    opening: withinYear ? first?.openingBalance ?? null : null,
    closing: last?.closingBalance ?? null,
    continuous,
    matches,
    complete,
    verified: withinYear && continuous && matches && complete,
    fullYear: start === `${data.year}-01-01` && end === `${data.year}-12-31`
  };
}
export function bankMonths(data: BankActivityData, visible: BankMovement[]) {
  // Source closings are never recomputed from a category/status/month subset.
  const context = statementContext(data);
  const months: string[] = [];
  for (let month = 1; month <= 12; month++) {
    const key = `${data.year}-${String(month).padStart(2, '0')}`;
    if (key >= context.start.slice(0, 7) && key <= context.end.slice(0, 7)) months.push(key);
  }
  return months.map(key => {
    const rows = visible.filter(t => t.fecha.startsWith(key));
    const statement = data.statements.filter(s => s.endDate.startsWith(key)).sort((a, b) => a.endDate.localeCompare(b.endDate)).at(-1);
    return {
      key,
      ...bankTotals(rows),
      count: rows.length,
      closing: statement?.closingBalance ?? null,
      closingDate: statement?.endDate ?? null
    };
  });
}
const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
export function bankMovementsCSV(rows: BankMovement[]) {
  // Preserve the published column order, direction and positive-magnitude convention.
  return '\uFEFFfecha,descripcion,monto,tipo,cuenta_contable,conciliado,categoria,mes\n' + rows.map(t => `${t.fecha},${csvCell(t.descripcion || '')},${t.monto},${t.tipo},${csvCell(t.cuenta_contable || '')},${t.conciliado ? 'si' : 'no'},${csvCell(savedCategory(t))},${t.fecha.slice(0, 7)}\n`).join('');
}
export function bankSummaryCSV(data: BankActivityData): string | null {
  const context = statementContext(data);
  if (!context.verified) return null;
  // Full source scope only: never export a subset-derived "bank closing".
  const months = bankMonths(data, data.transactions);
  const endDate = new Date(context.end + 'T00:00:00Z');
  const lastDay = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 0)).getUTCDate();
  const fullMonths = context.start.endsWith('-01') && endDate.getUTCDate() === lastDay;
  const averages = new Map(fullMonths ? buildMonthlyBalances(data.transactions, context.opening!).map(m => [m.monthKey, m.promedio]) : []);
  return '\uFEFFmes,ingresos,egresos,flujo_neto,saldo_cierre,saldo_promedio\n' + months.map(m => `${m.key},${m.incoming.toFixed(2)},${m.outgoing.toFixed(2)},${m.net.toFixed(2)},${m.closing?.toFixed(2) ?? ''},${averages.get(m.key)?.toFixed(2) ?? ''}\n`).join('');
}
