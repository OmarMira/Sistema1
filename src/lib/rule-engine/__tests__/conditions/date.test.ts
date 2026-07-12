import { describe, it, expect } from 'vitest';
import { makeTransaction, makeCondition } from '../fixtures';
import { evaluateDateBefore, evaluateDateAfter } from '../../conditions/date';
import { InvalidDateValue } from '../../errors';

describe('date_before', () => {
  it('matches when transaction date is before threshold', () => {
    const tx = makeTransaction({ date: new Date('2024-06-01') });
    const result = evaluateDateBefore(makeCondition('date_before', '2024-07-01'), tx);
    expect(result.match).toBe(true);
  });

  it('does not match when transaction date is after threshold', () => {
    const tx = makeTransaction({ date: new Date('2024-08-01') });
    const result = evaluateDateBefore(makeCondition('date_before', '2024-07-01'), tx);
    expect(result.match).toBe(false);
  });
});

describe('date_after', () => {
  it('matches when transaction date is after threshold', () => {
    const tx = makeTransaction({ date: new Date('2024-08-01') });
    const result = evaluateDateAfter(makeCondition('date_after', '2024-07-01'), tx);
    expect(result.match).toBe(true);
  });

  it('does not match when transaction date is before threshold', () => {
    const tx = makeTransaction({ date: new Date('2024-06-01') });
    const result = evaluateDateAfter(makeCondition('date_after', '2024-07-01'), tx);
    expect(result.match).toBe(false);
  });
});

describe('invalid value', () => {
  it('throws InvalidDateValue when value is not a date', () => {
    const tx = makeTransaction({ date: new Date() });
    expect(() => evaluateDateBefore(makeCondition('date_before', 'not-a-date'), tx)).toThrow(InvalidDateValue);
  });

  it('throws InvalidDateValue with condition type', () => {
    const tx = makeTransaction({ date: new Date() });
    try {
      evaluateDateBefore(makeCondition('date_before', 'not-a-date'), tx);
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidDateValue);
      expect((e as InvalidDateValue).conditionType).toBe('date_before');
    }
  });
});
