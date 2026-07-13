import type { RuleInput, RuleOutput } from './types';
import { isRuleEngineV2Enabled } from './flag';
import { runPipeline } from './pipeline';
import { scoreCandidates } from './scoring';
import { rankCandidates } from './ranking';
import { makeDecision } from './decision';
import { MissingTransaction, MissingContext, InvalidTransaction } from './errors';

function discardInvalidConfiguration(availableRules: RuleInput['context']['availableRules']): RuleInput['context']['availableRules'] {
  return availableRules.filter((rule) => rule.conditions && rule.conditions.length > 0);
}

export function evaluateRules(input: RuleInput): RuleOutput {
  if (!isRuleEngineV2Enabled()) {
    return { candidates: [], decision: undefined };
  }

  if (input.transaction == null) throw new MissingTransaction();
  if (input.context == null) throw new MissingContext();
  if (!Array.isArray(input.context.availableRules)) throw new MissingContext({ reason: 'availableRules must be an array' });
  if (!input.transaction.id || !input.transaction.companyId) throw new InvalidTransaction();

  const validatedRules = discardInvalidConfiguration(input.context.availableRules);
  const inputWithValidated = { ...input, context: { ...input.context, availableRules: validatedRules } };
  const artifacts = runPipeline(inputWithValidated);
  const scored = scoreCandidates(artifacts);
  const ranked = rankCandidates(scored);
  const decision = makeDecision(ranked);

  return { candidates: decision.candidateList, decision };
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
  EngineDecision,
  DecisionType,
  DecisionResult,
  EntityResolution,
  EntityResolutionStatus,
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
  MissingEntityIdError,
  UnknownConditionTypeError,
  InvalidPipelineStateError,
} from './errors';
