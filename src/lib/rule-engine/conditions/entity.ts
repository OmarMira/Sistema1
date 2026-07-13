import type { RuleCondition, Transaction, EvaluatedCondition, EntityResolution } from '../types';
import { MissingEntityIdError } from '../errors';

function getResolution(context?: { entityResolution?: EntityResolution }): EntityResolution {
  return context?.entityResolution ?? { status: 'not_run' };
}

export function evaluateEntityEq(
  condition: RuleCondition,
  _transaction: Transaction,
  context?: { entityResolution?: EntityResolution },
): EvaluatedCondition {
  const er = getResolution(context);

  if (er.status === 'not_run') {
    throw new MissingEntityIdError('entity_eq', { reason: 'Entity resolution was not executed' });
  }

  if (er.status === 'not_found') {
    return { type: 'entity_eq', score: 0, match: false, detail: 'Entity not found' };
  }

  const matches = condition.value === er.entityId;
  return {
    type: 'entity_eq',
    score: matches ? 1 : 0,
    match: matches,
    detail: matches ? `Entity ${er.entityId} matches` : `Entity ${er.entityId} does not match ${condition.value}`,
  };
}

export const entityEvaluators = {
  entity_eq: evaluateEntityEq,
} as const;
