import { describe, it, expect } from 'vitest';
import { civilDateFromParts, civilDateFromString } from '@/lib/accounting/civil-date';

describe('civilDateFromParts', () => {
  it.each([
    [2026, 1, 1, '2026-01-01T00:00:00.000Z'],
    [2026, 3, 1, '2026-03-01T00:00:00.000Z'],
    [2026, 12, 31, '2026-12-31T00:00:00.000Z'],
    [2024, 2, 29, '2024-02-29T00:00:00.000Z'],
  ] as const)('builds the exact UTC-midnight instant for %i-%i-%i', (year, month, day, iso) => {
    const date = civilDateFromParts(year, month, day);
    expect(date).not.toBeNull();
    expect(date!.toISOString()).toBe(iso);
    expect(date!.getUTCHours()).toBe(0);
    expect(date!.getUTCMinutes()).toBe(0);
    expect(date!.getUTCSeconds()).toBe(0);
    expect(date!.getUTCMilliseconds()).toBe(0);
  });

  it.each([
    [2026, 2, 30],
    [2025, 2, 29],
    [2026, 13, 1],
    [2026, 0, 1],
    [2026, 1, 0],
    [2026, 1, 32],
  ] as const)('rejects the nonexistent civil date %i-%i-%i', (year, month, day) => {
    expect(civilDateFromParts(year, month, day)).toBeNull();
  });

  it('does not silently roll 2026-02-30 over to March', () => {
    expect(civilDateFromParts(2026, 2, 30)).toBeNull();
  });

  it('does not silently roll a non-leap 2025-02-29 over to March', () => {
    expect(civilDateFromParts(2025, 2, 29)).toBeNull();
  });

  it('accepts the leap-year 2024-02-29', () => {
    expect(civilDateFromParts(2024, 2, 29)?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });

  it('rejects non-integer components', () => {
    expect(civilDateFromParts(2026, 1.5, 1)).toBeNull();
    expect(civilDateFromParts(2026, 1, NaN)).toBeNull();
  });
});

describe('civilDateFromString', () => {
  it('accepts strict YYYY-MM-DD date-only strings', () => {
    expect(civilDateFromString('2026-01-01')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(civilDateFromString('2026-03-01')?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(civilDateFromString('2026-12-31')?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(civilDateFromString('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });

  it('rejects invalid or non-strict date-only strings', () => {
    expect(civilDateFromString('2026-02-30')).toBeNull();
    expect(civilDateFromString('2025-02-29')).toBeNull();
    expect(civilDateFromString('2026-13-01')).toBeNull();
    expect(civilDateFromString('2026-01-00')).toBeNull();
    expect(civilDateFromString('2026-1-1')).toBeNull();
    expect(civilDateFromString('2026/01/01')).toBeNull();
    expect(civilDateFromString('not-a-date')).toBeNull();
    expect(civilDateFromString('')).toBeNull();
  });
});
