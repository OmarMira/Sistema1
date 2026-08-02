import { describe, it, expect } from 'vitest';
import {
  WILDCARD_SURFACE,
  isWildcardValue,
  legacyConditionType,
  evaluateWildcardCondition,
} from '../wildcard';
import { makeCondition, makeTransaction } from './fixtures';

describe('WILDCARD_SURFACE', () => {
  it('marks the four description string operators as wildcard-capable', () => {
    expect(WILDCARD_SURFACE.description_contains).toBe(true);
    expect(WILDCARD_SURFACE.description_eq).toBe(true);
    expect(WILDCARD_SURFACE.description_starts_with).toBe(true);
    expect(WILDCARD_SURFACE.description_ends_with).toBe(true);
  });

  it('excludes regex and all amount operators from the surface', () => {
    expect(WILDCARD_SURFACE.description_matches).toBe(false);
    for (const type of ['amount_gt', 'amount_gte', 'amount_lt', 'amount_lte', 'amount_eq', 'amount_range']) {
      expect(WILDCARD_SURFACE[type]).toBe(false);
    }
  });
});

describe('isWildcardValue', () => {
  it('recognizes the exact marker after normalization', () => {
    expect(isWildcardValue('*')).toBe(true);
    expect(isWildcardValue(' * ')).toBe(true);
  });

  it('rejects non-wildcard values', () => {
    expect(isWildcardValue('abc')).toBe(false);
    expect(isWildcardValue('.*')).toBe(false);
    expect(isWildcardValue('ab*cd')).toBe(false);
    expect(isWildcardValue('')).toBe(false);
    expect(isWildcardValue(100)).toBe(false);
  });
});

describe('legacyConditionType', () => {
  it('maps legacy description operators to canonical types', () => {
    expect(legacyConditionType('description', 'contains')).toBe('description_contains');
    expect(legacyConditionType('description', 'equals')).toBe('description_eq');
    expect(legacyConditionType('description', 'starts_with')).toBe('description_starts_with');
    expect(legacyConditionType('description', 'ends_with')).toBe('description_ends_with');
  });

  it('maps legacy amount operators to canonical types', () => {
    expect(legacyConditionType('amount', 'greater_than')).toBe('amount_gt');
    expect(legacyConditionType('amount', 'amount_less')).toBe('amount_lt');
  });

  it('returns empty string for unknown pairs', () => {
    expect(legacyConditionType('description', 'bogus')).toBe('');
    expect(legacyConditionType(undefined, 'equals')).toBe('');
  });
});

describe('evaluateWildcardCondition', () => {
  it('matches non-empty description on the surface', () => {
    const tx = makeTransaction({ description: 'TX synthetique alpha' });
    const result = evaluateWildcardCondition(makeCondition('description_contains', '*'), tx);
    expect(result).not.toBeNull();
    expect(result?.match).toBe(true);
    expect(result?.score).toBe(1);
  });

  it('does not match an empty description', () => {
    const tx = makeTransaction({ description: '' });
    const result = evaluateWildcardCondition(makeCondition('description_eq', '*'), tx);
    expect(result).not.toBeNull();
    expect(result?.match).toBe(false);
    expect(result?.score).toBe(0);
  });

  it('returns null for off-surface types (amount)', () => {
    const tx = makeTransaction({ description: 'anything', amount: 100 });
    const result = evaluateWildcardCondition(makeCondition('amount_gt', '*'), tx);
    expect(result).toBeNull();
  });

  it('returns null for off-surface types (regex)', () => {
    const tx = makeTransaction({ description: 'anything' });
    const result = evaluateWildcardCondition(makeCondition('description_matches', '*'), tx);
    expect(result).toBeNull();
  });

  it('returns null when the value is not the wildcard marker', () => {
    const tx = makeTransaction({ description: 'anything' });
    const result = evaluateWildcardCondition(makeCondition('description_contains', 'netflix'), tx);
    expect(result).toBeNull();
  });
});
