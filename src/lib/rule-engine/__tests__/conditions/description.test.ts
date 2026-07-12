import { describe, it, expect } from 'vitest';
import { makeTransaction, makeCondition } from '../fixtures';
import {
  evaluateDescriptionEq,
  evaluateDescriptionContains,
  evaluateDescriptionStartsWith,
  evaluateDescriptionEndsWith,
  evaluateDescriptionMatches,
} from '../../conditions/description';
import { InvalidRegex } from '../../errors';

describe('description_eq', () => {
  it('matches when equal', () => {
    const tx = makeTransaction({ description: 'Netflix' });
    const result = evaluateDescriptionEq(makeCondition('description_eq', 'Netflix'), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBe(1);
  });

  it('does not match when differs (case-sensitive)', () => {
    const tx = makeTransaction({ description: 'Netflix' });
    const result = evaluateDescriptionEq(makeCondition('description_eq', 'netflix'), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('description_contains', () => {
  it('matches when description contains value', () => {
    const tx = makeTransaction({ description: 'Payment to Netflix' });
    const result = evaluateDescriptionContains(makeCondition('description_contains', 'Netflix'), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('does not match when value not found', () => {
    const tx = makeTransaction({ description: 'Payment to Netflix' });
    const result = evaluateDescriptionContains(makeCondition('description_contains', 'Spotify'), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('handles empty description gracefully', () => {
    const tx = makeTransaction({ description: '' });
    const result = evaluateDescriptionContains(makeCondition('description_contains', 'Netflix'), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('handles empty value', () => {
    const tx = makeTransaction({ description: 'anything' });
    const result = evaluateDescriptionContains(makeCondition('description_contains', ''), tx);
    expect(result.match).toBe(true);
  });

  it('guards against value longer than description', () => {
    const tx = makeTransaction({ description: 'abc' });
    const result = evaluateDescriptionContains(makeCondition('description_contains', 'abcdef'), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('description_starts_with', () => {
  it('matches when description starts with value', () => {
    const tx = makeTransaction({ description: 'Netflix Monthly' });
    const result = evaluateDescriptionStartsWith(makeCondition('description_starts_with', 'Netflix'), tx);
    expect(result.match).toBe(true);
  });
});

describe('description_ends_with', () => {
  it('matches when description ends with value', () => {
    const tx = makeTransaction({ description: 'Subscription Netflix' });
    const result = evaluateDescriptionEndsWith(makeCondition('description_ends_with', 'Netflix'), tx);
    expect(result.match).toBe(true);
  });
});

describe('description_matches', () => {
  it('matches valid regex pattern', () => {
    const tx = makeTransaction({ description: 'INVOICE #123' });
    const result = evaluateDescriptionMatches(makeCondition('description_matches', 'INVOICE \\#\\d+'), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('does not match when pattern not found', () => {
    const tx = makeTransaction({ description: 'Payment' });
    const result = evaluateDescriptionMatches(makeCondition('description_matches', 'INVOICE \\d+'), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('throws InvalidRegex for invalid pattern', () => {
    const tx = makeTransaction({ description: 'test' });
    expect(() => evaluateDescriptionMatches(makeCondition('description_matches', '[invalid'), tx)).toThrow(InvalidRegex);
  });
});
