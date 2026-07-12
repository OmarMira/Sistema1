import type { RuleInput, BankRule, EvaluatedCondition, Candidate, Transaction } from './types';
import { evaluateCondition } from './conditions/index';

function collectCandidates(input: RuleInput): BankRule[] {
  return input.context.availableRules.filter(
    (rule) =>
      rule.companyId === input.transaction.companyId &&
      (rule.lifecycleStatus === 'active' || rule.lifecycleStatus === 'testing'),
  );
}

function evaluateConditions(
  rules: BankRule[],
  transaction: Transaction,
): [BankRule, EvaluatedCondition[]][] {
  return rules.map((rule) => [
    rule,
    rule.conditions.map((condition) => evaluateCondition(condition, transaction)),
  ]);
}

function discardInvalid(
  entries: [BankRule, EvaluatedCondition[]][],
): [BankRule, EvaluatedCondition[]][] {
  return entries.filter(([, evals]) => evals.every((e) => e.match));
}

function produceCandidates(entries: [BankRule, EvaluatedCondition[]][]): Candidate[] {
  return entries.map(([rule, evals]) => ({
    ruleId: rule.id,
    specificity: 0,
    matchQuality: 0,
    confidence: 0,
    conditionScores: evals.map((e) => e.score),
    priority: rule.priority,
  }));
}

export function runPipeline(input: RuleInput): Candidate[] {
  const candidates = collectCandidates(input);
  const evaluated = evaluateConditions(candidates, input.transaction);
  const valid = discardInvalid(evaluated);
  return produceCandidates(valid);
}
