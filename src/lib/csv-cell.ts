/**
 * Single source of truth for encoding one CSV cell.
 *
 * Extracted from src/lib/dashboard/bank-activity.ts so every exporter
 * (financial reports, dashboard exports, API CSV routes) shares the exact same
 * quoting rules.
 *
 * Two jobs, in this order:
 *  1. Formula-injection neutralization (CSV injection / "formula injection"):
 *     a cell that starts with `=`, `+`, `-`, `@` (or a leading tab/CR) is
 *     prefixed with an apostrophe so Excel/Sheets/LibreOffice treat it as
 *     literal text instead of executing it.
 *  2. RFC 4180 quoting: the value is wrapped in double quotes and embedded
 *     quotes are doubled.
 *
 * Numeric columns that the exporters emit themselves (amounts, debits,
 * credits) do not go through this helper — they are generated from numbers,
 * never from user text, and must stay unquoted to remain numeric in the
 * spreadsheet.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const neutralized = FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}
