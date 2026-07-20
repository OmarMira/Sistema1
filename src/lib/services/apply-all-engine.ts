import crypto from 'crypto';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import {
  loadEntityFirstContext,
  loadRolePriorities,
} from '@/lib/services/rule-matching-engine';
import {
  resolveApplyAllRule,
  type LegacyRuleContext,
} from '@/lib/services/rule-precedence-apply-all-resolver';
import type { RuleRecord } from '@/lib/services/rule-precedence-import-resolver';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';
import {
  isRulePrecedenceShadowEnabled,
  toRulePrecedenceRule,
  runShadowComparison,
  createEmptyApplyAllShadowSummary,
  accumulateApplyAllShadowSummary,
  classifyDivergenceReason,
  toPersistencePayload,
  type ShadowExecutionSummary,
  type ShadowPersistencePayload,
  type ComparisonEvidence,
  type DivergenceClassification,
} from '@/lib/services/rule-precedence-shadow';
import type { RulePrecedenceRule, RulePrecedenceTransaction } from '@/lib/services/rule-precedence-engine';
import { isRuleEngineAdapterEnabled } from '@/lib/rule-engine/flag';

function toRuleRecord(rule: {
  id: string;
  name: string;
  companyId: string;
  priority: number;
  conditions: Prisma.JsonValue;
  conditionType: string;
  conditionValue: string;
  transactionDirection: string;
  glAccountId: string | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
  isActive: boolean;
}): RuleRecord {
  return {
    id: rule.id,
    name: rule.name,
    companyId: rule.companyId,
    priority: rule.priority,
    conditions: rule.conditions,
    conditionType: rule.conditionType,
    conditionValue: rule.conditionValue,
    transactionDirection: rule.transactionDirection,
    glAccountId: rule.glAccountId,
    debitGlAccountId: rule.debitGlAccountId,
    creditGlAccountId: rule.creditGlAccountId,
    isActive: rule.isActive,
  };
}

// ─── Constants ──────────────────────────────────────────────
const MAX_PER_BATCH = 200;

// ─── Types ──────────────────────────────────────────────────

export interface MatchResult {
  matchedRules: Array<{ rule: { id: string; name: string; priority: number | null }; txIds: string[] }>;
  transactions: Array<{ id: string; amount: number; description: string }>;
  totalAmount: number;
  totalCount: number;
  remaining: number;
}

export interface ApplyResult {
  appliedCount: number;
  journalEntryCount: number;
}

export interface MatchOptions {
  limit?: number;
}

// Internal — not exported
type MatchingMode =
  | { shadow: 'disabled' }
  | { shadow: 'collect' };

export interface ShadowCollectionResult {
  summary: ShadowPersistencePayload;
  batchId: string;
}

export type MatchTransactionsWithShadowResult =
  | {
      kind: 'without-shadow';
      matchResult: MatchResult;
    }
  | {
      kind: 'with-shadow';
      matchResult: MatchResult;
      shadow: ShadowCollectionResult;
    };

interface ExecuteMatchingResult {
  matchResult: MatchResult;
  shadowSummary?: ShadowExecutionSummary;
}

