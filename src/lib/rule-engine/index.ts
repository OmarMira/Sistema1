import type { RuleInput, RuleEngineExecution, TraceEvent } from './types';
import { isRuleEngineV2Enabled } from './flag';
import { runPipeline } from './pipeline';
import { scoreCandidates } from './scoring';
import { rankCandidates } from './ranking';
import { makeDecision } from './decision';
import { MissingTransaction, MissingContext, InvalidTransaction, RuleEngineError } from './errors';
import { buildDecisionTrace, cloneDecisionTrace } from './trace';
import { RULE_ENGINE_VERSION } from './version';

function discardInvalidConfiguration(availableRules: RuleInput['context']['availableRules']): RuleInput['context']['availableRules'] {
  return availableRules.filter((rule) => rule.conditions && rule.conditions.length > 0);
}

export function evaluateRules(input: RuleInput): RuleEngineExecution {
  if (!isRuleEngineV2Enabled()) {
    return { output: { candidates: [], decision: undefined } };
  }

  if (input.transaction == null) throw new MissingTransaction();
  if (input.context == null) throw new MissingContext();
  if (!Array.isArray(input.context.availableRules)) throw new MissingContext({ reason: 'availableRules must be an array' });
  if (!input.transaction.id || !input.transaction.companyId) throw new InvalidTransaction();

  const validatedRules = discardInvalidConfiguration(input.context.availableRules);
  const inputWithValidated = { ...input, context: { ...input.context, availableRules: validatedRules } };

  const accumulated: TraceEvent[] = [];

  try {
    const [artifacts, pipelineEvents] = runPipeline(inputWithValidated);
    accumulated.push(...pipelineEvents);

    const [scored, scoringEvents] = scoreCandidates(artifacts);
    accumulated.push(...scoringEvents);

    const [ranked, rankingEvents] = rankCandidates(scored);
    accumulated.push(...rankingEvents);

    const [decision, decisionEvents] = makeDecision(ranked);
    accumulated.push(...decisionEvents);

    const trace = buildDecisionTrace(accumulated, { stage: 'execution', event: 'complete' });

    const audit = {
      engineVersion: RULE_ENGINE_VERSION,
      transactionId: input.transaction.id,
      companyId: input.transaction.companyId,
      result: decision.result,
      winnerRuleId: decision.ruleId,
      candidateCount: decision.candidateList.length,
      trace: cloneDecisionTrace(trace),
    };

    return { output: { candidates: decision.candidateList, decision }, trace, audit };
  } catch (err) {
    const stageEvents: TraceEvent[] = (err as any).__ruleEngineEvents ?? [];
    const errorCode = err instanceof RuleEngineError ? err.code : undefined;
    const terminalEvent: TraceEvent = errorCode !== undefined
      ? { stage: 'execution', event: 'error', errorCode }
      : { stage: 'execution', event: 'error' };

    const trace = buildDecisionTrace([...accumulated, ...stageEvents], terminalEvent);

    if (err instanceof RuleEngineError) {
      err.trace = trace;
    } else if (typeof err === 'object' && err !== null && Object.isExtensible(err)) {
      Object.defineProperty(err, 'trace', { value: trace, enumerable: true, configurable: true });
    }

    throw err;
  }
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
  DecisionReason,
  TraceEvent,
  DecisionTrace,
  AuditRecord,
  RuleEngineExecution,
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
