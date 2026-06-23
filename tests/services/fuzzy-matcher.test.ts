import { describe, it, expect } from 'vitest';
import { runFuzzyMatch, type FuzzyMatchResult } from '@/lib/accounting/fuzzy-matcher';
import type { FuzzyCandidate } from '@/lib/accounting/fuzzy-pre-filter';

function makeCandidate(overrides: Partial<FuzzyCandidate> & { id: string }): FuzzyCandidate {
  return {
    description: 'Test transaction',
    amount: 100,
    date: new Date('2025-03-15'),
    ...overrides,
  };
}

describe('runFuzzyMatch()', () => {
  it('returns empty array when candidates are empty', () => {
    const result = runFuzzyMatch([], 'some description');
    expect(result).toEqual([]);
  });

  it('returns exact match with score 100', () => {
    const candidates = [makeCandidate({ id: '1', description: 'Zelle payment to LAURA QUIJANO' })];
    const result = runFuzzyMatch(candidates, 'Zelle payment to LAURA QUIJANO');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(100);
    expect(result[0].id).toBe('1');
  });

  it('returns match with high score for similar descriptions', () => {
    const candidates = [makeCandidate({ id: '1', description: 'Zelle payment to JOHN DOE' })];
    const result = runFuzzyMatch(candidates, 'Zelle payment to JOHN DO');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(85);
  });

  it('filters out matches below the minimum score', () => {
    const candidates = [makeCandidate({ id: '1', description: 'AMERICAN AIRLINES TICKET' })];
    // Completely different description — should not match
    const result = runFuzzyMatch(candidates, 'RENT PAYMENT TO LANDLORD', 65);
    expect(result).toHaveLength(0);
  });

  it('returns multiple candidates sorted by score descending', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'Zelle payment to LAURA QUIJANO' }),
      makeCandidate({ id: '2', description: 'Zelle payment to MARIA GOMEZ' }),
      makeCandidate({ id: '3', description: 'AMERICAN EXPRESS ACH PAYMENT' }),
    ];
    const result = runFuzzyMatch(candidates, 'Zelle payment to LAURA QUIJANO');

    expect(result.length).toBeGreaterThanOrEqual(1);
    // Best match first
    expect(result[0].id).toBe('1');
    // Scores should be descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score);
    }
  });

  it('preserves amount, date, and original description in result', () => {
    const candidate = makeCandidate({
      id: '1',
      description: 'Zelle payment to LAURA QUIJANO',
      amount: 500.0,
      date: new Date('2025-03-15'),
    });
    const result = runFuzzyMatch([candidate], 'Zelle payment to LAURA QUIJANO');

    expect(result[0].amount).toBe(500.0);
    expect(result[0].date).toEqual(new Date('2025-03-15'));
    expect(result[0].description).toBe('Zelle payment to LAURA QUIJANO');
  });

  // ── Normalization behavior ──────────────────────────────────────

  it('matches despite volatile Conf# references (no space)', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'Zelle payment to LAURA QUIJANO Conf#T0YKY6RCL' }),
    ];
    const result = runFuzzyMatch(candidates, 'Zelle payment to LAURA QUIJANO Conf#X1Y2Z3');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(85);
  });

  it('matches despite volatile Conf# references (with space)', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'Zelle payment to LAURA QUIJANO Conf# T0YKY6RCL' }),
    ];
    const result = runFuzzyMatch(candidates, 'Zelle payment to LAURA QUIJANO Conf# X1Y2Z3');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(85);
  });

  it('matches despite volatile ID: tags', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'ACH PMT ID:M4884 DES:MERCHANT CO ID:1234' }),
    ];
    const result = runFuzzyMatch(candidates, 'ACH PMT ID:X9999 DES:MERCHANT CO ID:5678');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(75);
  });

  it('matches despite Zelle vs payment prefix variations', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'Zelle payment to LAURA QUIJANO' }),
    ];
    // "payment to LAURA QUIJANO" (without Zelle prefix) should still match well
    const result = runFuzzyMatch(candidates, 'payment to LAURA QUIJANO');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(80);
  });

  it('handles minimum score parameter correctly', () => {
    const candidates = [makeCandidate({ id: '1', description: 'Zelle payment to JOHN DOE' })];
    // With minScore=100, only exact match passes
    const result = runFuzzyMatch(candidates, 'Zelle payment to JANE SMITH', 100);
    expect(result).toHaveLength(0);
  });

  it('ranks the best match first', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'Zelle payment to LAURA QUIJANO' }),
      makeCandidate({ id: '2', description: 'Zelle payment to JOHN DOE' }),
    ];
    const result = runFuzzyMatch(candidates, 'Zelle payment to LAURA QUIJANO');
    expect(result[0].id).toBe('1');
    expect(result[0].score).toBeGreaterThanOrEqual(result[1]?.score ?? 0);
  });

  it('preserves INDN: name in normalization for matching', () => {
    const candidates = [
      makeCandidate({ id: '1', description: 'AMERICAN EXPRESS DES:ACH PMT ID:123 INDN:LAURA QUIJANO' }),
    ];
    const result = runFuzzyMatch(candidates, 'AMERICAN EXPRESS DES:ACH PMT ID:456 INDN:LAURA QUIJANO');
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(80);
  });
});

describe('runFuzzyMatch() — custom minScore', () => {
  const candidates = [makeCandidate({ id: '1', description: 'SOME TRANSACTION' })];

  it('includes match with permissive threshold', () => {
    const result = runFuzzyMatch(candidates, 'OTHER TRANSACTION', 30);
    expect(result).toHaveLength(1);
  });

  it('excludes same match with strict threshold', () => {
    const result = runFuzzyMatch(candidates, 'OTHER TRANSACTION', 95);
    expect(result).toHaveLength(0);
  });
});
