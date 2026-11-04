/**
 * Money boundary — exact cent arithmetic for accounting data.
 *
 * ─── Invariant ──────────────────────────────────────────────────────────────
 * ALL money arithmetic MUST go through this module. Raw `+` / `-` (and any
 * other float arithmetic) on money fields is FORBIDDEN: JS numbers are binary
 * floating point, so `0.1 + 0.2 !== 0.3` and a 1000-row sum of 0.10 drifts.
 * Convert to integer cents with `toCents`, do the arithmetic in cents
 * (`sumCents`, `compareCents`, `maxAbsCents`) and convert back with
 * `fromCents` only at the API/UI edge.
 *
 * ─── Rounding convention ────────────────────────────────────────────────────
 * ROUND_HALF_UP (half-away-from-zero), the Decimal.js `toDecimalPlaces(2,
 * ROUND_HALF_UP)` default and the convention used by the fiscal documents:
 *   toCents(1.005)  ===  101   (not 100 — the float path via toFixed loses it)
 *   toCents(2.675)  ===  268
 *   toCents(-1.005) === -101   (away from zero, not toward it)
 *
 * ─── Safe-range guard ───────────────────────────────────────────────────────
 * Exactly representable money at the JS `number` edge requires
 * |cents| <= Number.MAX_SAFE_INTEGER (2^53 - 1 = 9_007_199_254_740_991 cents,
 * ≈ ±$90,071,992,547,409.91). Any larger magnitude throws a descriptive
 * RangeError instead of silently drifting. Keep such values as
 * `Prisma.Decimal`/`string`; never coerce them to `number`.
 *
 * ─── Precision nuance at the top of that range ─────────────────────────────
 * A JS number holds integer cents exactly up to 2^53 - 1, but a *dollar* amount
 * written as a double keeps its last cent only while the double spacing (ulp)
 * stays below half a cent. The round-trip identity
 * `toCents(fromCents(c)) === c` therefore holds for |cents| <= 2^52
 * (≈ $45.04 trillion, tested); above it a value can still pass the range
 * guard yet lose its final cent inside the double (first observed at
 * 7_333_260_920_154_682 cents). Realistic accounting magnitudes are many
 * orders of magnitude below that; anything larger stays Decimal/string.
 *
 * ─── Implementation ────────────────────────────────────────────────────────
 * `Prisma.Decimal` (Decimal.js, already a dependency via Prisma) performs the
 * exact decimal → 2-decimal ROUND_HALF_UP → cents conversion for Decimal
 * values, which is the path `src/lib/db.ts` uses. Plain numbers and strings are
 * converted by an exact digit-string parser that implements the SAME
 * convention (no float arithmetic, no `toFixed`, no `Math.round`): a number is
 * first reduced to its shortest round-trip decimal representation, which is
 * precisely the value Decimal.js would read. Both paths are cross-checked in
 * tests/money/money.test.ts and share the same safe-range guard. The parser
 * also keeps the module usable where `@prisma/client` is replaced by a test
 * double that does not expose `Prisma.Decimal`.
 *
 * ─── Portability ────────────────────────────────────────────────────────────
 * Pure JS on top of `Prisma.Decimal` — no new packages, no Node-only APIs at
 * module top level and no Decimal access at import time, so this module stays
 * importable from Edge-traced code such as `src/lib/db.ts`.
 */
import { Prisma } from '@prisma/client';

/** Money is stored and rounded at 2 decimal places (Postgres `Decimal(18,2)`). */
export const MONEY_SCALE = 2;

/** Largest magnitude of integer cents that a JS number holds exactly (2^53 - 1). */
export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/** Same limit as exact digits, used by the digit-string range check. */
const MAX_SAFE_CENTS_DIGITS = '9007199254740991';

/** Human-readable form of the limit, used in error messages. */
const MAX_SAFE_CENTS_LABEL =
  '9007199254740991 (Number.MAX_SAFE_INTEGER = 2^53 - 1 ≈ ±$90,071,992,547,409.91)';

/** Any value that carries a money amount: Prisma Decimal, number or string. */
export type MoneyValue = Prisma.Decimal | number | string;

