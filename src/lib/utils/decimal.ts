/**
 * Safe numeric conversion from Prisma Decimal or plain number.
 * Handles both `Prisma.Decimal` objects (which have `.toNumber()`)
 * and plain JS numbers returned by mocks or other sources.
 *
 * @param val - A Prisma Decimal, a plain number, null, or undefined
 * @param fallback - Value to return when val is null/undefined (default: 0)
 */
export function toNum(val: unknown, fallback = 0): number {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') return val;
  if (typeof (val as { toNumber?: () => number }).toNumber === 'function') {
    return (val as { toNumber: () => number }).toNumber();
  }
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}
