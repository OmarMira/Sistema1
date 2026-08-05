import crypto from 'crypto';
import { createAuditLogWithRetry } from '@/lib/audit';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

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

  if (debitIds.length > 0) {
    const debitAccountId = rule.debitGlAccountId || rule.glAccountId;
    const updatedRows = await tx.bankTransaction.updateManyAndReturn({
      where: eligibleForClassificationWhere({ id: { in: debitIds } }),
      data: { glAccountId: debitAccountId, matchedRuleId: rule.id },
      select: { id: true },
    });
    actualMatched += updatedRows.length;
    acquiredIds.push(...updatedRows.map((r: any) => r.id));
  }

  if (creditIds.length > 0) {
    const creditAccountId = rule.creditGlAccountId || rule.glAccountId;
    const updatedRows = await tx.bankTransaction.updateManyAndReturn({
      where: eligibleForClassificationWhere({ id: { in: creditIds } }),
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