/** Minimal structural view of a Decimal.js value (avoids a runtime import). */
interface DecimalLike {
  toDecimalPlaces(places: number, rounding: number): DecimalLike & {
    times(other: number): DecimalLike & {
      isInteger(): boolean;
      abs(): { gt(other: number): boolean };
      toFixed(places: number): string;
      toNumber(): number;
    };
  };
}

type DecimalConstructor = new (value: unknown) => DecimalLike;

/** Resolve `Prisma.Decimal` lazily; test doubles for @prisma/client omit it. */
function decimalConstructor(): DecimalConstructor | null {
  const candidate = (Prisma as unknown as { Decimal?: unknown } | undefined)?.Decimal;
  return typeof candidate === 'function' ? (candidate as DecimalConstructor) : null;
}

function roundingMode(constructor: DecimalConstructor): number {
  const mode = (constructor as unknown as { ROUND_HALF_UP?: number }).ROUND_HALF_UP;
  // Decimal.js ROUND_HALF_UP is 4; keep a literal fallback for partial stubs.
  return typeof mode === 'number' ? mode : 4;
}

function unsafeCents(value: string | number): RangeError {
  return new RangeError(
    `[money] money value exceeds the safe cent range: ${String(value)} — ` +
      `JS numbers are exact only up to |cents| <= ${MAX_SAFE_CENTS_LABEL}. ` +
      `Keep the amount as Prisma.Decimal or string instead of coercing it to number.`,
  );
}

/** Increment a non-negative digit string by one (no float arithmetic). */
function incrementDigits(digits: string): string {
  const chars = digits.split('');
  let index = chars.length - 1;
  while (index >= 0) {
    if (chars[index] === '9') {
      chars[index] = '0';
      index -= 1;
    } else {
      chars[index] = String(Number(chars[index]) + 1);
      break;
    }
  }
  if (index < 0) chars.unshift('1');
  return chars.join('');
}

/**
 * Exact decimal string → integer cents, rounding half-up (away from zero) at
 * two decimals and scaling by 100. Operates on digit strings only: every
 * rounding decision is a character comparison, so `1.005` is 101 cents and
 * `2.675` is 268 cents regardless of binary representation.
 */
function centsFromDecimalString(text: string, original: unknown = text): number {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) {
    throw new TypeError(`[money] not a decimal money value: ${JSON.stringify(text)}`);
  }
  const negative = match[1] === '-';
  const integerPart = match[2] ?? '';
  const fractionPart = match[3] ?? '';
  const exponentText = match[4];
  if (integerPart === '' && fractionPart === '') {
    throw new TypeError(`[money] not a decimal money value: ${JSON.stringify(text)}`);
  }
  const exponent = exponentText ? Number(exponentText) : 0;
  if (!Number.isSafeInteger(exponent)) throw unsafeCents(String(original));

  const digits = (integerPart + fractionPart).replace(/^0+/, '');
  if (digits === '') return 0; // zero — also normalizes -0 and 0.000…

  // value === digits * 10^scale, where scale already includes the ×100 for cents.
  const scale = exponent - fractionPart.length + MONEY_SCALE;
  if (!Number.isSafeInteger(scale)) throw unsafeCents(String(original));

  let centsDigits: string;
  if (scale >= 0) {
    if (digits.length + scale > MAX_SAFE_CENTS_DIGITS.length) throw unsafeCents(String(original));
    centsDigits = digits + '0'.repeat(scale);
  } else {
    const kept = digits.length + scale;
    if (kept < 0) {
      centsDigits = '0'; // far below half a cent
    } else {
      const dropped = kept === 0 ? digits[0] : digits[kept];
      const keptDigits = kept === 0 ? '0' : digits.slice(0, kept);
      centsDigits = dropped !== undefined && dropped >= '5' ? incrementDigits(keptDigits) : keptDigits;
    }
  }

  centsDigits = centsDigits.replace(/^0+/, '') || '0';
  if (
    centsDigits.length > MAX_SAFE_CENTS_DIGITS.length ||
    (centsDigits.length === MAX_SAFE_CENTS_DIGITS.length && centsDigits > MAX_SAFE_CENTS_DIGITS)
  ) {
    throw unsafeCents(String(original));
  }

  const cents = Number(centsDigits);
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * Throw when integer `cents` cannot be represented exactly by a JS number.
 * Named limit: |cents| <= Number.MAX_SAFE_INTEGER (9007199254740991).
 */
