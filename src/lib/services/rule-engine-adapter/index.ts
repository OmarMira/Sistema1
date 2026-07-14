import { evaluateRules } from '@/lib/rule-engine'
import type { RuleInput, BankRule, RuleEngineExecution, EntityResolution } from '@/lib/rule-engine/types'
import { normalize, NormalizationError } from './conditions-normalizer'
import type { MatchResult, ParsedTransaction, PrismaBankRule } from './types'

function buildEngineRule(rule: PrismaBankRule): BankRule {
  const conditions = normalize(rule.conditions)

  return {
    id: rule.id,
    companyId: rule.companyId,
    priority: rule.priority,
    conditions,
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

export async function runRuleEngineV2(
  txn: ParsedTransaction,
  bankRules: PrismaBankRule[],
  entityResolution: EntityResolution,
  companyId: string,
): Promise<MatchResult> {
  try {
    const activeRules = bankRules.filter((r) => r.isActive)
    const engineRules: BankRule[] = activeRules.map(buildEngineRule)

    const input: RuleInput = {
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

    const execution = evaluateRules(input)
    return mapDecisionToResult(execution)
  } catch (error) {
    if (error instanceof NormalizationError) {
      return { outcome: 'pending', errorCode: 'conditions_normalization_failed' }
    }
    return { outcome: 'pending', errorCode: 'engine_execution_error' }
  }
}

export type { ParsedTransaction, PrismaBankRule, MatchResult } from './types'
