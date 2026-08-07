import { describe, it, expect } from 'vitest';
import { monthlyTrendKey } from '@/lib/dashboard-monthly-trend';

const MONTH_NAMES = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

interface TrendTx {
  date: Date;
  amount: number;
}

// Espejo mínimo y local del agregado de monthlyTrend (route.ts). LO QUE SE PRUEBA
// DIRECTAMENTE es el bucketing mensual vía monthlyTrendKey (módulo puro @/lib);
// el aritmético de importes y el orden son comprobaciones del shape esperado que
// dependen de este espejo local, NO del handler de la ruta.
function buildTrend(txs: TrendTx[]) {
  const monthMap: Record<string, { income: number; expenses: number }> = {};
  for (const tx of txs) {
    const key = monthlyTrendKey(tx.date);
    if (!monthMap[key]) monthMap[key] = { income: 0, expenses: 0 };
    if (Number(tx.amount) > 0) monthMap[key].income += Number(tx.amount);
    else monthMap[key].expenses += Math.abs(tx.amount);
  }
  return Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => ({
      month: MONTH_NAMES[parseInt(key.split('-')[1] ?? '1', 10) - 1] ?? '',
      income: Math.round(val.income * 100) / 100,
      expenses: Math.round(val.expenses * 100) / 100,
    }));
}

describe('dashboard monthlyTrend month bucket (timezone-independent)', () => {
  it('buckets 2026-01-01T00:00:00.000Z into 2026-01 / Ene (Dec 2025 must not appear)', () => {
    const trend = buildTrend([{ date: new Date('2026-01-01T00:00:00.000Z'), amount: 500 }]);
    expect(trend.map((r) => r.month)).toEqual(['Ene']);
    expect(trend[0].income).toBe(500);
    expect(trend[0].expenses).toBe(0);
  });

  it('handles the year transition 2026-12-31 / 2027-01-01 in chronological order', () => {
    const trend = buildTrend([
      { date: new Date('2027-01-01T00:00:00.000Z'), amount: 50 },
      { date: new Date('2026-12-31T00:00:00.000Z'), amount: 100 },
    ]);
    expect(trend).toEqual([
      { month: 'Dic', income: 100, expenses: 0 },
      { month: 'Ene', income: 50, expenses: 0 },
    ]);
  });

  it('preserves income and expenses amounts exactly', () => {
    const trend = buildTrend([
      { date: new Date('2026-01-01T00:00:00.000Z'), amount: 123.45 },
      { date: new Date('2026-01-10T00:00:00.000Z'), amount: -67.89 },
      { date: new Date('2026-01-20T00:00:00.000Z'), amount: 10 },
    ]);
    expect(trend).toEqual([{ month: 'Ene', income: 133.45, expenses: 67.89 }]);
  });

  it('monthlyTrendKey is deterministic across the whole day of a given civil date', () => {
    expect(monthlyTrendKey(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
    expect(monthlyTrendKey(new Date('2026-01-01T23:59:59.999Z'))).toBe('2026-01');
    expect(monthlyTrendKey(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12');
    expect(monthlyTrendKey(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01');
  });
});
