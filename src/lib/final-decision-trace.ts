import type { Prisma } from '@prisma/client';
import { createAuditLogWithRetry } from '@/lib/audit';

// ─── §GAP8-2E — Final decision source trace ────────────────────────────────
// Internal lifecycle trace: WHO decided the final GL for a BankTransaction.
// Storage: AuditLog (NO schema change, NO migration). One row per final
// decision, written INSIDE the same transaction as the decision itself
// (atomic: decision + trace commit or roll back together).

export const FINAL_DECISION_SOURCE_ACTION = 'FINAL_DECISION_SOURCE';

export type DecisionSource =
  | 'KNOWLEDGE'
  | 'RULE'
  | 'AI_HUMAN_APPROVED'
  | 'USER_CORRECTION'
  | 'IMPORT_CORRECTION';

export type FinalDecisionTraceInput = {
  companyId: string;
  transactionId: string;
  source: DecisionSource;
  userId?: string | null;
  sourceRef?: string | null;
  matchedRuleId?: string | null;
  approvalId?: string | null;
};

/**
 * Persist one FINAL_DECISION_SOURCE AuditLog row for a BankTransaction.
 * Must be called with the SAME tx as the decision that produced it.
 */
export async function recordFinalDecisionTrace(
  input: FinalDecisionTraceInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const details: Record<string, string> = { source: input.source };
  if (input.sourceRef) details.sourceRef = input.sourceRef;
  if (input.matchedRuleId) details.matchedRuleId = input.matchedRuleId;
  if (input.approvalId) details.approvalId = input.approvalId;

  await createAuditLogWithRetry(
    {
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: FINAL_DECISION_SOURCE_ACTION,
      entity: 'BankTransaction',
      entityId: input.transactionId,
      details: JSON.stringify(details),
    },
    tx,
  );
}
