import { db } from '@/lib/db';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { logger } from '@/lib/logger';
import {
  createAdapter,
  learnEntityTreatment,
  recordClassificationObservation,
  detectConflictingPattern,
  evolveClassificationConfidence,
  degradeKnowledgeOnConflict,
  isKnowledgeImplicatedByPendingConflict,
  isConflictResolved,
} from '@/memory/classification-knowledge';
import { resolveEntity } from '@/memory/entity-resolution';
import { confirmEntityIdentity } from '@/internal/company-knowledge/entity/service';
import type { EntityType } from '@/internal/company-knowledge/entity/types';

// ─── S10 1B.2A — transaction reclassification authority ──────────
// Single server authority for: tenant-scoped lookup → GL validation →
// fiscal guard → journal void/repost → Knowledge Engine learning.
// Extracted verbatim from PATCH /api/transactions/[id]; that route is
// now a thin HTTP boundary over this function. Future consumers
// (e.g. ai_classification_proposal) invoke this directly — no HTTP
// hop, no duplicated domain sequence.
//
// Deliberately does NOT receive Request/Response, session, or actor:
// the certified PATCH logic never used them (userId was destructured
// but unused).

export type ReclassifyTransactionInput = {
  companyId: string;
  transactionId: string;
  glAccountId: string;
  confirmedEntity?: {
    canonicalName: string;
    entityType: EntityType;
  };
};

// ─── KE-EVOL-002 secondary confidence helpers ───────────────────
// Confidence is a SECONDARY KE operation after accounting success.
// Failures are logged with an explicit stage and never revert the
// already-committed accounting correction.

function logConfidenceFailure(
  stage: 'confidence_promotion' | 'confidence_degradation',
  context: {
    transactionId: string;
    companyId: string;
    entityId: string;
    error: string;
  },
  severity: 'warn' | 'error' = 'warn',
): void {
  const message = `[KE] Confidence ${stage === 'confidence_promotion' ? 'promotion' : 'degradation'} failed — accounting correction stands`;
  if (severity === 'error') {
    logger.error(message, {
      ...context,
      stage,
    });
  } else {
    logger.warn(message, {
      ...context,
      stage,
    });
  }
}

/** Promote the confirmed exact treatment to certain (human_confirmation). */
async function promoteConfirmedTreatment(
  itemId: string,
  transactionId: string,
  companyId: string,
  entityId: string,
): Promise<void> {
  // KE-EVOL-005 defect fix: a correction against an exact treatment that is
  // implicated by ANY pending conflict must NOT promote it to certain —
  // promoting would be silently re-degraded by the unresolved conflict in
  // the same request (promote→detect→degrade fight). The knowledge stays
  // uncertain until ALL pending conflicts implicating it are resolved and
  // an explicit human rehabilitation happens.
  const implicated = await isKnowledgeImplicatedByPendingConflict(
    createAdapter(db, (fn) => db.$transaction(fn)),
    companyId,
    itemId,
  );
  if (implicated.implicated) {
    logger.info('[KE] Promotion skipped — exact treatment implicated by pending conflict', {
      transactionId,
      companyId,
      entityId,
      itemId,
      stage: 'confidence_promotion',
    });
    return;
  }
  const result = await evolveClassificationConfidence(
    createAdapter(db, (fn) => db.$transaction(fn)),
    companyId,
    itemId,
    'certain',
    'human_confirmation',
  );
  if (result.status === 'ERROR') {
    logConfidenceFailure('confidence_promotion', {
      transactionId,
      companyId,
      entityId,
      error: result.error,
    });
  } else if (result.status === 'NOT_FOUND') {
    // Internal anomaly: the itemId comes from a successful learnEntityTreatment
    // in the same request, so a missing item means knowledge-state corruption.
    // Observable at error severity; the accounting transaction stands and the
    // HTTP response contract is unchanged (no throw, no retry, no rollback).
    logConfidenceFailure(
      'confidence_promotion',
      {
        transactionId,
        companyId,
        entityId,
        error: 'item_not_found',
      },
      'error',
    );
  }
}

