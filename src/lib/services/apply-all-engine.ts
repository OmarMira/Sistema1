import { db } from '@/lib/db';
import {
  loadEntityFirstContext,
  transactionMatchesRule,
  evaluateWinningRule,
  loadRolePriorities,
  type Transaction,
  type Rule,
  type MatchingRule,
} from '@/lib/services/rule-matching-engine';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

// ─── Constants ──────────────────────────────────────────────
// Task 4.1: Replace the old MAX_SAFETY = 5000 with MAX_PER_BATCH = 200
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

// ─── matchTransactions — Read-only matching ────────────────
// Task 1.1: Extract the read-only matching logic from route.ts into a pure function.
// Both POST and preview endpoints call this.

export async function matchTransactions(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchResult> {
  // Load entity-first context for SOCIO conflict detection
  const efCtx = await loadEntityFirstContext(companyId);

  // Get all active rules sorted by priority
  const rules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { priority: 'asc' },
  });

  // Task 4.3: Early return if no active rules
  if (rules.length === 0) {
    return {
      matchedRules: [],
      transactions: [],
      totalAmount: 0,
      totalCount: 0,
      remaining: 0,
    };
  }

  // Read company's maxApplyTransactions cap
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { maxApplyTransactions: true },
  });

  // Task 4.2: Compute effective cap
  // MIN(company?.maxApplyTransactions ?? MAX_PER_BATCH, MAX_PER_BATCH)
  // 0 is a valid cap (apply nothing) — must be distinguished from null/undefined
  const effectiveCap = company?.maxApplyTransactions !== null && company?.maxApplyTransactions !== undefined
    ? Math.min(company.maxApplyTransactions, MAX_PER_BATCH)
    : MAX_PER_BATCH;

  // Get all unmatched transactions for this company
  const companyStatements = await db.bankStatement.findMany({
    where: { companyId },
    select: { id: true },
  });
  const statementIds = companyStatements.map((s) => s.id);

  let unmatchedTransactions = await db.bankTransaction.findMany({
    where: eligibleForClassificationWhere({
      statementId: { in: statementIds },
    }),
  });

  const totalUnmatched = unmatchedTransactions.length;
  let remaining = 0;

  // Apply cap
  if (unmatchedTransactions.length > effectiveCap) {
    unmatchedTransactions = unmatchedTransactions.slice(0, effectiveCap);
    remaining = totalUnmatched - effectiveCap;
  }

  // Run rule matching loop (extracted from route.ts lines 89-123)
  const winnerMap = new Map<string, { ruleId: string; ruleName: string; txIds: string[] }>();
  const rolePriorities = await loadRolePriorities();
  const entityContexts = await db.entityContext.findMany({
    where: { companyId },
    select: { pattern: true, role: true },
  });

  for (const tx of unmatchedTransactions) {
    const matchingRules = rules.filter((rule) =>
      transactionMatchesRule(
        tx as Transaction,
        rule as Rule,
        efCtx.knownSocioPatterns,
        efCtx.entityFirstMode,
      ),
    ) as MatchingRule[];

    if (matchingRules.length === 0) continue;

    const winner = evaluateWinningRule(
      matchingRules,
      tx as Transaction,
      companyId,
      rolePriorities,
      entityContexts,
    );
    const existing = winnerMap.get(winner.id);
    if (existing) {
      existing.txIds.push(tx.id);
    } else {
      winnerMap.set(winner.id, { ruleId: winner.id, ruleName: winner.name, txIds: [tx.id] });
    }
  }

  // Build structured result
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
}

// ─── executeApplyAll — All mutations inside a transaction ──
// Task 1.2: Takes a Prisma transaction client `tx` and performs ALL mutations.
// Called INSIDE db.$transaction() — does NOT call $transaction itself.

export async function executeApplyAll(
  companyId: string,
  tx: any,
  matchResult: MatchResult,
): Promise<ApplyResult> {
  let appliedCount = 0;
  const allCandidateIds: string[] = [];
  const rulesMap = new Map<string, { debitGlAccountId?: string | null; creditGlAccountId?: string | null; glAccountId?: string | null }>();

  // Load the full rule data for GL account mapping
  const dbRules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    select: { id: true, debitGlAccountId: true, creditGlAccountId: true, glAccountId: true },
  });
  for (const r of dbRules) {
    rulesMap.set(r.id, r);
  }

  // TOCTOU mitigation: verify transactions are still unmatched inside the tx
  // before applying. This prevents double-matching when concurrent requests race.
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

    // Split into debits (amount < 0) and credits (amount >= 0)
    const debitIds: string[] = [];
    const creditIds: string[] = [];

    for (const txId of txIds) {
      // Skip transactions that were already matched by another request
      if (!unmatchedSet.has(txId)) continue;
      const tx = matchResult.transactions.find((t) => t.id === txId);
      if (!tx) continue;
      if (tx.amount < 0) debitIds.push(txId);
      else creditIds.push(txId);
    }

    // Sort IDs ascending within each group (deadlock mitigation)
    debitIds.sort();
    creditIds.sort();

    // Process debits first, then credits (consistent lock order)
    // TOCTOU defense: batch updateMany re-evaluates the invariant filter
    // at UPDATE time via the WHERE clause. Protected transactions are
    // silently excluded — result.count reflects only real updates.
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

  // Re-fetch candidate transactions that now have a GL account, for
  // downstream journal entry processing. This query does NOT identify which
  // rows were updated by this operation — it may include transactions that
  // obtained glAccountId from another concurrent process between our SELECT
  // and UPDATE (see Race Analysis below).
  const matchedTxs = await tx.bankTransaction.findMany({
    where: { id: { in: allCandidateIds }, glAccountId: { not: null }, journalEntryId: null },
    select: { id: true, date: true, amount: true, description: true, glAccountId: true, statementId: true },
  });

  // Load statement → bankAccount → bankGL mapping (using tx client)
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

  // Create journal entries (inside the same transaction)
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
