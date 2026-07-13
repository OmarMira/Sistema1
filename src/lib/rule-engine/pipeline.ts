import type { RuleInput, BankRule, EvaluatedCondition, PipelineArtifacts, Transaction, EntityResolution } from './types';
import { evaluateCondition } from './conditions/index';

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

export function runPipeline(input: RuleInput): PipelineArtifacts {
  const candidates = collectCandidates(input);
  const evaluated = evaluateConditions(candidates, input.transaction, input.context.entityResolution);
  const valid = discardInvalid(evaluated);
  return produceCandidates(valid);
}
