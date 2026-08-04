import { db } from '@/lib/db';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { createAuditLogWithRetry } from '@/lib/audit';
import { NotFoundError } from '@/lib/api-error';

export interface RevertApplyResult {
  status: 'reverted' | 'already-reverted';
}

/**
 * Reverts a covered rule application anchored by a durable RuleApplyRecord.
 *
 * Runs in a single atomic transaction: void generated journals, recalculate
 * the affected GL balances, unlink the affected BankTransactions, then flip
 * the record to `reverted` via a guarded compare-and-swap.
 *
 * - If the record state is not `applied`, the call is an idempotent no-op.
 * - If ANY affected transaction falls in a closed/locked fiscal period, the
 *   WHOLE revert aborts and nothing persists.
 * - The CAS `updateMany({ where: { id, state: 'applied' } })` is the concurrency
 *   arbiter: 0 rows means another transaction won, so this transaction rolls back.
 * - ruleApplyRecordId on transactions stays pointing to the reverted record
 *   until a new apply overwrites it.
 */
export async function revertApplyRecord(
  companyId: string,
  applicationId: string,
  userId: string,
): Promise<RevertApplyResult> {
  return db.$transaction(async (tx: any) => {
    const record = await tx.ruleApplyRecord.findUnique({
      where: { id: applicationId },
      include: {
        transactions: { select: { id: true, date: true } },
        journalEntries: {
          include: { lines: { select: { glAccountId: true } } },
        },
      },
    });

    if (!record || record.companyId !== companyId) {
      throw new NotFoundError('RuleApplyRecord not found for this company');
    }

    if (record.state !== 'applied') {
      return { status: 'already-reverted' as const };
    }

    const relatedTransactions = record.transactions;
    const relatedJournals = record.journalEntries;
    const bankTransactionIds = relatedTransactions.map((t: any) => t.id as string);
    const journalEntryIds = relatedJournals.map((j: any) => j.id as string);

    // Per-transaction-date fiscal guard. ANY locked period aborts the WHOLE revert.
    for (const bt of relatedTransactions) {
      const txDate = (bt as { date: Date }).date;
      await assertActiveFiscalPeriod(companyId, txDate, tx);
    }

    // Void generated journals and recalculate the affected GL balances.
    // Only journals that this operation actually flips from `posted` to `void`
    // drive a recalculation. A journal already `void` produces no new accounting
    // mutation and is neither re-updated nor recalculated — the rollback must
    // compensate the effects of this record, not act as general ledger repair.
    if (journalEntryIds.length > 0) {
      const affectedGlAccountIds = new Set<string>();
      for (const journal of relatedJournals) {
        const j = journal as { id: string; status: string };
        if (j.status === 'void') continue;
        await tx.journalEntry.update({
          where: { id: j.id },
          data: { status: 'void' },
        });
        const lines = (j as unknown as { lines: Array<{ glAccountId: string }> }).lines;
        for (const line of lines) {
          affectedGlAccountIds.add(line.glAccountId);
        }
      }
      for (const glAccountId of affectedGlAccountIds) {
        await JournalEntryService.recalculateBalance(tx, glAccountId);
      }
    }

    // Unlink classification and journal links. ruleApplyRecordId stays pointing
    // to this reverted record until a new apply overwrites it.
    if (bankTransactionIds.length > 0) {
      await tx.bankTransaction.updateMany({
        where: { id: { in: bankTransactionIds } },
        data: {
          glAccountId: null,
          matchedRuleId: null,
          journalEntryId: null,
          journalLineId: null,
        },
      });
    }

    // Guarded CAS finalize — the concurrency arbiter.
    const casResult = await tx.ruleApplyRecord.updateMany({
      where: { id: record.id, state: 'applied' },
      data: { state: 'reverted' },
    });
    if (casResult.count === 0) {
      throw new Error('Concurrent revert won: the record is no longer applied');
    }

    await createAuditLogWithRetry({
      companyId,
      userId,
      action: 'RULE_REVERTED',
      entity: 'RuleApplyRecord',
      entityId: record.id,
      details: JSON.stringify({
        ruleId: record.ruleId,
        origin: record.origin,
        appliedAt: record.appliedAt.toISOString(),
        transactionCount: bankTransactionIds.length,
        journalCount: journalEntryIds.length,
      }),
    }, tx);

    return { status: 'reverted' as const };
  });
}
