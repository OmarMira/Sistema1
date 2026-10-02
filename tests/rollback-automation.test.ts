// §GAP10 — Block B: targeted tests for the certified rollback core.
// Demonstrates the REAL contract of src/lib/rollback-automation.ts
// (Block A CLOSED_CERTIFIED) against the real test database.
// No production code is modified here. No HTTP/auth boundary tests:
// the human/AI session boundary belongs to Block C.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rollbackAutomationDecision } from '@/lib/rollback-automation';
import { db } from '@/lib/db';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  clearDatabase,
} from './helpers/factories';

interface Tenant {
  userId: string;
  companyId: string;
  glOldId: string;
  glNewId: string;
  txId: string;
}

async function setupTenant(tag: string): Promise<Tenant> {
  const user = await createTestUser(`rollback-${tag}@example.com`);
  const company = await createTestCompany(`Rollback Co ${tag}`);
  await createTestCompanyMember(user.id, company.id);
  const glOld = await createTestGlAccount({
    companyId: company.id,
    code: '6100',
    name: `Old GL ${tag}`,
  });
  const glNew = await createTestGlAccount({
    companyId: company.id,
    code: '6200',
    name: `New GL ${tag}`,
  });
  const bankAccount = await createTestBankAccount(company.id, glOld.id, `Bank ${tag}`);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const tx = await db.bankTransaction.create({
    data: {
      statementId: statement.id,
      date: new Date('2025-03-15'),
      amount: 100,
      description: `rollback tx ${tag}`,
      glAccountId: glOld.id,
    },
  });
  return {
    userId: user.id,
    companyId: company.id,
    glOldId: glOld.id,
    glNewId: glNew.id,
    txId: tx.id,
  };
}

async function createRule(companyId: string, glAccountId: string, name: string) {
  return db.bankRule.create({
    data: {
      companyId,
      name,
      conditionType: 'description_contains',
      conditionValue: name,
      glAccountId,
      isActive: true,
    },
  });
}

async function seedProvenance(
  userId: string,
  companyId: string,
  txId: string,
  details: Record<string, string>,
) {
  return db.auditLog.create({
    data: {
      companyId,
      userId,
      action: 'FINAL_DECISION_SOURCE',
      entity: 'BankTransaction',
      entityId: txId,
      details: JSON.stringify(details),
    },
  });
}

