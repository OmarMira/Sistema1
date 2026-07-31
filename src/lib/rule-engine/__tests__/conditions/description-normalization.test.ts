import { describe, it, expect } from 'vitest';
import { makeTransaction, makeCondition } from '../fixtures';
import {
  evaluateDescriptionEq,
  evaluateDescriptionContains,
  evaluateDescriptionStartsWith,
  evaluateDescriptionEndsWith,
  evaluateDescriptionMatches,
} from '../../conditions/description';

describe('BRE-008 contract 5b: empty/whitespace value after normalize → no match', () => {
  const tx = makeTransaction({ description: 'anything' });

  it('description_eq: empty value → no match', () => {
    expect(evaluateDescriptionEq(makeCondition('description_eq', ''), tx).match).toBe(false);
  });
  it('description_eq: whitespace-only value → no match', () => {
    expect(evaluateDescriptionEq(makeCondition('description_eq', '   '), tx).match).toBe(false);
  });
  it('description_contains: empty value → no match', () => {
    expect(evaluateDescriptionContains(makeCondition('description_contains', ''), tx).match).toBe(false);
  });
  it('description_contains: whitespace-only value → no match', () => {
    expect(evaluateDescriptionContains(makeCondition('description_contains', '   '), tx).match).toBe(false);
  });
  it('description_starts_with: empty value → no match', () => {
    expect(evaluateDescriptionStartsWith(makeCondition('description_starts_with', ''), tx).match).toBe(false);
  });
  it('description_starts_with: whitespace-only value → no match', () => {
    expect(evaluateDescriptionStartsWith(makeCondition('description_starts_with', '   '), tx).match).toBe(false);
  });
  it('description_ends_with: empty value → no match', () => {
    expect(evaluateDescriptionEndsWith(makeCondition('description_ends_with', ''), tx).match).toBe(false);
  });
  it('description_ends_with: whitespace-only value → no match', () => {
    expect(evaluateDescriptionEndsWith(makeCondition('description_ends_with', '   '), tx).match).toBe(false);
  });
});

describe('BRE-008: V2 description evaluators are case-insensitive', () => {
  it('description_eq: case-insensitive', () => {
    const tx = makeTransaction({ description: 'Netflix' });
    expect(evaluateDescriptionEq(makeCondition('description_eq', 'netflix'), tx).match).toBe(true);
    expect(evaluateDescriptionEq(makeCondition('description_eq', 'NETFLIX'), tx).match).toBe(true);
  });
  it('description_contains: case-insensitive', () => {
    const tx = makeTransaction({ description: 'Payment to Netflix' });
    expect(evaluateDescriptionContains(makeCondition('description_contains', 'netflix'), tx).match).toBe(true);
    expect(evaluateDescriptionContains(makeCondition('description_contains', 'NETFLIX'), tx).match).toBe(true);
  });
  it('description_starts_with: case-insensitive', () => {
    const tx = makeTransaction({ description: 'Netflix Monthly' });
    expect(evaluateDescriptionStartsWith(makeCondition('description_starts_with', 'netflix'), tx).match).toBe(true);
  });
  it('description_ends_with: case-insensitive', () => {
    const tx = makeTransaction({ description: 'Subscription Netflix' });
    expect(evaluateDescriptionEndsWith(makeCondition('description_ends_with', 'NETFLIX'), tx).match).toBe(true);
  });
});

describe('BRE-008: trim and whitespace collapse', () => {
  it('description_contains: trims and collapses multiple spaces', () => {
    const tx = makeTransaction({ description: '  OmaR   MIRA  ' });
    expect(evaluateDescriptionContains(makeCondition('description_contains', 'omar mira'), tx).match).toBe(true);
  });
  it('description_eq: trims both sides', () => {
    const tx = makeTransaction({ description: '  omar mira  ' });
    expect(evaluateDescriptionEq(makeCondition('description_eq', 'omar mira'), tx).match).toBe(true);
  });
  it('description_starts_with: collapses spaces', () => {
    const tx = makeTransaction({ description: 'OMA   R MIRA' });
    expect(evaluateDescriptionStartsWith(makeCondition('description_starts_with', 'oma r'), tx).match).toBe(true);
  });
  it('description_ends_with: collapses spaces', () => {
    const tx = makeTransaction({ description: 'PAYMENT OMA  R' });
    expect(evaluateDescriptionEndsWith(makeCondition('description_ends_with', 'oma r'), tx).match).toBe(true);
  });
});

describe('BRE-008: Unicode (no NFC/NFD) and accents (no folding)', () => {
  it('case folding is Unicode-aware (É → é) for contains', () => {
    const tx = makeTransaction({ description: 'É MIRA' });
    expect(evaluateDescriptionContains(makeCondition('description_contains', 'é mira'), tx).match).toBe(true);
  });
  it('composed vs decomposed do NOT match (no NFC/NFD)', () => {
    const composed = 'É MIRA';
    const decomposed = 'E\u0301 MIRA';
    const tx = makeTransaction({ description: composed });
    expect(evaluateDescriptionContains(makeCondition('description_contains', decomposed), tx).match).toBe(false);
    expect(evaluateDescriptionEq(makeCondition('description_eq', decomposed), tx).match).toBe(false);
  });
  it('accents are not folded (é vs e → no match)', () => {
    const tx = makeTransaction({ description: 'café' });
    expect(evaluateDescriptionContains(makeCondition('description_contains', 'cafe'), tx).match).toBe(false);
  });
});

describe('BRE-008: non-string values are coerced with String()', () => {
  it('description_contains: numeric value coerced', () => {
    const tx = makeTransaction({ description: 'Invoice 123' });
    expect(evaluateDescriptionContains(makeCondition('description_contains', 123), tx).match).toBe(true);
  });
});

describe('BRE-008: description_matches stays raw (no normalization)', () => {
  it('regex remains case-sensitive and unmodified', () => {
    const tx = makeTransaction({ description: 'INVOICE #123' });
    expect(evaluateDescriptionMatches(makeCondition('description_matches', 'INVOICE \\#\\d+'), tx).match).toBe(true);
    expect(evaluateDescriptionMatches(makeCondition('description_matches', 'invoice \\#\\d+'), tx).match).toBe(false);
  });
});
