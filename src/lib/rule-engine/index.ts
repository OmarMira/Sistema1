import type { RuleInput, RuleOutput } from './types';
import { isRuleEngineV2Enabled } from './flag';

export function evaluateRules(_input: RuleInput): RuleOutput {
  if (!isRuleEngineV2Enabled()) {
    return { candidates: [], decision: undefined };
  }

  return { candidates: [], decision: undefined };
}

export type {
  RuleInput,
  RuleOutput,
  Candidate,
  Transaction,
  BankRule,
  RuleCondition,
  RuleConditionType,
  RuleLifecycleStatus,
} from './types';

export {
  RuleEngineError,
  InvalidInputError,
  MissingTransaction,
  MissingContext,
  InvalidTransaction,
  ConditionEvalError,
  InvalidRegex,
  InvalidNumericValue,
  InvalidDateValue,
  UnsupportedConditionError,
  UnknownConditionTypeError,
} from './errors';
