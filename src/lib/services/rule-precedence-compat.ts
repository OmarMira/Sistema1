import { normalize } from '@/lib/services/rule-engine-adapter/conditions-normalizer';
import type { RuleCondition, Transaction } from '@/lib/rule-engine/types';
import type { RulePrecedenceRule } from './rule-precedence-engine';

const AMOUNT_OPERATORS = new Set([
  'amount_greater', 'amount_less', 'greater_than', 'less_than',
  'greaterThan', 'lessThan',
]);

function isAmountOperator(op: string): boolean {
  return AMOUNT_OPERATORS.has(op);
}

export function normalizeText(val: string | number): string {
  return String(val).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Normalizes rule conditions from either V2 JSON format or V1 legacy fields.
 */
export function normalizeRuleForPrecedence(rule: RulePrecedenceRule): RuleCondition[] {
  const hasConditions = Array.isArray(rule.conditions) && rule.conditions.length > 0;

  if (hasConditions) {
    return normalize(rule.conditions);
  }

  if (rule.conditionType && rule.conditionValue != null) {
    const field = isAmountOperator(rule.conditionType) ? 'amount' : 'description';
    return normalize([{
      field,
      operator: rule.conditionType,
      value: rule.conditionValue,
    }]);
  }

  return [];
}

/**
 * Applies V1 compatibility transformations to inputs before V2 evaluation.
 * - Description: case-insensitivity, trim, and space-collapse.
 * - Amount: absolute value magnitude comparisons.
 */
export function normalizeInputsForCompatibility(
  cond: RuleCondition,
  tx: Transaction,
): { cond: RuleCondition; tx: Transaction } {
  let finalCond = cond;
  let finalTx = tx;

  if (cond.type.startsWith('description_') && cond.type !== 'description_matches') {
    finalCond = {
      ...cond,
      value: normalizeText(cond.value),
    };
    finalTx = {
      ...tx,
      description: normalizeText(tx.description),
    };
  } else if (cond.type.startsWith('amount_')) {
    if (cond.type === 'amount_range') {
      finalCond = {
        ...cond,
        range: cond.range
          ? [Math.min(Math.abs(cond.range[0]), Math.abs(cond.range[1])),
             Math.max(Math.abs(cond.range[0]), Math.abs(cond.range[1]))]
          : undefined,
      };
    } else {
      finalCond = {
        ...cond,
        value: Math.abs(Number(cond.value)),
      };
    }
    finalTx = {
      ...tx,
      amount: Math.abs(tx.amount),
    };
  }

  return { cond: finalCond, tx: finalTx };
}
