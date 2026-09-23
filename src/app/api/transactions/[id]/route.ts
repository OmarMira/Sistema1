import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
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
import { EntityTypeValues, type EntityType } from '@/internal/company-knowledge/entity/types';

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

// ─── PATCH /api/transactions/[id] ───────────────────────────────────────
// Manual GL account assignment: updates the transaction and creates the
// corresponding journal entry automatically.
export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  const { id } = await context.params;

  const body = await request.json();
  const { glAccountId, confirmedEntity } = body as {
    glAccountId: string;
    confirmedEntity?: {
      canonicalName: string;
      entityType: EntityType;
    };
  };

  if (!glAccountId) {
    return NextResponse.json(
      { error: 'glAccountId is required' },
      { status: 400 },
    );
  }

  // Validate confirmedEntity BEFORE any side effect. When present it must be
  // an object with a trim-non-empty canonicalName and an entityType member of
  // EntityTypeValues — otherwise the request is rejected with 400 so invalid
  // identity confirmations never reach confirmEntityIdentity.
  if (confirmedEntity !== undefined && confirmedEntity !== null) {
    const ce = confirmedEntity as { canonicalName?: unknown; entityType?: unknown };
    const canonicalNameOk =
      typeof ce === 'object' &&
      typeof ce.canonicalName === 'string' &&
      ce.canonicalName.trim().length > 0;
    const entityTypeOk =
      typeof ce.entityType === 'string' &&
      (EntityTypeValues as readonly string[]).includes(ce.entityType);
    if (!canonicalNameOk || !entityTypeOk) {
      return NextResponse.json(
        {
          error:
            'confirmedEntity must include a non-empty canonicalName and a valid entityType',
        },
        { status: 400 },
      );
    }
  }

  // Verify the transaction exists and belongs to the company
  const transaction = await db.bankTransaction.findFirst({
    where: { id, statement: { bankAccount: { companyId } } },
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
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }

  // Verify the GL account exists and belongs to the company
  const glAccount = await db.glAccount.findFirst({
    where: { id: glAccountId, companyId, isActive: true },
  });
  if (!glAccount) {
    return NextResponse.json(
      { error: 'GL account not found or inactive' },
      { status: 404 },
    );
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
        where: { id },
        data: { journalEntryId: null },
      });
    }
    // Update the transaction with the new GL account
    const updated = await tx.bankTransaction.update({
      where: { id },
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
    transactionId: id,
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
          id,
        );

        if (keResult.status === 'ERROR') {
          logger.warn('[KE] Treatment learn failed after identity confirmation', {
            transactionId: id,
            companyId,
            entityId: confirmed.id,
            stage: 'entity_treatment_learning',
            error: keResult.reason,
          });
        } else {
          // KE-EVOL-002: user-confirmed correction is human authority over
          // THIS exact treatment → promote to certain via existing C11.
          await promoteConfirmedTreatment(keResult.itemId, id, companyId, confirmed.id);
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
            transactionId: id,
          },
        );

        if (!obsResult.ok) {
          logger.warn('[KE] Observation record failed — treatment stands', {
            transactionId: id,
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
            transactionId: id,
            companyId,
            entityId: confirmed.id,
            stage: 'conflict_detection',
            error: conflictResult.error,
          });
        } else if (conflictResult.status === 'RECORDED' || conflictResult.status === 'ALREADY_RECORDED') {
          // KE-EVOL-002: persisted deterministic conflict degrades the
          // questioned knowledge via existing C11 infrastructure.
          await degradeOnPersistedConflict(conflictResult.conflictId, id, companyId, confirmed.id);
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
          id,
        );
        if (keResult.status === 'ERROR') {
          logger.warn('[KE] Learn failed — accounting correction stands', {
            transactionId: id,
            companyId,
            stage: 'entity_treatment_learning',
            error: keResult.reason,
          });
        } else {
          // KE-EVOL-002: user-confirmed correction promotes THIS exact
          // treatment to certain via existing C11.
          await promoteConfirmedTreatment(keResult.itemId, id, companyId, entityResolution.entityId);
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
            transactionId: id,
          },
        );

        if (!obsResult.ok) {
          logger.warn('[KE] Observation record failed — treatment stands', {
            transactionId: id,
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
            transactionId: id,
            companyId,
            entityId: entityResolution.entityId,
            stage: 'conflict_detection',
            error: conflictResult.error,
          });
        } else if (conflictResult.status === 'RECORDED' || conflictResult.status === 'ALREADY_RECORDED') {
          // KE-EVOL-002: persisted deterministic conflict degrades the
          // questioned knowledge via existing C11 infrastructure.
          await degradeOnPersistedConflict(conflictResult.conflictId, id, companyId, entityResolution.entityId);
        }
      } else {
        // ERROR — do not persist identity or treatment silently
        logger.warn('[KE] Entity resolution error — identity confirmation skipped', {
          transactionId: id,
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
          id,
        );
        if (keResult.status === 'ERROR') {
          logger.warn('[KE] Learn failed — accounting correction stands', {
            transactionId: id,
            companyId,
            stage: 'entity_treatment_learning',
            error: keResult.reason,
          });
        } else {
          // KE-EVOL-002: user-confirmed correction promotes THIS exact
          // treatment to certain via existing C11.
          await promoteConfirmedTreatment(keResult.itemId, id, companyId, entityResolution.entityId);
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
            transactionId: id,
          },
        );

        if (!obsResult.ok) {
          logger.warn('[KE] Observation record failed — treatment stands', {
            transactionId: id,
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
            transactionId: id,
            companyId,
            entityId: entityResolution.entityId,
            stage: 'conflict_detection',
            error: conflictResult.error,
          });
        } else if (conflictResult.status === 'RECORDED' || conflictResult.status === 'ALREADY_RECORDED') {
          // KE-EVOL-002: persisted deterministic conflict degrades the
          // questioned knowledge via existing C11 infrastructure.
          await degradeOnPersistedConflict(conflictResult.conflictId, id, companyId, entityResolution.entityId);
        }
      } else if (entityResolution.status === 'UNKNOWN') {
        logger.info('[KE] Unknown entity — learning skipped', {
          transactionId: id,
          companyId,
          description: transaction.description,
        });
      } else {
        logger.warn('[KE] Entity resolution error — learning skipped', {
          transactionId: id,
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
      transactionId: id,
      companyId,
      stage: 'entity_learning',
      error: keError instanceof Error ? keError.message : String(keError),
    });
  }

  return NextResponse.json({ transaction: result });
});

// ─── GET /api/transactions/[id] ───────────────────────────────────────────
// Entity-status endpoint for ReclassifyDialog: reports whether the
// transaction description already resolves to a known entity identity.
// Read-only: no learning, no writes. On resolution failure the client
// degrades to GL-only, so the response is 200 { entityStatus: 'ERROR' }
// instead of a 500.
export const GET = apiHandler(async (_request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  const { id } = await context.params;

  const transaction = await db.bankTransaction.findFirst({
    where: { id, statement: { bankAccount: { companyId } } },
    select: { id: true, description: true },
  });

  if (!transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }

  try {
    const resolution = await resolveEntity(companyId, transaction.description);
    if (resolution.status === 'KNOWN') {
      return NextResponse.json({
        entityStatus: 'KNOWN',
        entityId: resolution.entityId,
        transaction: { id: transaction.id, description: transaction.description },
      });
    }
    if (resolution.status === 'UNKNOWN') {
      return NextResponse.json({
        entityStatus: 'UNKNOWN',
        transaction: { id: transaction.id, description: transaction.description },
      });
    }
    return NextResponse.json({ entityStatus: 'ERROR' });
  } catch {
    return NextResponse.json({ entityStatus: 'ERROR' });
  }
});
