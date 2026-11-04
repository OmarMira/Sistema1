import { describe, it, expect } from 'vitest';
import { getTranslation, humanizeKey, translations } from '@/lib/i18n';
import { buildMonthlyBalances } from '@/lib/financial-dashboard-monthly';
import type { Transaction } from '@/lib/constants/financial-dashboard-types';

/**
 * S23g — the i18n fallback must never render a raw key.
 */

/** Literal copy of the pre-S23g lookup (getTranslation: `fallback ?? key`). */
function legacyGetTranslation(
  locale: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  let current: unknown = locale;
  for (const part of key.split('.')) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return fallback ?? key;
    }
  }
  return typeof current === 'string' ? current : (fallback ?? key);
}
describe('S23g — i18n fallback humanization', () => {
  it('never returns the raw dotted key on a miss', () => {
    const locale = translations.es as Record<string, unknown>;
    // RED (executed): the previous implementation returned the raw key.
    expect(legacyGetTranslation(locale, 'onboarding.step1.legalNameUnused')).toBe(
      'onboarding.step1.legalNameUnused',
    );
    expect(legacyGetTranslation(locale, 'no.such.translation', 'no.such.translation')).toBe(
      'no.such.translation',
    );

    const rendered = getTranslation(locale, 'onboarding.step1.legalNameUnused');

    expect(rendered).toBe('legalNameUnused');
    expect(rendered).not.toContain('.');
    // The spec's example key resolves to its last segment when missing.
    expect(humanizeKey('onboarding.step1.legalName')).toBe('legalName');
  });

  it('humanizes separators in the last segment', () => {
    expect(humanizeKey('common.viewErrorDesc')).toBe('viewErrorDesc');
    expect(humanizeKey('billing.invoice_status')).toBe('invoice status');
    expect(humanizeKey('billing.invoice-status')).toBe('invoice status');
  });

  it('treats the key-as-fallback call style (t(key)) as a miss too', () => {
    // The language store calls getTranslation(locale, key, key): a miss there
    // used to leak "reports.exportModalTitle" straight into the UI.
    const rendered = getTranslation(translations.es as Record<string, unknown>, 'no.such.translation', 'no.such.translation');
    expect(rendered).toBe('translation');
  });

  it('keeps a real explicit fallback when one is provided', () => {
    expect(getTranslation(translations.es as Record<string, unknown>, 'no.such.key', 'Respaldo')).toBe(
      'Respaldo',
    );
  });

  it('still resolves existing keys from both locales', () => {
    expect(getTranslation(translations.es as Record<string, unknown>, 'common.save')).toBeTypeOf('string');
    expect(getTranslation(translations.en as Record<string, unknown>, 'common.save')).toBeTypeOf('string');
  });
});

/**
 * S23c — money is accumulated in integer cents.
 *
 * Reference: the pre-change implementation accumulated `number` amounts
 * directly. On exact-cent inputs both produce the same values; on inputs where
 * float addition drifts, the cents implementation is the exact one.
 */
function legacyBuildMonthlyBalances(transactions: Transaction[], initialBalance: number) {
  const map = new Map<string, { ingresos: number; gastos: number; txs: Transaction[] }>();
  transactions.forEach((t) => {
    const ym = t.fecha.substring(0, 7);
    if (!map.has(ym)) map.set(ym, { ingresos: 0, gastos: 0, txs: [] });
    const b = map.get(ym)!;
    if (t.tipo === 'credito') b.ingresos += t.monto;
    else b.gastos += t.monto;
    b.txs.push(t);
  });

  let currentBal = initialBalance;
  return [...map.keys()].sort().map((ym) => {
    const b = map.get(ym)!;
    const [year, month] = ym.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dailyBalances: number[] = [];
    let runningBal = currentBal;
    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = `${ym}-${String(d).padStart(2, '0')}`;
      b.txs
        .filter((t) => t.fecha === dayStr)
        .forEach((t) => {
          if (t.tipo === 'credito') runningBal += t.monto;
          else runningBal -= t.monto;
        });
      dailyBalances.push(runningBal);
    }
    currentBal = runningBal;
    return {
      monthKey: ym,
      ingresos: b.ingresos,
      gastos: b.gastos,
      netFlow: b.ingresos - b.gastos,
      cierre: currentBal,
      promedio: dailyBalances.reduce((s, x) => s + x, 0) / daysInMonth,
    };
  });
}

const tx = (fecha: string, monto: number, tipo: 'credito' | 'debito'): Transaction =>
  ({
    id: `${fecha}-${monto}-${tipo}`,
    fecha,
    descripcion: 'row',
    monto,
    tipo,
    cuenta_contable: '6010 Office',
    conciliado: true,
  }) as Transaction;

describe('S23c — buildMonthlyBalances accumulates in integer cents', () => {
  it('matches the previous implementation exactly on exact-cent inputs', () => {
    const rows = [
      tx('2025-01-05', 100.5, 'credito'),
      tx('2025-01-20', 20.25, 'debito'),
      tx('2025-02-10', 45.75, 'credito'),
      tx('2025-02-11', 5.5, 'debito'),
    ];

    const expected = legacyBuildMonthlyBalances(rows, 1000);
    const actual = buildMonthlyBalances(rows, 1000);

    expect(actual.map((m) => ({
      monthKey: m.monthKey,
      ingresos: m.ingresos,
      gastos: m.gastos,
      netFlow: m.netFlow,
      cierre: m.cierre,
    }))).toEqual(
      expected.map((m) => ({
        monthKey: m.monthKey,
        ingresos: m.ingresos,
        gastos: m.gastos,
        netFlow: m.netFlow,
        cierre: m.cierre,
      })),
    );

    // The daily average is a derived ratio (cents ÷ days), not an accumulated
    // amount: it agrees with the float implementation to well under a cent.
    actual.forEach((month, index) => {
      expect(month.promedio).toBeCloseTo(expected[index]!.promedio, 6);
    });
  });

  it('never drifts on mixed decimals (0.1 + 0.2 is 0.3)', () => {
    const rows = [tx('2025-01-05', 0.1, 'credito'), tx('2025-01-06', 0.2, 'credito')];

    const legacy = legacyBuildMonthlyBalances(rows, 0);
    const exact = buildMonthlyBalances(rows, 0);

    expect(legacy[0]!.ingresos).not.toBe(0.3); // documents the old float drift
    expect(exact[0]!.ingresos).toBe(0.3);
    expect(exact[0]!.netFlow).toBe(0.3);
    expect(exact[0]!.cierre).toBe(0.3);
  });

  it('keeps the running balance exact across many fractional rows', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      tx(`2025-03-${String(index + 1).padStart(2, '0')}`, 0.07, 'credito'),
    );

    const month = buildMonthlyBalances(rows, 0)[0]!;
    expect(month.ingresos).toBe(0.7);
    expect(month.cierre).toBe(0.7);
  });

  it('ignores sub-cent noise instead of accumulating it', () => {
    const month = buildMonthlyBalances([tx('2025-04-02', 10.005, 'credito')], 0)[0]!;
    // 10.005 → 1001 cents → 10.01 (rounded once, at the boundary)
    expect(month.ingresos).toBe(10.01);
  });
});
