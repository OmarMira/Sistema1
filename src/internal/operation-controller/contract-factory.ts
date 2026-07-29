import type { Intent, ExecutionContract } from './types';

export function createExecutionContract(intent: Intent): ExecutionContract {
  return {
    intentId: intent.id,
    target: intent.target,
    resourceType: intent.resourceType,
    operation: intent.operation,
    allowedEffects: intent.effects,
    forbiddenEffects: [],
    budget: { maxChanges: intent.changes ?? 1 },
    expectedState: intent.expectedState ?? {},
    observedPaths: intent.observedPaths ?? [intent.target],
    verificationScope: intent.verificationScope,
  };
}