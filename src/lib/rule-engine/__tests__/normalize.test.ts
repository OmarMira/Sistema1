import { describe, it, expect } from 'vitest';
import { normalizeText } from '../conditions/normalize';

describe('normalizeText (BRE-008 SSOT)', () => {
  const legacyInlineFormula = (val: string | number): string =>
    String(val).toLowerCase().trim().replace(/\s+/g, ' ');

  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeText('  OmaR   MIRA  ')).toBe('omar mira');
    expect(normalizeText('OMAR MIRA')).toBe('omar mira');
    expect(normalizeText('É MIRA')).toBe('é mira');
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   ')).toBe('');
  });

  it('coerces non-string values', () => {
    expect(normalizeText(123)).toBe('123');
    expect(normalizeText(null as unknown as string)).toBe('null');
  });

  it('preserves wildcard and regex-like literals (no semantic folding)', () => {
    expect(normalizeText('*')).toBe('*');
    expect(normalizeText('INVOICE \\d+')).toBe('invoice \\d+');
  });

  it('matches the legacy inline formula byte-for-byte (neutral refactor)', () => {
    const samples = ['OMAR MIRA', '  oma r  mira ', 'É', 'E\u0301', '', '   ', '*', 'INVOICE #12', 42];
    for (const s of samples) {
      expect(normalizeText(s)).toBe(legacyInlineFormula(s));
    }
  });
});
