/**
 * Civil-date helpers for bank-statement import.
 *
 * A civil banking date ("2026-01-01") MUST be persisted as the exact UTC
 * instant `YYYY-MM-DDT00:00:00.000Z` so that readers using
 * `date.toISOString().substring(0, 10)` always recover the same civil date,
 * regardless of the timezone of the process that imported the statement.
 *
 * Building with the LOCAL-midnight constructor `new Date(y, m - 1, d)` shifts
 * the persisted day in positive-offset timezones (local midnight is before
 * 00:00Z), so every civil-date construction in the import parsers goes through
 * this module. `Date.UTC()` is timezone-independent.
 */
export function civilDateFromParts(year: number, month: number, day: number): Date | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 0 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) return null;

  // Reject silent rollovers: Date.UTC normalizes invalid components (month 13,
  // day 0, 2026-02-30 -> Mar 02, non-leap 2025-02-29 -> Mar 01). If the
  // resulting UTC components do not exactly match the input, the civil date
  // does not exist.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/**
 * Strict date-only string variant ("YYYY-MM-DD", zero-padded). Anything else
 * returns null.
 */
export function civilDateFromString(dateStr: string): Date | null {
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return civilDateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
}
