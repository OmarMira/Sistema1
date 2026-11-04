import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  MAX_SAFE_CENTS,
  assertSafeCents,
  compareCents,
  fromCents,
  maxAbsCents,
  sumCents,
  toCents,
  toMoneyNumber,
} from '@/lib/money';

/**
 * S1 — cent-based money primitives.
 *
 * Every assertion below is stated in cents, the only representation in which
 * accounting arithmetic is exact. The rounding convention is ROUND_HALF_UP
 * (half-away-from-zero), matching the convention documented in the module.
 */

describe('S1 — toCents: exact decimal→cent conversion', () => {
  it('resolves the 0.1 + 0.2 class exactly', () => {
    // The float sum drifts; the cent conversion must not.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(0.2)).toBe(20);
    expect(sumCents(toCents(0.1), toCents(0.2))).toBe(30);
    expect(fromCents(sumCents(toCents(0.1), toCents(0.2)))).toBe(0.3);
    // A float artifact already present at the input still lands on 30 cents.
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('rounds 1.005 half-up to 101 cents (not 100)', () => {
    // Number(1.005).toFixed(2) === '1.00' because the double is slightly below
    // 1.005; Decimal parses the shortest round-trip representation '1.005'.
    expect(Number(1.005).toFixed(2)).toBe('1.00');
    expect(toCents(1.005)).toBe(101);
    expect(toCents('1.005')).toBe(101);
    expect(toCents(new Prisma.Decimal('1.005'))).toBe(101);
  });

  it('rounds 2.675 half-up to 268 cents', () => {
    expect(Number(2.675).toFixed(2)).toBe('2.67');
    expect(toCents(2.675)).toBe(268);
    expect(toCents('2.675')).toBe(268);
  });

  it('rounds negative amounts half-away-from-zero', () => {
    expect(toCents(-1.005)).toBe(-101);
    expect(toCents('-1.005')).toBe(-101);
    expect(toCents(-1.004)).toBe(-100);
    expect(toCents(-0.005)).toBe(-1);
    expect(toCents(0.005)).toBe(1);
  });

  it('accepts Decimal, number and string inputs identically', () => {
    for (const input of [new Prisma.Decimal('0.29'), 0.29, '0.29'] as const) {
      expect(toCents(input)).toBe(29);
    }
    expect(toCents(new Prisma.Decimal('1234.56'))).toBe(123456);
    expect(toCents('0.00')).toBe(0);
    expect(toCents(-0)).toBe(0);
  });

  it('rounds numbers/strings exactly like the Prisma.Decimal path', () => {
    // The two implementations (Decimal.js and the exact digit-string parser)
    // must agree on every rounding boundary and sign.
    const corpus = [
      '0.00', '0.01', '0.004', '0.005', '-0.005', '-0.004', '1.005', '2.675', '-1.005',
      '0.10', '0.20', '1234.56', '250.50', '999999999.99', '-99.99', '1e-3', '1e2',
      '90071992547409.91', '-90071992547409.91', '+7.777', '0012.340',
    ];
    for (const amount of corpus) {
      expect(toCents(amount)).toBe(toCents(new Prisma.Decimal(amount)));
    }
    for (const amount of [0.1, 0.2, 1.005, 2.675, -1.005, 0.005, -0.004, 1234.56, 1e-3, 1e2]) {
      expect(toCents(amount)).toBe(toCents(new Prisma.Decimal(amount)));
      expect(toCents(amount)).toBe(toCents(String(amount)));
    }
  });
});

describe('S1 — sums and comparisons in cents', () => {
  it('sums 1000 × 0.10 to exactly 10000 cents', () => {
    const cents = Array.from({ length: 1000 }, () => toCents('0.10'));
    // The float reduction drifts; the cent sum does not.
    const floatSum = Array.from({ length: 1000 }, () => 0.1).reduce((a, b) => a + b, 0);
    expect(floatSum).not.toBe(100);
    expect(sumCents(...cents)).toBe(10000);
    expect(fromCents(sumCents(...cents))).toBe(100);
  });

  it('handles mixed signs exactly', () => {
    expect(sumCents(1999, -1, -999)).toBe(999);
    expect(sumCents(-10, -20, 30)).toBe(0);
    expect(sumCents()).toBe(0);
    expect(sumCents(-5)).toBe(-5);
    expect(fromCents(sumCents(toCents('0.10'), toCents('-0.20'), toCents('0.30')))).toBe(0.2);
  });

  it('compares cents', () => {
    expect(compareCents(100, 100)).toBe(0);
    expect(compareCents(99, 100)).toBe(-1);
    expect(compareCents(100, 99)).toBe(1);
    expect(compareCents(-100, 100)).toBe(-1);
  });

  it('reports the largest absolute magnitude', () => {
    expect(maxAbsCents(-700, 250, 0)).toBe(700);
    expect(maxAbsCents(10, -10)).toBe(10);
    expect(maxAbsCents()).toBe(0);
  });
});

describe('S1 — fromCents round-trip identity', () => {
  it('round-trips cents → number → cents for realistic magnitudes', () => {
    for (const cents of [0, 1, -1, 10, -10, 100, 123456, 999999999, -999999999, 1e12, -1e12]) {
      expect(toCents(fromCents(cents))).toBe(cents);
    }
  });

  it('round-trips sampled magnitudes up to the documented 2^52-cent bound', () => {
    // 2^52 cents ≈ $45.04 trillion. Above that the double spacing exceeds half
    // a cent and the last cent can be lost (documented in the module header).
    const samples = [2 ** 50, 2 ** 51, 2 ** 52, 1125899906842624, 2251799813685247];
    for (let i = 0; i < 200; i += 1) {
      samples.push(Math.floor(Math.random() * 2 ** 52));
    }
    for (const cents of samples) {
      expect(toCents(fromCents(cents))).toBe(cents);
      expect(toCents(fromCents(-cents))).toBe(-cents);
    }
  });

  it('round-trips decimal strings at cent granularity', () => {
    for (const [amount, cents] of [['0.01', 1], ['0.10', 10], ['1.23', 123], ['250.50', 25050], ['999999999.99', 99999999999], ['-99.99', -9999]] as const) {
      expect(toCents(amount)).toBe(cents);
      expect(fromCents(cents)).toBe(Number(amount));
    }
  });
});

describe('S1 — safe-range guard names the exact limit', () => {
  it('accepts the boundary and rejects one cent beyond it', () => {
    expect(MAX_SAFE_CENTS).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => assertSafeCents(MAX_SAFE_CENTS)).not.toThrow();
    expect(() => assertSafeCents(-MAX_SAFE_CENTS)).not.toThrow();
    expect(() => fromCents(MAX_SAFE_CENTS)).not.toThrow();
    expect(() => assertSafeCents(MAX_SAFE_CENTS + 1)).toThrow(RangeError);
    expect(() => assertSafeCents(MAX_SAFE_CENTS + 1)).toThrow(/9007199254740991/);
    expect(() => assertSafeCents(-(MAX_SAFE_CENTS + 1))).toThrow(RangeError);
  });

  it('rejects Decimal magnitudes that JS numbers cannot represent exactly', () => {
    // 90071992547409.91 → exactly 2^53-1 cents (the limit); one cent more throws.
    expect(toCents('90071992547409.91')).toBe(MAX_SAFE_CENTS);
    expect(() => toCents('90071992547409.92')).toThrow(RangeError);
    expect(() => toCents('90071992547409.92')).toThrow(/9007199254740991/);
    expect(() => fromCents(MAX_SAFE_CENTS + 1)).toThrow(RangeError);
    expect(() => toCents(1e21)).toThrow(RangeError);
  });

  it('names the limit in the error message', () => {
    expect(() => assertSafeCents(MAX_SAFE_CENTS + 1)).toThrow(
      /MAX_SAFE_INTEGER|9007199254740991/,
    );
  });
});

describe('S1 — toMoneyNumber (db.ts coercion helper)', () => {
  it('returns the exact same number JS parses for realistic Decimal amounts', () => {
    for (const amount of ['0.10', '0.20', '1234.56', '250.50', '-99.99', '0.00']) {
      expect(toMoneyNumber(new Prisma.Decimal(amount))).toBe(Number(amount));
    }
    expect(toMoneyNumber(new Prisma.Decimal('0.1'))).toBe(0.1);
    expect(toMoneyNumber('0.30')).toBe(0.3);
    expect(toMoneyNumber(0.29)).toBe(0.29);
  });

  it('rounds sub-cent precision half-up before converting', () => {
    expect(toMoneyNumber(new Prisma.Decimal('1.005'))).toBe(1.01);
    expect(toMoneyNumber(new Prisma.Decimal('2.675'))).toBe(2.68);
  });

  it('throws the descriptive safe-range error instead of drifting', () => {
    expect(toMoneyNumber(new Prisma.Decimal('90071992547409.91'))).toBe(Number('90071992547409.91'));
    expect(() => toMoneyNumber(new Prisma.Decimal('90071992547409.92'))).toThrow(RangeError);
    expect(() => toMoneyNumber(new Prisma.Decimal('90071992547409.92'))).toThrow(/9007199254740991/);
  });
});
