import { evaluateRules, evaluateRulesPure } from '@/lib/rule-engine'
import type { RuleInput, BankRule, RuleEngineExecution, EntityResolution, RuleCondition } from '@/lib/rule-engine/types'
import { normalize, NormalizationError } from './conditions-normalizer'
import type { MatchResult, ParsedTransaction, PrismaBankRule } from './types'

function buildEngineRule(rule: PrismaBankRule): BankRule {
  let conditions: RuleCondition[];
  try {
    conditions = normalize(rule.conditions);
  } catch {
    // Decision #2 — legacy-column fallback: when `conditions` is not usable,
    // normalize conditionType/conditionValue to the canonical model.
    if (rule.conditionType && rule.conditionValue != null) {
      const field =
        rule.conditionType === 'amount_greater' || rule.conditionType === 'amount_less'
          ? 'amount'
          : 'description';
      conditions = normalize([{ field, operator: rule.conditionType, value: rule.conditionValue }]);
    } else {
      // Fail closed: never mis-evaluate a rule with no usable representation.
      throw new NormalizationError('No usable conditions or legacy columns');
    }
  }
  const direction = rule.transactionDirection === 'debit' || rule.transactionDirection === 'credit'
    ? rule.transactionDirection
    : undefined

  return {
    id: rule.id,
    companyId: rule.companyId,
    priority: rule.priority,
    conditions,
    direction,
    action: {
      glAccountId: rule.glAccountId ?? rule.debitGlAccountId ?? rule.creditGlAccountId ?? undefined,
    },
    isActive: rule.isActive,
    lifecycleStatus: rule.isActive ? 'active' : 'archived',
  }
}

function mapDecisionToResult(execution: RuleEngineExecution): MatchResult {
  const { decision } = execution.output

  if (!decision) {
    return { outcome: 'pending' }
  }

  if (decision.result === 'winner') {
    if (decision.classification?.glAccountId && decision.ruleId) {
      return {
        outcome: 'matched',
        classification: {
          glAccountId: decision.classification.glAccountId,
          entityId: decision.classification.entityId,
          category: decision.classification.category,
        },
        matchedRuleId: decision.ruleId,
      }
    }

    return {
      outcome: 'pending',
      classification: decision.classification,
    }
  }

  return {
    outcome: 'pending',
    classification: decision.classification,
  }
}

export interface RunRuleEngineV2Options {
  persistAudit?: boolean;
}

function buildRuleInput(
  txn: ParsedTransaction,
  bankRules: PrismaBankRule[],
  entityResolution: EntityResolution,
  companyId: string,
): RuleInput {
  const activeRules = bankRules.filter((r) => r.isActive)
  const engineRules: BankRule[] = activeRules.map(buildEngineRule)

  return {
    transaction: {
      id: txn.id,
      date: txn.date,
      description: txn.description,
      amount: txn.amount,
      bankAccountId: txn.bankAccountId,
      companyId,
    },
    context: {
      availableRules: engineRules,
      entityContexts: [],
      historicalMatches: [],
      entityResolution,
    },
  }
}

export async function runRuleEngineV2(
  txn: ParsedTransaction,
  bankRules: PrismaBankRule[],
  entityResolution: EntityResolution,
  companyId: string,
  opts?: RunRuleEngineV2Options,
): Promise<MatchResult> {
  try {
    const execution = evaluateRules(buildRuleInput(txn, bankRules, entityResolution, companyId), opts)
    return mapDecisionToResult(execution)
  } catch (error) {
    if (error instanceof NormalizationError) {
      return { outcome: 'pending', errorCode: 'conditions_normalization_failed' }
    }
    return { outcome: 'pending', errorCode: 'engine_execution_error' }
  }
}

export function runRuleEngineV2Shadow(
  txn: ParsedTransaction,
  bankRules: PrismaBankRule[],
  entityResolution: EntityResolution,
  companyId: string,
): MatchResult {
  try {
    const execution = evaluateRulesPure(buildRuleInput(txn, bankRules, entityResolution, companyId))
    return mapDecisionToResult(execution)
  } catch (error) {
    if (error instanceof NormalizationError) {
      return { outcome: 'pending', errorCode: 'conditions_normalization_failed' }
    }
    return { outcome: 'pending', errorCode: 'engine_execution_error' }
  }
}

export type { ParsedTransaction, PrismaBankRule, MatchResult } from './types'
