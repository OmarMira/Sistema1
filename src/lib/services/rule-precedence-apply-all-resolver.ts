import {
  applyAllAdapter,
  type ApplyAllRuleResolution,
  type AdapterRule,
} from './rule-precedence-adapters';
import {
  isRuleEngineAdapterEnabled,
} from '@/lib/rule-engine/flag';
import { evaluateTransactionAgainstRules } from './rule-precedence-engine';
import { toRulePrecedenceRule } from './rule-precedence-shadow';
import {
  transactionMatchesRule,
  evaluateWinningRule,
  type Transaction,
  type Rule,
  type MatchingRule,
  type EntityContext,
} from './rule-matching-engine';
import type { RuleRecord } from './rule-precedence-import-resolver';

export interface ResolveApplyAllParams {
  id: string;
  date: Date;
  description: string;
  amount: number;
  bankAccountId?: string;
  reference?: string;
}

export interface LegacyRuleContext {
  knownSocioPatterns: string[];
  entityFirstMode: boolean;
  rolePriorities: Record<string, number>;
  entityContexts: EntityContext[];
}

async function resolveWithAdapter(
  txData: ResolveApplyAllParams,
  rules: RuleRecord[],
): Promise<ApplyAllRuleResolution> {
  if (!txData.bankAccountId) {
    return { matchedRuleId: null, resolvedRule: null };
  }
  const canonicalRules = rules.map((r) => toRulePrecedenceRule(r));
  const match = await evaluateTransactionAgainstRules(
    {
      id: txData.id,
      date: txData.date,
      description: txData.description,
      amount: txData.amount,
      bankAccountId: txData.bankAccountId,
    },
    canonicalRules,
  );
  return applyAllAdapter(match, canonicalRules);
}

function resolveWithLegacy(
  txData: ResolveApplyAllParams,
  rules: RuleRecord[],
  companyId: string,
  legacyCtx: LegacyRuleContext,
): ApplyAllRuleResolution {
  const tx: Transaction = { description: txData.description, amount: txData.amount };

  const matchingRules: MatchingRule[] = rules
    .filter((rule) => {
      const ruleForMatch: Rule = {
        conditionType: rule.conditionType,
        conditionValue: rule.conditionValue,
        transactionDirection: rule.transactionDirection,
      };
      return transactionMatchesRule(tx, ruleForMatch, legacyCtx.knownSocioPatterns, legacyCtx.entityFirstMode);
    })
    .map((rule): MatchingRule => ({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      conditionType: rule.conditionType,
      conditionValue: rule.conditionValue,
      transactionDirection: rule.transactionDirection,
      glAccountId: rule.glAccountId,
      debitGlAccountId: rule.debitGlAccountId,
      creditGlAccountId: rule.creditGlAccountId,
    }));

  if (matchingRules.length === 0) {
    return { matchedRuleId: null, resolvedRule: null };
  }

  const winner = evaluateWinningRule(
    matchingRules,
    tx,
    companyId,
    legacyCtx.rolePriorities,
    legacyCtx.entityContexts,
  );

  return {
    matchedRuleId: winner.id,
    resolvedRule: {
      id: winner.id,
      name: winner.name,
      priority: winner.priority,
      glAccountId: winner.glAccountId ?? null,
      debitGlAccountId: winner.debitGlAccountId ?? null,
      creditGlAccountId: winner.creditGlAccountId ?? null,
    },
  };
}

export async function resolveApplyAllRule(
  txData: ResolveApplyAllParams,
  bankRules: RuleRecord[],
  companyId: string,
  legacyCtx: LegacyRuleContext,
): Promise<ApplyAllRuleResolution> {
  if (isRuleEngineAdapterEnabled()) {
    return resolveWithAdapter(txData, bankRules);
  }
  return resolveWithLegacy(txData, bankRules, companyId, legacyCtx);
}
