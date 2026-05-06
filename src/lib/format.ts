/**
 * Format a number as USD currency.
 * Examples: 1234.56 → "$1,234.56" | -1234.56 → "-$1,234.56"
 */
export function formatCurrency(amount: number): string {
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

/**
 * Format a date string or Date object as "Jan 15, 2026".
 */
export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a number with thousands separator.
 * Example: 1234 → "1,234"
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/**
 * Simple classname merger – filters out falsy values and joins with space.
 */
export function cn(
  ...classes: (string | undefined | null | false)[]
): string {
  return classes.filter(Boolean).join(' ');
}