async function getAuditDetails(action: string, entityId: string) {
  const row = await db.auditLog.findFirst({
    where: { action, entityId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || !row.details) return null;
  return JSON.parse(row.details) as Record<string, unknown>;
}

describe('§GAP10 rollback automation core', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('T1 reclassification real: rollback moves the transaction to the corrected GL', async () => {
    const t = await setupTenant('t1');
    await seedProvenance(t.userId, t.companyId, t.txId, { source: 'KNOWLEDGE' });

    const res = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T1 rollback of knowledge decision',
    });

    expect(res.ok).toBe(true);
    expect(res.classificationChanged).toBe(true);
    expect(res.knowledgeRevoked).toBe(false);

    const after = await db.bankTransaction.findUnique({ where: { id: t.txId } });
    expect(after?.glAccountId).toBe(t.glNewId);
    // Productive accounting flow ran (rollback never writes GL itself).
    expect(after?.journalEntryId ?? after?.journalLineId).not.toBeNull();
  });

  it('T2 rule revocation: original RULE decision disables exactly that rule', async () => {
    const t = await setupTenant('t2');
    const ruleA = await createRule(t.companyId, t.glOldId, 'RULE-A');
    const ruleOther = await createRule(t.companyId, t.glOldId, 'RULE-OTHER');
    await seedProvenance(t.userId, t.companyId, t.txId, {
      source: 'RULE',
      matchedRuleId: ruleA.id,
    });

    const res = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      reason: 'T2 revoke automation authority',
    });

    expect(res.ok).toBe(true);
    expect(res.ruleRevoked).toBe(true);

    const afterA = await db.bankRule.findUnique({ where: { id: ruleA.id } });
    expect(afterA?.isActive).toBe(false);
    const afterOther = await db.bankRule.findUnique({ where: { id: ruleOther.id } });
    expect(afterOther?.isActive).toBe(true);
  });

  it('T3 previous provenance preserved: ROLLBACK_RECORDED stores the pre-rollback source', async () => {
    const t = await setupTenant('t3');
    await seedProvenance(t.userId, t.companyId, t.txId, { source: 'KNOWLEDGE' });

    const res = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T3 provenance order',
    });
    expect(res.ok).toBe(true);

    const recorded = await getAuditDetails('ROLLBACK_RECORDED', t.txId);
    expect(recorded).not.toBeNull();
    expect(recorded?.previousDecisionSource).toBe('KNOWLEDGE');

    // Reclassification DID register a newer USER_CORRECTION trace — proving
    // the snapshot had to be taken before the mutation.
    const traces = await db.auditLog.findMany({
      where: { action: 'FINAL_DECISION_SOURCE', entityId: t.txId },
      orderBy: { createdAt: 'asc' },
    });
    expect(traces.length).toBeGreaterThanOrEqual(2);
    const latest = JSON.parse(traces[traces.length - 1].details ?? '{}') as {
      source?: string;
    };
    expect(latest.source).toBe('USER_CORRECTION');
  });

  it('T4 audit trail append-only: real events present and history preserved', async () => {
    const t = await setupTenant('t4');
    const rule = await createRule(t.companyId, t.glOldId, 'RULE-T4');
    const seeded = await seedProvenance(t.userId, t.companyId, t.txId, {
      source: 'RULE',
      matchedRuleId: rule.id,
    });

    const res = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T4 audit trail',
    });
    expect(res.ok).toBe(true);

    const actions = await db.auditLog.findMany({
      where: { entityId: t.txId },
      select: { action: true },
    });
    const actionSet = new Set(actions.map((a) => a.action));
    expect(actionSet.has('ROLLBACK_RECLASSIFY')).toBe(true);
    expect(
      actionSet.has('ROLLBACK_KNOWLEDGE_REVOKE_SKIPPED_MECHANISM_MISSING'),
    ).toBe(true);
    expect(actionSet.has('ROLLBACK_RECORDED')).toBe(true);

    const ruleDisabled = await db.auditLog.findFirst({
      where: { action: 'ROLLBACK_RULE_DISABLED', entityId: rule.id },
    });
    expect(ruleDisabled).not.toBeNull();

    // Append-only: the original FINAL_DECISION_SOURCE row still exists.
    const historical = await db.auditLog.findUnique({ where: { id: seeded.id } });
    expect(historical).not.toBeNull();
    expect(historical?.details).toBe(seeded.details);
  });

  it('T5 tenant isolation: cross-tenant rollback fails closed and mutates nothing', async () => {
    const a = await setupTenant('t5a');
    const b = await setupTenant('t5b');
    const ruleB = await createRule(b.companyId, b.glOldId, 'RULE-B5');
    await seedProvenance(b.userId, b.companyId, b.txId, {
      source: 'RULE',
      matchedRuleId: ruleB.id,
    });

    await expect(
      rollbackAutomationDecision({
        companyId: a.companyId,
        transactionId: b.txId,
        actorUserId: a.userId,
        correctedGlAccountId: a.glNewId,
        reason: 'T5 cross tenant',
      }),
    ).rejects.toThrow('ROLLBACK_FAIL_CLOSED: transaction not found in tenant');

    const txB = await db.bankTransaction.findUnique({ where: { id: b.txId } });
    expect(txB?.glAccountId).toBe(b.glOldId);
    const ruleAfter = await db.bankRule.findUnique({ where: { id: ruleB.id } });
    expect(ruleAfter?.isActive).toBe(true);
    const recordedForB = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECORDED', entityId: b.txId },
    });
    expect(recordedForB).toBe(0);
  });

  it('T6 required identity: missing companyId / actorUserId / transactionId fail closed', async () => {
    const t = await setupTenant('t6');
    const base = {
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      reason: 'T6 identity',
    };

    await expect(
      rollbackAutomationDecision({ ...base, companyId: '' }),
    ).rejects.toThrow('ROLLBACK_FAIL_CLOSED: missing required identity');
    await expect(
      rollbackAutomationDecision({ ...base, actorUserId: '' }),
    ).rejects.toThrow('ROLLBACK_FAIL_CLOSED: missing required identity');
    await expect(
      rollbackAutomationDecision({ ...base, transactionId: '' }),
    ).rejects.toThrow('ROLLBACK_FAIL_CLOSED: missing required identity');

    const after = await db.bankTransaction.findUnique({ where: { id: t.txId } });
    expect(after?.glAccountId).toBe(t.glOldId);
  });

  it('T7 RULE provenance without matchedRuleId fails closed before reclassification', async () => {
    const t = await setupTenant('t7');
    const unrelated = await createRule(t.companyId, t.glOldId, 'RULE-UNRELATED');
    await seedProvenance(t.userId, t.companyId, t.txId, { source: 'RULE' });

    await expect(
      rollbackAutomationDecision({
        companyId: t.companyId,
        transactionId: t.txId,
        actorUserId: t.userId,
        correctedGlAccountId: t.glNewId,
        reason: 'T7 rule without id',
      }),
    ).rejects.toThrow('ROLLBACK_FAIL_CLOSED: RULE provenance missing matchedRuleId');

    const after = await db.bankTransaction.findUnique({ where: { id: t.txId } });
    expect(after?.glAccountId).toBe(t.glOldId);
    expect(after?.journalEntryId).toBeNull();
    const ruleAfter = await db.bankRule.findUnique({ where: { id: unrelated.id } });
    expect(ruleAfter?.isActive).toBe(true);
    const reclassifyAudits = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECLASSIFY', entityId: t.txId },
    });
    expect(reclassifyAudits).toBe(0);
  });

  it('T8 cross-tenant rule id: tenant-scoped revocation protects the other tenant', async () => {
    const a = await setupTenant('t8a');
    const b = await setupTenant('t8b');
    const ruleB = await createRule(b.companyId, b.glOldId, 'RULE-B8');
    await seedProvenance(a.userId, a.companyId, a.txId, {
      source: 'RULE',
      matchedRuleId: ruleB.id,
    });

    const res = await rollbackAutomationDecision({
      companyId: a.companyId,
      transactionId: a.txId,
      actorUserId: a.userId,
      reason: 'T8 cross tenant rule id',
    });

    expect(res.ok).toBe(true);
    expect(res.ruleRevoked).toBe(false);
    const ruleAfter = await db.bankRule.findUnique({ where: { id: ruleB.id } });
    expect(ruleAfter?.isActive).toBe(true);
  });

  it('T9 no-op classification: identical GL reports classificationChanged=false', async () => {
    const t = await setupTenant('t9');
    await db.bankTransaction.update({
      where: { id: t.txId },
      data: { glAccountId: t.glNewId },
    });
    await seedProvenance(t.userId, t.companyId, t.txId, { source: 'KNOWLEDGE' });

    const res = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T9 no-op classification',
    });

    expect(res.ok).toBe(true);
    expect(res.classificationChanged).toBe(false);
  });

  it('T10 accounting failure propagates: locked fiscal period rejects the rollback', async () => {
    const t = await setupTenant('t10');
    await db.fiscalPeriod.create({
      data: {
        companyId: t.companyId,
        name: 'Closed 2025',
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-12-31'),
        isLocked: true,
      },
    });
    await seedProvenance(t.userId, t.companyId, t.txId, { source: 'KNOWLEDGE' });

    await expect(
      rollbackAutomationDecision({
        companyId: t.companyId,
        transactionId: t.txId,
        actorUserId: t.userId,
        correctedGlAccountId: t.glNewId,
        reason: 'T10 locked period',
      }),
    ).rejects.toThrow(/Cannot post transactions to a closed period/);

    const after = await db.bankTransaction.findUnique({ where: { id: t.txId } });
    expect(after?.glAccountId).toBe(t.glOldId);
    const recorded = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECORDED', entityId: t.txId },
    });
    expect(recorded).toBe(0);
  });

  it('T11 knowledge history preserved with truthful skipped-revocation audit', async () => {
    const t = await setupTenant('t11');
    const item = await db.memoryItem.create({
      data: {
        companyId: t.companyId,
        content: 'Merchant X treated as office expense (6100)',
        type: 'classification',
        sourceAuthor: 'test',
        sourceName: 'test',
      },
    });
    const version = await db.memoryVersion.create({
      data: {
        itemId: item.id,
        versionNumber: 1,
        content: 'Merchant X treated as office expense (6100)',
        snapshot: {},
      },
    });
    await seedProvenance(t.userId, t.companyId, t.txId, { source: 'KNOWLEDGE' });

    const res = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T11 knowledge preserved',
    });

    expect(res.ok).toBe(true);
    expect(res.knowledgeRevoked).toBe(false);

    const itemAfter = await db.memoryItem.findUnique({ where: { id: item.id } });
    expect(itemAfter?.content).toBe('Merchant X treated as office expense (6100)');
    expect(itemAfter?.status).toBe('active');
    const versionAfter = await db.memoryVersion.findUnique({ where: { id: version.id } });
    expect(versionAfter?.content).toBe('Merchant X treated as office expense (6100)');

    const skip = await getAuditDetails(
      'ROLLBACK_KNOWLEDGE_REVOKE_SKIPPED_MECHANISM_MISSING',
      t.txId,
    );
    expect(skip).not.toBeNull();
    expect(skip?.knowledgeRevoked).toBe(false);
    expect(skip?.mechanismFound).toBe(false);
  });

  it('T12 repeated rollback safe: rule stays revoked, history and tenants intact', async () => {
    const t = await setupTenant('t12');
    const control = await setupTenant('t12b');
    const rule = await createRule(t.companyId, t.glOldId, 'RULE-12');
    const ruleControl = await createRule(control.companyId, control.glOldId, 'RULE-CONTROL');
    const seeded = await seedProvenance(t.userId, t.companyId, t.txId, {
      source: 'RULE',
      matchedRuleId: rule.id,
    });

    const res1 = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T12 first rollback',
    });
    expect(res1.ok).toBe(true);
    expect(res1.ruleRevoked).toBe(true);
    expect(res1.knowledgeRevoked).toBe(false);

    const res2 = await rollbackAutomationDecision({
      companyId: t.companyId,
      transactionId: t.txId,
      actorUserId: t.userId,
      correctedGlAccountId: t.glNewId,
      reason: 'T12 repeat rollback',
    });
    expect(res2.ok).toBe(true);
    expect(res2.knowledgeRevoked).toBe(false);
    // After the first rollback the latest provenance is USER_CORRECTION,
    // so the second run does not re-process the rule path.
    expect(res2.ruleRevoked).toBe(false);

    const ruleAfter = await db.bankRule.findUnique({ where: { id: rule.id } });
    expect(ruleAfter?.isActive).toBe(false); // never reactivated
    const ruleControlAfter = await db.bankRule.findUnique({ where: { id: ruleControl.id } });
    expect(ruleControlAfter?.isActive).toBe(true); // no cross-tenant effect

    const historical = await db.auditLog.findUnique({ where: { id: seeded.id } });
    expect(historical).not.toBeNull();

    const recorded = await db.auditLog.findMany({
      where: { action: 'ROLLBACK_RECORDED', entityId: t.txId },
      orderBy: { createdAt: 'asc' },
    });
    expect(recorded.length).toBe(2);
    const first = JSON.parse(recorded[0].details ?? '{}') as {
      previousDecisionSource?: string;
    };
    expect(first.previousDecisionSource).toBe('RULE');

    const disabledAudits = await db.auditLog.count({
      where: { action: 'ROLLBACK_RULE_DISABLED', entityId: rule.id },
    });
    expect(disabledAudits).toBe(1); // no repeat disable on the second run
  });
});
