import { describe, it, expect } from 'vitest';
import { formatCurrency, formatDate, formatNumber, cn } from '@/lib/format';

describe('formatCurrency', () => {
  it('formats positive amount', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56');
  });

  it('formats negative amount with minus before dollar sign', () => {
    expect(formatCurrency(-1234.56)).toBe('-$1,234.56');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('formats whole number with two decimal places', () => {
    expect(formatCurrency(100)).toBe('$100.00');
  });

  it('formats large numbers with thousands separators', () => {
    expect(formatCurrency(1_000_000.5)).toBe('$1,000,000.50');
  });

  it('formats small decimal', () => {
    expect(formatCurrency(0.1)).toBe('$0.10');
  });

  it('formats negative whole number', () => {
    expect(formatCurrency(-500)).toBe('-$500.00');
  });
});

describe('formatDate', () => {
  it('formats a date string (midday to avoid timezone offset)', () => {
    expect(formatDate('2026-01-15T12:00:00Z')).toBe('Jan 15, 2026');
  });

  it('formats a Date object', () => {
    expect(formatDate(new Date(2026, 0, 15))).toBe('Jan 15, 2026');
  });

  it('formats end of year', () => {
    expect(formatDate('2026-12-31T12:00:00Z')).toBe('Dec 31, 2026');
  });

  it('formats first day of year', () => {
    expect(formatDate('2026-01-01T12:00:00Z')).toBe('Jan 1, 2026');
  });

  it('handles Date with time component', () => {
    expect(formatDate(new Date(2026, 5, 18, 14, 30, 0))).toBe('Jun 18, 2026');
  });

  it('returns Invalid Date for unparseable string', () => {
    expect(formatDate('not-a-date')).toBe('Invalid Date');
  });
});

describe('formatNumber', () => {
  it('formats integer with thousands separator', () => {
    expect(formatNumber(1234)).toBe('1,234');
  });

  it('formats large number', () => {
    expect(formatNumber(987654321)).toBe('987,654,321');
  });

  it('formats decimal number', () => {
    expect(formatNumber(1234.56)).toBe('1,234.56');
  });

  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('formats negative number', () => {
    expect(formatNumber(-5000)).toBe('-5,000');
  });

  it('formats small number', () => {
    expect(formatNumber(42)).toBe('42');
  });
});

describe('cn', () => {
  it('joins multiple class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('filters out null values', () => {
    expect(cn('foo', null, 'bar')).toBe('foo bar');
  });

  it('filters out undefined values', () => {
    expect(cn('foo', undefined, 'bar')).toBe('foo bar');
  });

  it('filters out false values', () => {
    expect(cn('foo', false, 'bar')).toBe('foo bar');
  });

  it('returns empty string for all falsy values', () => {
    expect(cn(null, undefined, false)).toBe('');
  });

  it('returns empty string for no arguments', () => {
    expect(cn()).toBe('');
  });

  it('handles mixed falsy values', () => {
    expect(cn('a', null, undefined, false, 'b')).toBe('a b');
  });

  it('handles single argument', () => {
    expect(cn('only')).toBe('only');
  });
});
