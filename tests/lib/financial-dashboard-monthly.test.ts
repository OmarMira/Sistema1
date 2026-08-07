import { describe, it, expect } from 'vitest';
import { buildMonthlyBalances } from '@/lib/financial-dashboard-monthly';
import type { Transaction } from '@/lib/constants/financial-dashboard-types';

function tx(fecha: string, monto: number, tipo: 'credito' | 'debito' = 'debito'): Transaction {
  return {
    id: `t-${fecha}-${monto}-${tipo}`,
    fecha,
    monto,
    tipo,
    descripcion: '',
    cuenta_contable: '',
    conciliado: false,
  };
}

describe('buildMonthlyBalances', () => {
  it('is deterministic: given the same transactions and initialBalance it returns the same output', () => {
    const input = [
      tx('2024-03-05', 100, 'credito'),
      tx('2024-03-20', 40),
    ];
    expect(buildMonthlyBalances(input, 0)).toEqual(buildMonthlyBalances(input, 0));
  });

  it('single month (Mar 2024): +100 on day 5, -40 on day 20', () => {
    const rows = buildMonthlyBalances(
      [tx('2024-03-05', 100, 'credito'), tx('2024-03-20', 40)],
      0,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].monthKey).toBe('2024-03');
    expect(rows[0].monthLabel).toBe('Mar 2024');
    expect(rows[0].ingresos).toBe(100);
    expect(rows[0].gastos).toBe(40);
    expect(rows[0].netFlow).toBe(60);
    expect(rows[0].cierre).toBe(60);
    // daily balances: 4 days of 0, 15 days of 100, 12 days of 60 -> (0*4 + 100*15 + 60*12)/31
    expect(rows[0].promedio).toBeCloseTo(2220 / 31, 6);
    expect(rows[0].txs).toHaveLength(2);
  });

  it('several consecutive months carry the closing balance as the next month opening', () => {
    const rows = buildMonthlyBalances(
      [
        tx('2024-01-10', 100, 'credito'), // cierre ene = 100
        tx('2024-02-05', 50, 'credito'), // cierre feb = 150
        tx('2024-03-12', 30), // cierre mar = 120
      ],
      0,
    );

    expect(rows.map((r) => r.monthKey)).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(rows.map((r) => r.cierre)).toEqual([100, 150, 120]);
  });

  it('a seeded month without movements keeps the previous closing balance as opening, unchanged', () => {
    const rows = buildMonthlyBalances(
      [
        tx('2024-01-10', 120, 'credito'),
        tx('2024-03-20', 50), // no movements in Feb
      ],
      0,
    );

    const feb = rows.find((r) => r.monthKey === '2024-02');
    expect(feb).toBeDefined();
    expect(feb!.ingresos).toBe(0);
    expect(feb!.gastos).toBe(0);
    expect(feb!.netFlow).toBe(0);
    // opening of Feb = Jan cierre (120); no movements -> cierre stays 120 (carryover)
    expect(feb!.cierre).toBe(120);
    expect(feb!.promedio).toBeCloseTo(120, 6);
    expect(feb!.txs).toHaveLength(0);
  });

  it('credits and debits in the same month net correctly', () => {
    const rows = buildMonthlyBalances(
      [
        tx('2024-06-02', 50, 'credito'),
        tx('2024-06-15', 20),
        tx('2024-06-28', 30, 'credito'),
        tx('2024-06-29', 10),
      ],
      0,
    );

    expect(rows[0].cierre).toBe(50); // 50 - 20 + 30 - 10
    expect(rows[0].ingresos).toBe(80); // 50 + 30
    expect(rows[0].gastos).toBe(30); // 20 + 10
  });

  it('non-zero initial balance is applied as the running base', () => {
    const rows = buildMonthlyBalances([tx('2024-09-10', 200, 'credito')], 5000);

    expect(rows[0].cierre).toBe(5200);
    expect(rows[0].ingresos).toBe(200);
  });

  it('returns months chronologically even when input is unordered', () => {
    const rows = buildMonthlyBalances(
      [
        tx('2024-03-12', 30),
        tx('2024-01-10', 100, 'credito'),
        tx('2024-02-05', 50, 'credito'),
      ],
      0,
    );

    expect(rows.map((r) => r.monthKey)).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(rows.map((r) => r.cierre)).toEqual([100, 150, 120]);
  });

  it('exact carryover: closing of month N is the opening of month N+1', () => {
    const rows = buildMonthlyBalances(
      [
        tx('2024-01-15', 120, 'credito'),
        // no Feb movements: Feb opening must equal Jan closing (120)
        tx('2024-03-15', 25, 'credito'),
      ],
      0,
    );

    expect(rows[0].cierre).toBe(120);
    expect(rows[1].cierre).toBe(120); // carried opening, unchanged month
    expect(rows[2].cierre).toBe(145); // 120 + 25 credit
  });

  it('empty transactions produce an empty result', () => {
    expect(buildMonthlyBalances([], 1000)).toEqual([]);
  });
});