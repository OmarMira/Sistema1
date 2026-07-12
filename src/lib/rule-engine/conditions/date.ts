import type { RuleCondition, Transaction, EvaluatedCondition } from '../types';

function parseDateValue(value: string | number): Date {
  const d = new Date(String(value));
  if (isNaN(d.getTime())) throw new Error('Invalid date value');
  return d;
}

export function evaluateDateBefore(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const threshold = parseDateValue(condition.value);
  const match = transaction.date < threshold;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `date ${transaction.date.toISOString()} < ${threshold.toISOString()}: ${match}` };
}

export function evaluateDateAfter(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const threshold = parseDateValue(condition.value);
  const match = transaction.date > threshold;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `date ${transaction.date.toISOString()} > ${threshold.toISOString()}: ${match}` };
}

export const dateEvaluators = {
  date_before: evaluateDateBefore,
  date_after: evaluateDateAfter,
} as const;
