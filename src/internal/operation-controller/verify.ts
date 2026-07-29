import type { ExecutionContract } from './types';

export interface VerifyResult {
  readonly passed: boolean;
  readonly reason?: string;
  readonly detail: string;
}

const SUPPORTED_OPERATIONS = new Set(['read', 'create', 'modify', 'delete']);

function normalize(value: string): string {
  return value.split('\\').join('/');
}

export function verify(
  contract: ExecutionContract,
  before: Record<string, string>,
  after: Record<string, string>,
): VerifyResult {
  if (!SUPPORTED_OPERATIONS.has(contract.operation)) {
    return {
      passed: false,
      reason: 'unsupported_operation',
      detail: `Operation ${contract.operation} is not supported by file verification`,
    };
  }

  const target = normalize(contract.target);
  const expectedState = Object.fromEntries(
    Object.entries(contract.expectedState).map(([k, v]) => [normalize(k), v]),
  );

  const targetInBefore = target in before;
  const targetInAfter = target in after;
  const targetMayChange =
    contract.operation === 'create' ||
    contract.operation === 'modify' ||
    contract.operation === 'delete';

  if (contract.operation === 'create') {
    if (targetInBefore) {
      return { passed: false, reason: 'target_already_existed', detail: `Target ${target} already existed before create` };
    }
    if (!targetInAfter) {
      return { passed: false, reason: 'target_not_created', detail: `Target ${target} was not created` };
    }
  } else if (contract.operation === 'modify') {
    if (!targetInBefore) {
      return { passed: false, reason: 'target_did_not_exist', detail: `Target ${target} did not exist before modify` };
    }
    if (!targetInAfter) {
      return { passed: false, reason: 'target_deleted_instead', detail: `Target ${target} was deleted instead of modified` };
    }
  } else if (contract.operation === 'delete') {
    if (!targetInBefore) {
      return { passed: false, reason: 'target_did_not_exist', detail: `Target ${target} did not exist before delete` };
    }
    if (targetInAfter) {
      return { passed: false, reason: 'target_not_deleted', detail: `Target ${target} still exists after delete` };
    }
  } else if (contract.operation === 'read') {
    if (!targetInBefore) {
      return { passed: false, reason: 'target_not_found', detail: `Target ${target} does not exist for read` };
    }
  }

  if (targetInAfter && (contract.operation === 'create' || contract.operation === 'modify')) {
    const expected = expectedState[target];
    if (expected === undefined) {
      return { passed: false, reason: 'expected_state_missing', detail: `Expected state missing for ${target}` };
    }
    if (after[target] !== expected) {
      return { passed: false, reason: 'state_mismatch', detail: `Target ${target}: expected "${expected}", got "${after[target]}"` };
    }
  }

  const beforeSet = new Set(Object.keys(before));
  const afterSet = new Set(Object.keys(after));

  for (const key of Object.keys(before)) {
    if (key === target && targetMayChange) continue;
    if (!afterSet.has(key)) {
      return { passed: false, reason: 'lateral_mutation', detail: `File ${key} was deleted outside contract scope` };
    }
    if (before[key] !== after[key]) {
      return { passed: false, reason: 'lateral_mutation', detail: `File ${key} changed outside contract scope` };
    }
  }

  for (const key of Object.keys(after)) {
    if (key === target) continue;
    if (!beforeSet.has(key)) {
      return { passed: false, reason: 'lateral_mutation', detail: `File ${key} was created outside contract scope` };
    }
  }

  return { passed: true, detail: 'State matches contract' };
}