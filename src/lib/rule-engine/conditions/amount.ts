import type { RuleCondition, Transaction, EvaluatedCondition } from '../types';

function toNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (isNaN(n)) throw new Error('Invalid numeric value');
  return n;
}

export function evaluateAmountGt(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const value = toNumber(condition.value);
  const match = transaction.amount > value;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `amount ${transaction.amount} > ${value}: ${match}` };
}

export function evaluateAmountGte(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const value = toNumber(condition.value);
  const match = transaction.amount >= value;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `amount ${transaction.amount} >= ${value}: ${match}` };
}

export function evaluateAmountLt(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const value = toNumber(condition.value);
  const match = transaction.amount < value;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `amount ${transaction.amount} < ${value}: ${match}` };
}

export function evaluateAmountLte(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const value = toNumber(condition.value);
  const match = transaction.amount <= value;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `amount ${transaction.amount} <= ${value}: ${match}` };
}

export function evaluateAmountEq(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const value = toNumber(condition.value);
  const match = transaction.amount === value;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `amount ${transaction.amount} === ${value}: ${match}` };
}

export function evaluateAmountRange(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  if (!condition.range) {
    return { type: condition.type, score: 0, match: false, detail: 'No range defined' };
  }
  const [min, max] = condition.range;
  const amount = transaction.amount;

  if (min === max) {
    const match = amount === min;
    return { type: condition.type, score: match ? 1 : 0, match, detail: `amount_range [${min},${max}] degenerate, amount ${amount} === ${min}: ${match}` };
  }

  const match = amount >= min && amount <= max;
  const score = match ? 1 - Math.abs(amount - (min + max) / 2) / ((max - min) / 2) : 0;
  return { type: condition.type, score, match, detail: `amount ${amount} in [${min},${max}]: ${match}` };
}

export const amountEvaluators = {
  amount_gt: evaluateAmountGt,
  amount_gte: evaluateAmountGte,
  amount_lt: evaluateAmountLt,
  amount_lte: evaluateAmountLte,
  amount_eq: evaluateAmountEq,
  amount_range: evaluateAmountRange,
} as const;