async function executeMatching(
  companyId: string,
  mode: MatchingMode,
  options?: MatchOptions,
): Promise<ExecuteMatchingResult> {
  const efCtx = await loadEntityFirstContext(companyId);

  const rules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { priority: 'asc' },
  });

  if (rules.length === 0) {
    return {
      matchResult: {
        matchedRules: [],
        transactions: [],
        totalAmount: 0,
        totalCount: 0,
        remaining: 0,
      },
    };
  }

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { maxApplyTransactions: true },
  });

  const effectiveCap = company?.maxApplyTransactions !== null && company?.maxApplyTransactions !== undefined
    ? Math.min(company.maxApplyTransactions, MAX_PER_BATCH)
    : MAX_PER_BATCH;

  const companyStatements = await db.bankStatement.findMany({
    where: { companyId },
    select: { id: true, bankAccountId: true },
  });
  const statementIds = companyStatements.map((s) => s.id);
  const bankAccountByStatement = new Map(
    companyStatements.map((s) => [s.id, s.bankAccountId]),
  );

  let unmatchedTransactions = await db.bankTransaction.findMany({
    where: eligibleForClassificationWhere({
      statementId: { in: statementIds },
    }),
  });

  const totalUnmatched = unmatchedTransactions.length;
  let remaining = 0;

  if (unmatchedTransactions.length > effectiveCap) {
    unmatchedTransactions = unmatchedTransactions.slice(0, effectiveCap);
    remaining = totalUnmatched - effectiveCap;
  }

  const winnerMap = new Map<string, { ruleId: string; ruleName: string; txIds: string[] }>();
  const rolePriorities = await loadRolePriorities();
  const entityContexts = await db.entityContext.findMany({
    where: { companyId },
    select: { pattern: true, role: true },
  });
  const legacyCtx: LegacyRuleContext = {
    knownSocioPatterns: efCtx.knownSocioPatterns,
    entityFirstMode: efCtx.entityFirstMode,
    rolePriorities,
    entityContexts,
  };
  const ruleRecords = rules.map(toRuleRecord);

  const shadowEnabled = mode.shadow === 'collect'
    && isRulePrecedenceShadowEnabled()
    && !isRuleEngineAdapterEnabled();
  let shadowRules: RulePrecedenceRule[] | undefined;
  let shadowSummary: ShadowExecutionSummary | undefined;

  if (shadowEnabled) {
    shadowRules = rules.map(toRulePrecedenceRule);
    shadowSummary = createEmptyApplyAllShadowSummary();
  }

  for (const tx of unmatchedTransactions) {
    const resolution = await resolveApplyAllRule(
      {
        id: tx.id,
        date: tx.date,
        description: tx.description,
        amount: Number(tx.amount),
        bankAccountId: bankAccountByStatement.get(tx.statementId),
      },
      ruleRecords,
      companyId,
      legacyCtx,
    );

    if (shadowEnabled && shadowRules && shadowSummary) {
      const txData: RulePrecedenceTransaction = {
        id: tx.id,
        date: tx.date,
        description: tx.description,
        amount: Number(tx.amount),
        bankAccountId: bankAccountByStatement.get(tx.statementId),
      };

      const shadowResult = runShadowComparison(txData, shadowRules, resolution.matchedRuleId, {
        companyId,
        transactionId: tx.id,
      });

      let classification: DivergenceClassification | undefined;

      if (shadowResult.ok) {
        const evidence: ComparisonEvidence = {
          productiveWinnerId: shadowResult.comparison.productiveWinnerId,
          canonicalWinnerId: shadowResult.comparison.canonicalWinnerId,
          canonicalReason: shadowResult.comparison.canonicalReason,
        };

        classification = classifyDivergenceReason(evidence);
      }

      shadowSummary = accumulateApplyAllShadowSummary(shadowSummary, shadowResult, classification);
    }

    if (!resolution.resolvedRule) continue;

    const existing = winnerMap.get(resolution.resolvedRule.id);
    if (existing) {
      existing.txIds.push(tx.id);
    } else {
      winnerMap.set(resolution.resolvedRule.id, {
        ruleId: resolution.resolvedRule.id,
        ruleName: resolution.resolvedRule.name,
        txIds: [tx.id],
      });
    }
  }

  const matchResult: MatchResult = (() => {
    const matchedRules = Array.from(winnerMap.entries()).map(([ruleId, entry]) => {
      const rule = rules.find((r) => r.id === ruleId);
      return {
        rule: { id: ruleId, name: entry.ruleName, priority: rule?.priority ?? null },
        txIds: entry.txIds,
      };
    });

    const matchedTxIds = new Set(matchedRules.flatMap((r) => r.txIds));
    const matchedTransactions = unmatchedTransactions.filter((tx) => matchedTxIds.has(tx.id));

    const totalAmount = matchedTransactions.reduce((sum, tx) => sum + Number(tx.amount), 0);
    const totalCount = matchedTransactions.length;

    return {
      matchedRules,
      transactions: matchedTransactions.map((tx) => ({
        id: tx.id,
        amount: Number(tx.amount),
        description: tx.description,
      })),
      totalAmount,
      totalCount,
      remaining,
    };
  })();

  return {
    matchResult,
    shadowSummary: shadowEnabled ? shadowSummary : undefined,
  };
}

// ─── matchTransactions — Read-only matching ────────────────

