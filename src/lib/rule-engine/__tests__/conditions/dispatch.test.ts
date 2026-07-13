import { describe, it, expect } from 'vitest';
import type { RuleConditionType, RuleCondition } from '../../types';
import { makeCondition, makeTransaction } from '../fixtures';
import { evaluateCondition, getSupportedTypes } from '../../conditions/index';
import { UnknownConditionTypeError, MissingEntityIdError } from '../../errors';

describe('dispatch map', () => {
  it('dispatches amount_gt correctly', () => {
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateCondition(makeCondition('amount_gt', 500), tx);
    expect(result.match).toBe(true);
  });

  it('dispatches description_contains correctly', () => {
    const tx = makeTransaction({ description: 'Payment to Netflix' });
    const result = evaluateCondition(makeCondition('description_contains', 'Netflix'), tx);
    expect(result.match).toBe(true);
  });

  it('dispatches date_before correctly', () => {
    const tx = makeTransaction({ date: new Date('2024-06-01') });
    const result = evaluateCondition(makeCondition('date_before', '2024-07-01'), tx);
    expect(result.match).toBe(true);
  });

  it('dispatches entity_eq to real evaluator (throws MissingEntityIdError without context)', () => {
    const tx = makeTransaction();
    expect(() => evaluateCondition(makeCondition('entity_eq', 'x'), tx)).toThrow(MissingEntityIdError);
  });

  it('throws UnknownConditionTypeError for unknown type', () => {
    const tx = makeTransaction();
    const badCondition: RuleCondition = { type: 'foo_bar' as RuleConditionType, value: 'x' };
    expect(() => evaluateCondition(badCondition, tx)).toThrow(UnknownConditionTypeError);
  });

  it('getSupportedTypes returns all 14 types', () => {
    const types = getSupportedTypes();
    expect(types).toContain('amount_gt');
    expect(types).toContain('amount_gte');
    expect(types).toContain('amount_lt');
    expect(types).toContain('amount_lte');
    expect(types).toContain('amount_eq');
    expect(types).toContain('amount_range');
    expect(types).toContain('description_eq');
    expect(types).toContain('description_contains');
    expect(types).toContain('description_starts_with');
    expect(types).toContain('description_ends_with');
    expect(types).toContain('description_matches');
    expect(types).toContain('entity_eq');
    expect(types).toContain('date_before');
    expect(types).toContain('date_after');
    expect(types.length).toBe(14);
  });
});
