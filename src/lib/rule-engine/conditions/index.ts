import type { RuleCondition, Transaction, EvaluatedCondition, EntityResolution } from '../types';
import type { RuleConditionType } from '../types';
import { UnknownConditionTypeError } from '../errors';
import { amountEvaluators } from './amount';
import { descriptionEvaluators } from './description';
import { dateEvaluators } from './date';
import { entityEvaluators } from './entity';
import { evaluateWildcardCondition, isWildcardValue } from '../wildcard';

export type EvaluatorFn = (
  condition: RuleCondition,
  transaction: Transaction,
  context?: { entityResolution?: EntityResolution },
) => EvaluatedCondition;

const evaluatorMap: Record<RuleConditionType, EvaluatorFn> = {
  ...amountEvaluators,
  ...descriptionEvaluators,
  ...dateEvaluators,
  ...entityEvaluators,
};

export function evaluateCondition(
  condition: RuleCondition,
  transaction: Transaction,
  context?: { entityResolution?: EntityResolution },
): EvaluatedCondition {
  const fn = evaluatorMap[condition.type];
  if (!fn) {
    throw new UnknownConditionTypeError(condition.type, { type: condition.type });
  }
  if (isWildcardValue(condition.value)) {
    const wildcardResult = evaluateWildcardCondition(condition, transaction);
    if (wildcardResult !== null) return wildcardResult;
    return {
      type: condition.type,
      score: 0,
      match: false,
      detail: `wildcard "*" is not supported on "${condition.type}": no match`,
    };
  }
  return fn(condition, transaction, context);
}

export function getSupportedTypes(): RuleConditionType[] {
  return Object.keys(evaluatorMap) as RuleConditionType[];
}