/** Degrade knowledge questioned by a persisted deterministic conflict. */
async function degradeOnPersistedConflict(
  conflictId: string,
  transactionId: string,
  companyId: string,
  entityId: string,
): Promise<void> {
  // KE-EVOL-005 defect fix: when detection returns ALREADY_RECORDED for a
  // conflict that has ALREADY been explicitly resolved by a human, the
  // same-identity re-detection must NOT re-degrade the knowledge — a
  // resolved conflict is no longer active evidence (post-resolution
  // re-degrade fight). A GENUINELY NEW post-resolution conflict (its own
  // new conflictItemId, no resolution record) still degrades normally.
  let resolved = false;
  try {
    const resolvedCheck = await isConflictResolved(
      createAdapter(db, (fn) => db.$transaction(fn)),
      companyId,
      conflictId,
    );
    resolved = resolvedCheck.resolved;
  } catch (resolutionCheckError) {
    logger.warn('[KE] Conflict resolution check failed — degradation proceeds (conflict treated as pending)', {
      transactionId,
      companyId,
      entityId,
      conflictId,
      stage: 'conflict_resolution_check',
      error: resolutionCheckError instanceof Error ? resolutionCheckError.message : String(resolutionCheckError),
    });
  }
  if (resolved) {
    return;
  }
  const degrade = await degradeKnowledgeOnConflict(
    createAdapter(db, (fn) => db.$transaction(fn)),
    companyId,
    conflictId,
  );
  if (degrade.status === 'ERROR') {
    logConfidenceFailure('confidence_degradation', {
      transactionId,
      companyId,
      entityId,
      error: degrade.error,
    });
  }
}

/**
 * Reclassify a bank transaction to a final GL account: accounting first
 * (tenant-scoped), Knowledge Engine learning only after accounting
 * success. KE failures are logged and never revert the books.
 *
 * Semantics are byte-for-byte the ones certified in
 * PATCH /api/transactions/[id] before extraction — do not "improve"
 * KNOWN/UNKNOWN handling here; the route maps these domain results to
 * the original HTTP contract.
 */
