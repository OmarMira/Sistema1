import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

// ─── Pending human-decision guard (E2E Decision-Learning Loop §6) ──────
//
// Same contract as the Apply-All guard (§2): a BankTransaction governed by an
// ACTIVE human decision must never be classified by single-rule apply. The
// governing decision is a PendingApproval row with
// action='ai_classification_proposal' and status='pending'; it references the
// transaction through payload.transactionId, whose real value is
// BankTransaction.importHash (documented in ai-proposal-approval.service).
// Resolved approvals (accepted/corrected/rejected/...) never exclude — only
// the still-pending decision does.

const PENDING_HUMAN_DECISION_ACTION = 'ai_classification_proposal';
const PENDING_HUMAN_DECISION_STATUS = 'pending';

async function loadPendingHumanDecisionImportHashes(
  executor: Pick<typeof db, 'pendingApproval'>,
): Promise<string[]> {
  const rows = await executor.pendingApproval.findMany({
    where: {
      action: PENDING_HUMAN_DECISION_ACTION,
      status: PENDING_HUMAN_DECISION_STATUS,
    },
    select: { payload: true },
  });

  const hashes: string[] = [];
  for (const row of rows) {
    const txId = (row.payload as { transactionId?: unknown } | null)?.transactionId;
    if (typeof txId === 'string' && txId.length > 0) {
      hashes.push(txId);
    }
  }
  return hashes;
}

function withoutPendingHumanDecision(
  pendingImportHashes: string[],
): Prisma.BankTransactionWhereInput {
  if (pendingImportHashes.length === 0) return {};
  // importHash is nullable (NULL for non-imported rows) — those rows keep
  // flowing, so the NULL case is matched explicitly alongside notIn.
  return {
    OR: [{ importHash: null }, { importHash: { notIn: pendingImportHashes } }],
  };
}

/**
 * Match-time exclusion for the POST /api/bank-rules/[id] action=apply load:
 * a WhereInput fragment that keeps only transactions NOT governed by an
 * ACTIVE pending human decision (or by no decision at all).
 */
export async function excludePendingHumanDecisions(
  executor: Pick<typeof db, 'pendingApproval'>,
): Promise<Prisma.BankTransactionWhereInput> {
  return withoutPendingHumanDecision(
    await loadPendingHumanDecisionImportHashes(executor),
  );
}

export interface SingleRuleApplyInput {
  companyId: string;
  userId: string;
  rule: {
    id: string;
    name: string;
    glAccountId: string | null;
    debitGlAccountId: string | null;
    creditGlAccountId: string | null;
  };
  debitIds: string[];
  creditIds: string[];
}

export interface SingleRuleApplyResult {
  actualMatched: number;
  acquiredIds: string[];
  applyRecordId?: string;
}

/**
 * Executes the single-rule classification application in a transactional scope.
 *
 * Acquisition is the single source of truth: rows are claimed via
 * `updateManyAndReturn` and the RuleApplyRecord is created, linked, and linked
 * to journals ONLY for actually acquired rows. A concurrent loser that acquires
 * zero rows creates no durable record and cannot overwrite another apply's
 * ruleApplyRecordId.
 */
export async function executeSingleRuleClassificationApply(
  tx: any,
  input: SingleRuleApplyInput,
): Promise<SingleRuleApplyResult> {
  const { companyId, userId, rule, debitIds, creditIds } = input;
  let actualMatched = 0;
  const acquiredIds: string[] = [];

  // Write-time guard (§6): re-read ACTIVE human decisions inside THIS same
  // transaction before any write — a PendingApproval may have appeared after
  // the route's match-time load, so the candidate IDs can be stale.
  const pendingHumanDecision = withoutPendingHumanDecision(
    await loadPendingHumanDecisionImportHashes(tx),
  );

  if (debitIds.length > 0) {
    const debitAccountId = rule.debitGlAccountId || rule.glAccountId;
    const updatedRows = await tx.bankTransaction.updateManyAndReturn({
      where: {
        AND: [
          eligibleForClassificationWhere({ id: { in: debitIds } }),
          pendingHumanDecision,
        ],
      },
      data: { glAccountId: debitAccountId, matchedRuleId: rule.id },
      select: { id: true },
    });
    actualMatched += updatedRows.length;
    acquiredIds.push(...updatedRows.map((r: any) => r.id));
  }

  if (creditIds.length > 0) {
    const creditAccountId = rule.creditGlAccountId || rule.glAccountId;
    const updatedRows = await tx.bankTransaction.updateManyAndReturn({
      where: {
        AND: [
          eligibleForClassificationWhere({ id: { in: creditIds } }),
          pendingHumanDecision,
        ],
      },
      data: { glAccountId: creditAccountId, matchedRuleId: rule.id },
      select: { id: true },
    });
    actualMatched += updatedRows.length;
    acquiredIds.push(...updatedRows.map((r: any) => r.id));
  }

  let applyRecordId: string | undefined;

  // Only create RuleApplyRecord and link if we actually acquired rows!
  if (acquiredIds.length > 0) {
    const record = await tx.ruleApplyRecord.create({
      data: {
        companyId,
        origin: 'single-rule',
        ruleId: rule.id,
        userId,
        state: 'applied',
        idempotencyKey: crypto.randomUUID(),
      },
    });
    applyRecordId = record.id;

    await tx.bankTransaction.updateMany({
      where: { id: { in: acquiredIds } },
      data: { ruleApplyRecordId: record.id },
    });
  }

  await createAuditLogWithRetry(
    {
      companyId,
      userId,
      action: 'RULE_APPLIED',
      entity: 'BankRule',
      entityId: rule.id,
      details: JSON.stringify({ matchedCount: actualMatched, ruleName: rule.name }),
    },
    tx as any,
  );

  return {
    actualMatched,
    acquiredIds,
    applyRecordId,
  };
}