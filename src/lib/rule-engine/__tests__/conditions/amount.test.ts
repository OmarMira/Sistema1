import { describe, it, expect } from 'vitest';
import { makeTransaction, makeCondition } from '../fixtures';
import { evaluateAmountGt, evaluateAmountGte, evaluateAmountLt, evaluateAmountLte, evaluateAmountEq, evaluateAmountRange } from '../../conditions/amount';

describe('amount_gt', () => {
  it('matches when amount > value', () => {
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateAmountGt(makeCondition('amount_gt', 500), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBe(1);
  });

  it('does not match when amount <= value', () => {
    const tx = makeTransaction({ amount: 400 });
    const result = evaluateAmountGt(makeCondition('amount_gt', 500), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('amount_gte', () => {
  it('matches when amount >= value', () => {
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateAmountGte(makeCondition('amount_gte', 500), tx);
    expect(result.match).toBe(true);
  });

  it('does not match when amount < value', () => {
    const tx = makeTransaction({ amount: 400 });
    const result = evaluateAmountGte(makeCondition('amount_gte', 500), tx);
    expect(result.match).toBe(false);
  });
});

describe('amount_lt', () => {
  it('matches when amount < value', () => {
    const tx = makeTransaction({ amount: 400 });
    const result = evaluateAmountLt(makeCondition('amount_lt', 500), tx);
    expect(result.match).toBe(true);
  });
});

describe('amount_lte', () => {
  it('matches when amount <= value', () => {
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateAmountLte(makeCondition('amount_lte', 500), tx);
    expect(result.match).toBe(true);
  });
});

describe('amount_eq', () => {
  it('matches when amount === value', () => {
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateAmountEq(makeCondition('amount_eq', 500), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBe(1);
  });

  it('does not match when amount differs', () => {
    const tx = makeTransaction({ amount: 501 });
    const result = evaluateAmountEq(makeCondition('amount_eq', 500), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('amount_range', () => {
  it('matches when amount is inside range', () => {
    const tx = makeTransaction({ amount: 750 });
    const result = evaluateAmountRange(makeCondition('amount_range', '', [500, 1000]), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('does not match when amount is below min', () => {
    const tx = makeTransaction({ amount: 100 });
    const result = evaluateAmountRange(makeCondition('amount_range', '', [500, 1000]), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('does not match when amount is above max', () => {
    const tx = makeTransaction({ amount: 1500 });
    const result = evaluateAmountRange(makeCondition('amount_range', '', [500, 1000]), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('treats [x, x] as amount_eq (degenerate)', () => {
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateAmountRange(makeCondition('amount_range', '', [500, 500]), tx);
    expect(result.match).toBe(true);
    expect(result.score).toBe(1);
  });

  it('degenerate range does not match off-by-one', () => {
    const tx = makeTransaction({ amount: 501 });
    const result = evaluateAmountRange(makeCondition('amount_range', '', [500, 500]), tx);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });
});