export async function matchTransactions(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchResult> {
  const { matchResult } = await executeMatching(companyId, { shadow: 'disabled' }, options);
  return matchResult;
}

// ─── matchTransactionsWithShadow — Matching + shadow collection ──

export async function matchTransactionsWithShadow(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchTransactionsWithShadowResult> {
  const { matchResult, shadowSummary } = await executeMatching(
    companyId, { shadow: 'collect' }, options,
  );

  if (!shadowSummary) {
    return { kind: 'without-shadow', matchResult };
  }

  return {
    kind: 'with-shadow',
    matchResult,
    shadow: {
      batchId: `apply-all-${crypto.randomUUID()}`,
      summary: toPersistencePayload(shadowSummary),
    },
  };
}

// ─── executeApplyAll — All mutations inside a transaction ──

export async function executeApplyAll(
  companyId: string,
  tx: any,
  matchResult: MatchResult,
): Promise<ApplyResult> {
  let appliedCount = 0;
  const allCandidateIds: string[] = [];
  const rulesMap = new Map<string, { debitGlAccountId?: string | null; creditGlAccountId?: string | null; glAccountId?: string | null }>();

  const dbRules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    select: { id: true, debitGlAccountId: true, creditGlAccountId: true, glAccountId: true },
  });
  for (const r of dbRules) {
    rulesMap.set(r.id, r);
  }

  const allTxIds = matchResult.matchedRules.flatMap((r) => r.txIds);
  const stillUnmatched = await tx.bankTransaction.findMany({
    where: eligibleForClassificationWhere({
      id: { in: allTxIds },
    }),
    select: { id: true },
  });
  const unmatchedSet = new Set(stillUnmatched.map((t: any) => t.id));

  for (const { rule, txIds } of matchResult.matchedRules) {
    const ruleData = rulesMap.get(rule.id);
    if (!ruleData) continue;

    const debitGlAccountId = ruleData.debitGlAccountId || ruleData.glAccountId;
    const creditGlAccountId = ruleData.creditGlAccountId || ruleData.glAccountId;

    const debitIds: string[] = [];
    const creditIds: string[] = [];

    for (const txId of txIds) {
      if (!unmatchedSet.has(txId)) continue;
      const tx = matchResult.transactions.find((t) => t.id === txId);
      if (!tx) continue;
      if (tx.amount < 0) debitIds.push(txId);
      else creditIds.push(txId);
    }

    debitIds.sort();
    creditIds.sort();

    if (debitIds.length > 0) {
      const result = await tx.bankTransaction.updateMany({
        where: eligibleForClassificationWhere({ id: { in: debitIds } }),
        data: { glAccountId: debitGlAccountId, matchedRuleId: rule.id },
      });
      appliedCount += result.count;
      allCandidateIds.push(...debitIds);
    }

    if (creditIds.length > 0) {
      const result = await tx.bankTransaction.updateMany({
        where: eligibleForClassificationWhere({ id: { in: creditIds } }),
        data: { glAccountId: creditGlAccountId, matchedRuleId: rule.id },
      });
      appliedCount += result.count;
      allCandidateIds.push(...creditIds);
    }
  }

  const matchedTxs = await tx.bankTransaction.findMany({
    where: { id: { in: allCandidateIds }, glAccountId: { not: null }, journalEntryId: null },
    select: { id: true, date: true, amount: true, description: true, glAccountId: true, statementId: true },
  });

  const statementIds = [...new Set<string>(matchedTxs.map((t: any) => t.statementId))];
  const statements = await tx.bankStatement.findMany({
    where: { id: { in: statementIds } },
    select: { id: true, bankAccountId: true },
  });
  const bankAccountIds = [...new Set<string>(statements.map((s: any) => s.bankAccountId))];
  const bankAccounts = await tx.bankAccount.findMany({
    where: { id: { in: bankAccountIds } },
    select: { id: true, glAccountId: true },
  });

  const bankGlByStatement = new Map<string, string>();
  for (const st of statements) {
    const ba = bankAccounts.find((b: any) => b.id === st.bankAccountId);
    if (ba) bankGlByStatement.set(st.id, ba.glAccountId);
  }

  let journalEntryCount = 0;
  for (const bt of matchedTxs) {
    const bankGl = bankGlByStatement.get(bt.statementId);
    if (!bankGl || !bt.glAccountId) continue;

    const entryId = await JournalEntryService.createFromBankTransaction(tx, {
      bankTxId: bt.id,
      bankTxDate: bt.date,
      bankTxAmount: Number(bt.amount),
      bankTxDescription: bt.description,
      bankGlAccountId: bankGl,
      counterpartyGlAccountId: bt.glAccountId,
      companyId,
    });

    if (entryId) journalEntryCount++;
  }

  return {
    appliedCount,
    journalEntryCount,
  };
}