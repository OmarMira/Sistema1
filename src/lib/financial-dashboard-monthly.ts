import { Transaction, MONTHS_SPANISH } from './constants/financial-dashboard-types';

export interface MonthlyBalance {
  monthKey: string;
  monthLabel: string;
  ingresos: number;
  gastos: number;
  netFlow: number;
  cierre: number;
  promedio: number;
  txs: Transaction[];
}

/**
 * Pure, deterministic monthly aggregation of a filtered transaction list into
 * per-month balance rows. This is the exact algorithm formerly inlined in the
 * FinancialDashboardPage component's useMemo; it only depends on its inputs
 * (it derives month ranges from the transaction dates, never from the system
 * clock), so the result is stable for identical inputs.
 */
export function buildMonthlyBalances(
  transactions: Transaction[],
  initialBalance: number,
): MonthlyBalance[] {
  const map = new Map<
    string,
    { monthKey: string; ingresos: number; gastos: number; txs: Transaction[] }
  >();

  // Seed all chronologically consecutive months within the transaction range to
  // keep timelines solid. The month key is derived directly from the civil
  // "YYYY-MM-DD" string (never from a parsed Date + local getters), so the
  // timeline is independent of the process timezone.
  if (transactions.length > 0) {
    const sorted = [...transactions].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const firstMonthKey = sorted[0]!.fecha.substring(0, 7);
    const lastMonthKey = sorted[sorted.length - 1]!.fecha.substring(0, 7);

    const [firstYear, firstMonth] = firstMonthKey.split('-').map(Number);
    const [lastYear, lastMonth] = lastMonthKey.split('-').map(Number);

    if (
      Number.isFinite(firstYear) &&
      Number.isFinite(firstMonth) &&
      Number.isFinite(lastYear) &&
      Number.isFinite(lastMonth)
    ) {
      const startIdx = firstYear! * 12 + (firstMonth! - 1);
      const endIdx = lastYear! * 12 + (lastMonth! - 1);
      for (let idx = startIdx; idx <= endIdx; idx += 1) {
        const y = Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        map.set(ym, { monthKey: ym, ingresos: 0, gastos: 0, txs: [] });
      }
    }
  }

  // Paginate actual figures
  transactions.forEach((t) => {
    const ym = t.fecha.substring(0, 7);
    if (!map.has(ym)) {
      map.set(ym, { monthKey: ym, ingresos: 0, gastos: 0, txs: [] });
    }
    const b = map.get(ym)!;
    if (t.tipo === 'credito') {
      b.ingresos += t.monto;
    } else {
      b.gastos += t.monto;
    }
    b.txs.push(t);
  });

  const sortedYm = Array.from(map.keys()).sort();
  let currentBal = initialBalance;

  const finalMonths = sortedYm.map((ym) => {
    const b = map.get(ym)!;
    const net = b.ingresos - b.gastos;

    // Track daily averages
    const [year, month] = ym.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dailyBalances: number[] = [];
    let runningBal = currentBal;

    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = `${ym}-${String(d).padStart(2, '0')}`;
      const dayTxs = b.txs.filter((t) => t.fecha === dayStr);
      dayTxs.forEach((t) => {
        if (t.tipo === 'credito') runningBal += t.monto;
        else runningBal -= t.monto;
      });
      dailyBalances.push(runningBal);
    }

    currentBal = runningBal;
    const avg = dailyBalances.reduce((s, x) => s + x, 0) / daysInMonth;

    // Formatting label
    const monthIndex = month - 1;
    const label = MONTHS_SPANISH[monthIndex]?.name || ym;

    return {
      monthKey: ym,
      monthLabel: `${label} ${year}`,
      ingresos: b.ingresos,
      gastos: b.gastos,
      netFlow: net,
      cierre: currentBal,
      promedio: avg,
      txs: b.txs,
    };
  });

  return finalMonths;
}