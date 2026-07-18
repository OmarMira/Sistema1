import type { Prisma } from '@prisma/client';
import {
  importAdapter,
  type ImportRuleResolution,
} from './rule-precedence-adapters';
import {
  isRuleEngineAdapterEnabled,
  isRuleEngineV2Enabled,
} from '@/lib/rule-engine/flag';
import { evaluateTransactionAgainstRules } from './rule-precedence-engine';
import { toRulePrecedenceRule } from './rule-precedence-shadow';
import { runRuleEngineV2 } from '@/lib/services/rule-engine-adapter';
import type {
  ParsedTransaction,
  PrismaBankRule,
} from '@/lib/services/rule-engine-adapter';
import {
  findMatchingRule,
  type Transaction,
  type MatchingRule,
} from './rule-matching-engine';
import { logger } from '@/lib/logger';

export type { ImportRuleResolution } from './rule-precedence-adapters';

export interface ResolveImportRuleParams {
  id: string;
  date: Date;
  description: string;
  amount: number;
  bankAccountId: string;
  reference?: string;
}

export interface RuleRecord {
  id: string;
  name: string;
  companyId: string;
  priority: number;
  conditions: Prisma.JsonValue;
  conditionType: string | null;
  conditionValue: string | null;
  transactionDirection: string | null;
  glAccountId: string | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
  isActive: boolean;
}

async function resolveWithAdapter(
  txData: ResolveImportRuleParams,
  rules: RuleRecord[],
): Promise<ImportRuleResolution> {
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
  return importAdapter(match, canonicalRules);
}

async function resolveWithV2(
  txData: ResolveImportRuleParams,
  rules: RuleRecord[],
  companyId: string,
): Promise<ImportRuleResolution> {
  const v2txn: ParsedTransaction = {
    id: txData.id,
    date: txData.date,
    description: txData.description,
    amount: txData.amount,
    bankAccountId: txData.bankAccountId,
    reference: txData.reference,
  };
  const result = await runRuleEngineV2(
    v2txn,
    rules as PrismaBankRule[],
    { status: 'not_run' },
    companyId,
  );

  if (result.outcome === 'matched') {
    return {
      matchedRuleId: result.matchedRuleId,
      glAccountId: result.classification.glAccountId,
    };
  }

  if (result.outcome === 'pending' && result.errorCode) {
    logger.warn('Rule Engine v2 import evaluation failed', {
      errorCode: result.errorCode,
      companyId,
      bankAccountId: txData.bankAccountId,
      transactionId: txData.id,
    });
  }

  return { matchedRuleId: null, glAccountId: null };
}

async function resolveWithLegacy(
  txData: ResolveImportRuleParams,
  rules: RuleRecord[],
  companyId: string,
): Promise<ImportRuleResolution> {
  const result = await findMatchingRule(
    { description: txData.description, amount: txData.amount } as Transaction,
    rules as unknown as MatchingRule[],
    companyId,
  );
  return {
    matchedRuleId: result.matchedRuleId,
    glAccountId: result.glAccountId,
  };
}

export async function resolveImportRule(
  txData: ResolveImportRuleParams,
  bankRules: RuleRecord[],
  companyId: string,
): Promise<ImportRuleResolution> {
  if (isRuleEngineAdapterEnabled()) {
    return resolveWithAdapter(txData, bankRules);
  }
  if (isRuleEngineV2Enabled()) {
    return resolveWithV2(txData, bankRules, companyId);
  }
  return resolveWithLegacy(txData, bankRules, companyId);
}
