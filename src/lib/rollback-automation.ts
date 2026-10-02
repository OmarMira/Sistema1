/**
 * §GAP10 — Safe rollback of an automated decision.
 * Uses existing services only; does NOT invent a new accounting engine.
 * Accounting safety is delegated to reclassifyTransaction and its existing
 * guards (assertActiveFiscalPeriod + accounting phase).
 */
import { db } from './db';
import { requireCompanyContext } from './context-storage';
import { createAuditLogWithRetry } from './audit';
import { resolveDecisionExplanation } from './get-decision-explanation';
import { reclassifyTransaction } from './services/transaction-reclassification.service';

export interface RollbackInput {
  companyId: string;
  transactionId: string;
  actorUserId: string;
  correctedGlAccountId?: string;
  reason: string;
}

export async function rollbackAutomationDecision(input: RollbackInput) {
  // 1. Tenant safety (fail closed if companyId missing)
  if (!input.companyId || !input.actorUserId || !input.transactionId) {
    throw new Error('ROLLBACK_FAIL_CLOSED: missing required identity');
  }

  // 2. Read current transaction state (existing service / DB)
  const tx = await db.bankTransaction.findFirst({
    where: {
      id: input.transactionId,
      statement: {
        bankAccount: {
          companyId: input.companyId,
        },
      },
    },
  });
  if (!tx) {
    throw new Error('ROLLBACK_FAIL_CLOSED: transaction not found in tenant');
  }

  // 3. Snapshot the ORIGINAL provenance BEFORE any mutation.
  //    reclassifyTransaction records a new FINAL_DECISION_SOURCE
  //    (USER_CORRECTION), so any later "latest" lookup would return the
  //    new decision instead of the automated decision being rolled back.
  const previousDecisionSource =
    (await resolveDecisionExplanation(input.companyId, input.transactionId))?.source ??
    'unknown';

  let previousMatchedRuleId: string | undefined;
  try {
    const decisionAudit = await db.auditLog.findFirst({
      where: {
        companyId: input.companyId,
        action: 'FINAL_DECISION_SOURCE',
        entity: 'BankTransaction',
        entityId: input.transactionId,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (decisionAudit && decisionAudit.details) {
      const details = JSON.parse(decisionAudit.details ?? '{}') as {
        matchedRuleId?: string;
      };
      previousMatchedRuleId = details.matchedRuleId;
    }
  } catch {
    // Ignore audit parsing errors; do not block rollback.
  }

  // Fail-closed: if the original decision came from RULE but the BankRule
  // cannot be identified (invalid JSON, missing field, incomplete
  // provenance), the rollback cannot guarantee that the future automatic
  // authority was revoked. Must happen BEFORE any mutation.
  if (previousDecisionSource === 'RULE' && !previousMatchedRuleId) {
    throw new Error('ROLLBACK_FAIL_CLOSED: RULE provenance missing matchedRuleId');
  }

  let classificationChanged = false;

  // 4. Reclassify (existing mechanism; non-destructive to history)
  if (input.correctedGlAccountId) {
    const reclassified = await reclassifyTransaction({
      companyId: input.companyId,
      transactionId: input.transactionId,
      glAccountId: input.correctedGlAccountId,
      source: 'user_correction',
    });
    classificationChanged =
      reclassified.status === 'OK' && tx.glAccountId !== input.correctedGlAccountId;
    await createAuditLogWithRetry({
      companyId: input.companyId,
      userId: input.actorUserId,
      action: 'ROLLBACK_RECLASSIFY',
      entity: 'BankTransaction',
      entityId: input.transactionId,
      details: JSON.stringify({
        previousGlAccountId: tx.glAccountId,
        correctedGlAccountId: input.correctedGlAccountId,
        reclassifyStatus: reclassified.status,
        reason: input.reason,
      }),
    });
    if (reclassified.status !== 'OK') {
      // Fail-closed per the service's existing contract: propagate the rejection.
      throw new Error(
        `ROLLBACK_FAIL_CLOSED: reclassifyTransaction rejected (${reclassified.status})`
      );
    }
  }

  // 5. Knowledge revocation — mechanism check (GATE 8)
  // degradeKnowledgeOnConflict requires a CONFLICTING_PATTERN_TYPE conflictId
  // and a MemoryAdapter; it does NOT represent a direct human revocation of
  // the knowledge that produced this transaction. No semantically valid
  // revocation function exists for this scenario. Truthful state: NOT revoked.
  await createAuditLogWithRetry({
    companyId: input.companyId,
    userId: input.actorUserId,
    action: 'ROLLBACK_KNOWLEDGE_REVOKE_SKIPPED_MECHANISM_MISSING',
    entity: 'MemoryService',
    entityId: input.transactionId,
    details: JSON.stringify({
      source: 'rollback_automation_decision',
      reason: input.reason,
      preservedHistory: true,
      mechanismFound: false,
      knowledgeRevoked: false,
      note: 'No semantically valid forget/degrade/revoke mechanism found for direct rollback; MemoryService knowledge preserved.',
    }),
  });

  // 6. Real rule revocation — decided EXCLUSIVELY from the pre-mutation
  //    snapshot (RULE provenance + verified matchedRuleId), restricted to
  //    the caller's company scope.
  let ruleRevoked = false;
  if (previousDecisionSource === 'RULE' && previousMatchedRuleId) {
    const disabled = await db.bankRule.updateMany({
      where: {
        id: previousMatchedRuleId,
        companyId: input.companyId,
        isActive: true,
      },
      data: { isActive: false },
    });
    ruleRevoked = disabled.count > 0;
    await createAuditLogWithRetry({
      companyId: input.companyId,
      userId: input.actorUserId,
      action: 'ROLLBACK_RULE_DISABLED',
      entity: 'BankRule',
      entityId: previousMatchedRuleId,
      details: JSON.stringify({
        previousIsActive: true,
        disabledCount: disabled.count,
        ruleRevoked,
        reason: input.reason,
      }),
    });
  }

  // 7. Preserve previous history (do NOT delete AuditLog FINAL_DECISION_SOURCE or MemoryVersion)
  // No destructive mutation of historical provenance.

  // 8. Audit the rollback (append-only) — describes only effects that occurred.
  await createAuditLogWithRetry({
    companyId: input.companyId,
    userId: input.actorUserId,
    action: 'ROLLBACK_RECORDED',
    entity: 'RollbackAutomationDecision',
    entityId: input.transactionId,
    details: JSON.stringify({
      transactionId: input.transactionId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      previousDecisionSource,
      correctedGlAccountId: input.correctedGlAccountId ?? null,
      classificationChanged,
      ruleRevoked,
      knowledgeRevoked: false,
      performedAt: new Date().toISOString(),
    }),
  });

  return {
    ok: true,
    transactionId: input.transactionId,
    classificationChanged,
    ruleRevoked,
    knowledgeRevoked: false,
    historyPreserved: true,
    auditRecorded: true,
  };
}
