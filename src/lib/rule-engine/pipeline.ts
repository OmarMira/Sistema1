import type { RuleInput, BankRule, EvaluatedCondition, PipelineArtifacts, Transaction, EntityResolution, TraceEvent } from './types';
import { evaluateCondition } from './conditions/index';
import { attachTraceToError } from './trace';

function collectCandidates(input: RuleInput): BankRule[] {
  return input.context.availableRules.filter(
    (rule) =>
      rule.isActive &&
      rule.companyId === input.transaction.companyId &&
      (rule.lifecycleStatus === 'active' || rule.lifecycleStatus === 'testing'),
  );
}

function evaluateConditions(
  rules: BankRule[],
  transaction: Transaction,
  entityResolution: EntityResolution,
): [BankRule, EvaluatedCondition[]][] {
  return rules.map((rule) => [
    rule,
    rule.conditions.map((condition) => evaluateCondition(condition, transaction, { entityResolution })),
  ]);
}

function discardInvalid(
  entries: [BankRule, EvaluatedCondition[]][],
): [BankRule, EvaluatedCondition[]][] {
  return entries.filter(([, evals]) => evals.every((e) => e.match));
}

function produceCandidates(entries: [BankRule, EvaluatedCondition[]][]): PipelineArtifacts {
  const rawCandidates = entries.map(([rule, evals]) => ({
    ruleId: rule.id,
    conditionScores: evals.map((e) => e.score),
    priority: rule.priority,
    action: { ...rule.action },
  }));
  const evaluations = new Map(entries.map(([rule, evals]) => [rule.id, evals]));
  return { rawCandidates, evaluations };
}

export function runPipeline(input: RuleInput): [PipelineArtifacts, TraceEvent[]] {
  const events: TraceEvent[] = [];
  try {
    const candidates = collectCandidates(input);
    events.push({ stage: 'pipeline', event: 'candidates_collected', count: candidates.length });

    const evaluated = evaluateConditions(candidates, input.transaction, input.context.entityResolution);
    for (const [rule, evals] of evaluated) {
      for (const e of evals) {
        events.push({
          stage: 'pipeline',
          event: 'condition_evaluated',
          ruleId: rule.id,
          conditionType: e.type,
          score: e.score,
          matched: e.match,
        });
      }
    }

    const valid = discardInvalid(evaluated);
    const validIds = new Set(valid.map(([r]) => r.id));
    for (const [rule] of evaluated) {
      if (validIds.has(rule.id)) {
        events.push({ stage: 'pipeline', event: 'candidate_valid', ruleId: rule.id, conditionCount: rule.conditions.length });
      } else {
        events.push({ stage: 'pipeline', event: 'candidate_discarded', ruleId: rule.id });
      }
    }

    return [produceCandidates(valid), events];
  } catch (err) {
    attachTraceToError(err, events);
    throw err;
  }
}
