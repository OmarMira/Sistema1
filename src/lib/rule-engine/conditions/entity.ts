import type { RuleCondition, Transaction, EvaluatedCondition } from '../types';
import { UnsupportedConditionError } from '../errors';

export function evaluateEntityEq(_condition: RuleCondition, _transaction: Transaction): EvaluatedCondition {
  throw new UnsupportedConditionError('entity_eq', { reason: 'entity matching not implemented in Sprint 1' });
}

export const entityEvaluators = {
  entity_eq: evaluateEntityEq,
} as const;