export function assertSafeCents(cents: number): void {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`[money] cents is not a finite number: ${String(cents)}`);
  }
  if (Math.abs(cents) > MAX_SAFE_CENTS) {
    throw unsafeCents(cents);
  }
}

/**
 * Exact decimal → integer cents.
 *
 * `Prisma.Decimal` values are converted with Decimal.js itself: parse exactly,
 * round to 2 decimals with ROUND_HALF_UP and multiply by 100 (Decimal, not
 * float). Numbers and strings go through the equivalent exact digit-string
 * parser (a number first reduced to its shortest round-trip decimal form).
 * Both paths throw the safe-range RangeError when the cent magnitude exceeds
 * 2^53 - 1 instead of returning a drifted number.
 */
export function toCents(value: MoneyValue): number {
  if (value === null || value === undefined) {
    throw new TypeError('[money] money value is missing (null/undefined); expected Decimal, number or string');
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`[money] money value is not a finite number: ${String(value)}`);
    }
    // String(number) is the shortest decimal that round-trips to the same
    // double — the exact representation Decimal.js also parses.
    return centsFromDecimalString(String(value), value);
  }

  if (typeof value === 'string') {
    return centsFromDecimalString(value, value);
  }

  const Decimal = decimalConstructor();
  if (!Decimal) {
    // @prisma/client replaced by a test double without Decimal: the value's own
    // exact decimal string is still converted without any float arithmetic.
    return centsFromDecimalString(String(value), value);
  }

  const scaled = new Decimal(value)
    .toDecimalPlaces(MONEY_SCALE, roundingMode(Decimal))
    .times(100);
  if (!scaled.isInteger()) {
    // Defensive: multiplication by 100 of a 2-decimal value is always integral.
    throw new RangeError(`[money] non-integral cent value produced from ${String(value)}`);
  }
  if (scaled.abs().gt(MAX_SAFE_CENTS)) {
    throw unsafeCents(scaled.toFixed(0));
  }
  const cents = scaled.toNumber();
  // Normalize negative zero so `toCents(-0)` is 0, never -0.
  return cents === 0 ? 0 : cents;
}

/**
 * Integer cents → money number at the API/UI edge.
 *
 * The result is the double nearest to the exact cent value, so
 * `toCents(fromCents(cents)) === cents` for every |cents| <= 2^52 — the
 * round-trip identity the rest of the app relies on (see the module header for
 * the precision nuance above that bound). Larger magnitudes throw.
 */
export function fromCents(cents: number): number {
  assertSafeCents(cents);
  if (!Number.isInteger(cents)) {
    throw new RangeError(`[money] cents must be an integer, received ${String(cents)}`);
  }
  return cents / 100;
}

/** Exact sum of integer cents; the running total is range-checked after each add. */
export function sumCents(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    assertSafeCents(value);
    if (!Number.isInteger(value)) {
      throw new RangeError(`[money] cannot sum a non-integer cent value: ${String(value)}`);
    }
    total += value;
    // Guard every step: integer addition is exact only inside the safe range.
    assertSafeCents(total);
  }
  return total === 0 ? 0 : total;
}

/** Compare two cent amounts: -1 when a < b, 1 when a > b, 0 when equal. */
export function compareCents(a: number, b: number): number {
  assertSafeCents(a);
  assertSafeCents(b);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Largest absolute magnitude among the given cent amounts (always >= 0). */
export function maxAbsCents(...values: number[]): number {
  let max = 0;
  for (const value of values) {
    assertSafeCents(value);
    const magnitude = Math.abs(value);
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/**
 * Exact Decimal → number coercion for the db.ts result layer:
 * Decimal → cents (exact) → cents → number. Identical to the previous
 * `Number(decimal)` for every valid 2-decimal amount, but it throws the
 * descriptive safe-range error instead of returning a drifted value when the
 * stored magnitude exceeds 2^53 - 1 cents.
 */
export function toMoneyNumber(value: MoneyValue): number {
  return fromCents(toCents(value));
}
