import type { RuleInput, RuleOutput } from './types';
import { isRuleEngineV2Enabled } from './flag';
import { runPipeline } from './pipeline';
import { MissingTransaction, MissingContext, InvalidTransaction } from './errors';

export function evaluateRules(input: RuleInput): RuleOutput {
  if (!isRuleEngineV2Enabled()) {
    return { candidates: [], decision: undefined };
  }

  if (input.transaction == null) throw new MissingTransaction();
  if (input.context == null) throw new MissingContext();
  if (!Array.isArray(input.context.availableRules)) throw new MissingContext({ reason: 'availableRules must be an array' });
  if (!input.transaction.id || !input.transaction.companyId) throw new InvalidTransaction();

  const candidates = runPipeline(input);
  return { candidates, decision: undefined };
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