export async function reclassifyTransaction(input: ReclassifyTransactionInput) {
  const { companyId, transactionId, glAccountId, confirmedEntity } = input;

  // Verify the transaction exists and belongs to the company
  const transaction = await db.bankTransaction.findFirst({
    where: { id: transactionId, statement: { bankAccount: { companyId } } },
    include: {
      statement: {
        select: {
          bankAccount: {
            select: { id: true, glAccountId: true },
          },
        },
      },
    },
  });

  if (!transaction) {
    return { status: 'TRANSACTION_NOT_FOUND' } as const;
  }

  // Verify the GL account exists and belongs to the company
  const glAccount = await db.glAccount.findFirst({
    where: { id: glAccountId, companyId, isActive: true },
  });
  if (!glAccount) {
    return { status: 'GL_ACCOUNT_NOT_FOUND' } as const;
  }

  const bankGlAccountId = transaction.statement.bankAccount.glAccountId;

  await assertActiveFiscalPeriod(companyId, transaction.date);

  const result = await db.$transaction(async (tx) => {
    // If transaction already has a journal entry, void it and unlink it first,
    // otherwise the previous posted entry keeps counting toward GL balances
    // and the new one double-counts the same economic event.
    if (transaction.journalEntryId) {
      const oldEntryLines = await tx.journalLine.findMany({
        where: { entryId: transaction.journalEntryId },
        select: { glAccountId: true },
      });
      await tx.journalEntry.update({
        where: { id: transaction.journalEntryId },
        data: { status: 'void' },
      });
      const affectedGlIds = [...new Set(oldEntryLines.map((l) => l.glAccountId))];
      for (const glId of affectedGlIds) {
        await JournalEntryService.recalculateBalance(tx as any, glId);
      }
      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: { journalEntryId: null },
      });
    }
    // Update the transaction with the new GL account
    const updated = await tx.bankTransaction.update({
      where: { id: transactionId },
      data: { glAccountId },
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        glAccountId: true,
        journalEntryId: true,
      },
    });

    // Create the journal entry if the bank account has a GL account linked
    if (bankGlAccountId) {
      const entryId = await JournalEntryService.createFromBankTransaction(tx as any, {
        bankTxId: updated.id,
        bankTxDate: updated.date,
        bankTxAmount: Number(updated.amount),
        bankTxDescription: updated.description,
        bankGlAccountId,
        counterpartyGlAccountId: glAccountId,
        companyId,
      });
      updated.journalEntryId = entryId;
    }

    return updated;
  });

  logger.info('Transaction GL account updated + journal entry created', {
    transactionId,
    glAccountId,
    journalEntryId: result.journalEntryId,
  });

  // ─── Knowledge Engine: learn from confirmed correction ─────────
  // Only after accounting persistence succeeds.
  // KE failure is logged but does NOT revert the accounting correction.
  // The caller receives no indication — the accounting result stands.
  try {
    if (confirmedEntity) {
      // User explicitly confirmed entity identity → persist it and learn treatment
      const entityResolution = await resolveEntity(companyId, transaction.description);

      if (entityResolution.status === 'UNKNOWN') {
        // UNKNOWN + user confirms → create CompanyKnowledge record
        const confirmed = await confirmEntityIdentity({
          companyId,
          canonicalName: confirmedEntity.canonicalName,
          observedAlias: transaction.description,
          entityType: confirmedEntity.entityType,
        });

        // Learn treatment with the confirmed entity
        const keResult = await learnEntityTreatment(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          confirmed.id,
          glAccountId,
          'any',
          'user_correction',
          transactionId,
        );

        if (keResult.status === 'ERROR') {
          logger.warn('[KE] Treatment learn failed after identity confirmation', {
            transactionId,
            companyId,
            entityId: confirmed.id,
            stage: 'entity_treatment_learning',
            error: keResult.reason,
          });
        } else {
          // KE-EVOL-002: user-confirmed correction is human authority over
          // THIS exact treatment → promote to certain via existing C11.
          await promoteConfirmedTreatment(keResult.itemId, transactionId, companyId, confirmed.id);
        }

        // Record observation (independent of treatment UNCHANGED/UPDATED)
        const obsResult = await recordClassificationObservation(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          {
            entityId: confirmed.id,
            originalDescription: transaction.description,
            glAccountId,
            direction: 'any',
            source: 'user_correction',
            transactionId,
          },
        );

        if (!obsResult.ok) {
          logger.warn('[KE] Observation record failed — treatment stands', {
            transactionId,
            companyId,
            entityId: confirmed.id,
            stage: 'observation_recording',
            error: obsResult.error,
          });
        }

        // KE-EVOL-001: detect conflict after observation
        const conflictResult = await detectConflictingPattern(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          confirmed.id,
          'any',
        );
        if (conflictResult.status === 'ERROR') {
          logger.warn('[KE] Conflict detection failed — observation stands', {
            transactionId,
            companyId,
            entityId: confirmed.id,
            stage: 'conflict_detection',
            error: conflictResult.error,
          });
        } else if (conflictResult.status === 'RECORDED' || conflictResult.status === 'ALREADY_RECORDED') {
          // KE-EVOL-002: persisted deterministic conflict degrades the
          // questioned knowledge via existing C11 infrastructure.
          await degradeOnPersistedConflict(conflictResult.conflictId, transactionId, companyId, confirmed.id);
        }
      } else if (entityResolution.status === 'KNOWN') {
        // Entity already known — just learn treatment
        const keResult = await learnEntityTreatment(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          entityResolution.entityId,
          glAccountId,
          'any',
          'user_correction',
          transactionId,
        );
        if (keResult.status === 'ERROR') {
          logger.warn('[KE] Learn failed — accounting correction stands', {
            transactionId,
            companyId,
            stage: 'entity_treatment_learning',
            error: keResult.reason,
          });
        } else {
          // KE-EVOL-002: user-confirmed correction promotes THIS exact
          // treatment to certain via existing C11.
          await promoteConfirmedTreatment(keResult.itemId, transactionId, companyId, entityResolution.entityId);
        }

        // Record observation (independent of treatment UNCHANGED/UPDATED)
        const obsResult = await recordClassificationObservation(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          {
            entityId: entityResolution.entityId,
            originalDescription: transaction.description,
            glAccountId,
            direction: 'any',
            source: 'user_correction',
            transactionId,
          },
        );

        if (!obsResult.ok) {
          logger.warn('[KE] Observation record failed — treatment stands', {
            transactionId,
            companyId,
            entityId: entityResolution.entityId,
            stage: 'observation_recording',
            error: obsResult.error,
          });
        }

        // KE-EVOL-001: detect conflict after observation
        const conflictResult = await detectConflictingPattern(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          entityResolution.entityId,
          'any',
        );
        if (conflictResult.status === 'ERROR') {
          logger.warn('[KE] Conflict detection failed — observation stands', {
            transactionId,
            companyId,
            entityId: entityResolution.entityId,
            stage: 'conflict_detection',
            error: conflictResult.error,
          });
        } else if (conflictResult.status === 'RECORDED' || conflictResult.status === 'ALREADY_RECORDED') {
          // KE-EVOL-002: persisted deterministic conflict degrades the
          // questioned knowledge via existing C11 infrastructure.
          await degradeOnPersistedConflict(conflictResult.conflictId, transactionId, companyId, entityResolution.entityId);
        }
      } else {
        // ERROR — do not persist identity or treatment silently
        logger.warn('[KE] Entity resolution error — identity confirmation skipped', {
          transactionId,
          companyId,
          stage: 'entity_resolution',
          reason: entityResolution.reason,
        });
      }
    } else {
      // No confirmedEntity — learn treatment if KNOWN, skip if UNKNOWN
      const entityResolution = await resolveEntity(companyId, transaction.description);

      if (entityResolution.status === 'KNOWN') {
        const keResult = await learnEntityTreatment(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          entityResolution.entityId,
          glAccountId,
          'any',
          'user_correction',
          transactionId,
        );
        if (keResult.status === 'ERROR') {
          logger.warn('[KE] Learn failed — accounting correction stands', {
            transactionId,
            companyId,
            stage: 'entity_treatment_learning',
            error: keResult.reason,
          });
        } else {
          // KE-EVOL-002: user-confirmed correction promotes THIS exact
          // treatment to certain via existing C11.
          await promoteConfirmedTreatment(keResult.itemId, transactionId, companyId, entityResolution.entityId);
        }

        // Record observation (independent of treatment UNCHANGED/UPDATED)
        const obsResult = await recordClassificationObservation(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          {
            entityId: entityResolution.entityId,
            originalDescription: transaction.description,
            glAccountId,
            direction: 'any',
            source: 'user_correction',
            transactionId,
          },
        );

        if (!obsResult.ok) {
          logger.warn('[KE] Observation record failed — treatment stands', {
            transactionId,
            companyId,
            entityId: entityResolution.entityId,
            stage: 'observation_recording',
            error: obsResult.error,
          });
        }

        // KE-EVOL-001: detect conflict after observation
        const conflictResult = await detectConflictingPattern(
          createAdapter(db, (fn) => db.$transaction(fn)),
          companyId,
          entityResolution.entityId,
          'any',
        );
        if (conflictResult.status === 'ERROR') {
          logger.warn('[KE] Conflict detection failed — observation stands', {
            transactionId,
            companyId,
            entityId: entityResolution.entityId,
            stage: 'conflict_detection',
            error: conflictResult.error,
          });
        } else if (conflictResult.status === 'RECORDED' || conflictResult.status === 'ALREADY_RECORDED') {
          // KE-EVOL-002: persisted deterministic conflict degrades the
          // questioned knowledge via existing C11 infrastructure.
          await degradeOnPersistedConflict(conflictResult.conflictId, transactionId, companyId, entityResolution.entityId);
        }
      } else if (entityResolution.status === 'UNKNOWN') {
        logger.info('[KE] Unknown entity — learning skipped', {
          transactionId,
          companyId,
          description: transaction.description,
        });
      } else {
        logger.warn('[KE] Entity resolution error — learning skipped', {
          transactionId,
          companyId,
          stage: 'entity_resolution',
          reason: entityResolution.reason,
        });
      }
    }
  } catch (keError) {
    // KE learning failures are explicitly logged and auditable.
    // Accounting correction already committed — response remains successful.
    logger.error('[KE] Post-accounting learning failed — accounting correction stands', {
      transactionId,
      companyId,
      stage: 'entity_learning',
      error: keError instanceof Error ? keError.message : String(keError),
    });
  }

  return { status: 'OK', transaction: result } as const;
}
