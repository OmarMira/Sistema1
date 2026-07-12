import type { RuleCondition, Transaction, EvaluatedCondition } from '../types';
import { InvalidDateValue } from '../errors';

function parseDateValue(value: string | number, conditionType: string): Date {
  const d = new Date(String(value));
  if (isNaN(d.getTime())) throw new InvalidDateValue(conditionType as any, { value });
  return d;
}

export function evaluateDateBefore(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const threshold = parseDateValue(condition.value, condition.type);
  const match = transaction.date < threshold;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `date ${transaction.date.toISOString()} < ${threshold.toISOString()}: ${match}` };
}

export function evaluateDateAfter(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const threshold = parseDateValue(condition.value, condition.type);
  const match = transaction.date > threshold;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `date ${transaction.date.toISOString()} > ${threshold.toISOString()}: ${match}` };
}

export const dateEvaluators = {
  date_before: evaluateDateBefore,
  date_after: evaluateDateAfter,
} as const;
