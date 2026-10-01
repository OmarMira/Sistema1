// GAP8-2E - Final decision source trace (FINAL_DECISION_SOURCE in AuditLog).
// T1-T10: semantics of the internal lifecycle trace. No schema change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { ImportService } from '@/lib/services/import.service';
import { reclassifyTransaction } from '@/lib/services/transaction-reclassification.service';
import { decideAiProposal } from '@/lib/services/ai-proposal-approval.service';
import { recordFinalDecisionTrace } from '@/lib/final-decision-trace';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  clearDatabase,
} from '../helpers/factories';

const ACTION = 'FINAL_DECISION_SOURCE';

async function tracesFor(companyId: string, entityId?: string) {
  return db.auditLog.findMany({
    where: {
      action: ACTION,
      companyId,
      ...(entityId ? { entityId } : {}),
    },
  });
}

function details(row: { details: string }) {
  return JSON.parse(row.details) as Record<string, string>;
}

async function setup(tag: string) {
  const user = await createTestUser(`${tag}@example.com`);
  const company = await createTestCompany(`${tag} Co`);
  await createTestCompanyMember(user.id, company.id);
  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Bank',
  });
  const expenseGl = await createTestGlAccount({
    companyId: company.id,
    code: '6100',
    name: 'Expense',
    accountType: 'expense',
  });
  const bankAccount = await createTestBankAccount(company.id, bankGl.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const tx = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-05-15',
    amount: 100.0,
    description: `final decision trace ${tag}`,
  });
  const importHash = `fdt-hash-${tag}`;
  await db.bankTransaction.update({
    where: { id: tx.id },
    data: { importHash },
  });
  return { user, company, bankGl, expenseGl, bankAccount, statement, tx, importHash };
}

describe('GAP8-2E final decision source trace', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // T1: import KE hit -> KNOWLEDGE
  it('T1: import classified by Knowledge Engine -> KNOWLEDGE trace', async () => {
    const s = await setup('t1');
    const description = `T1KNOWLEDGEVENDOR${s.company.id.slice(-6)}`;

    const knowledge = await db.companyKnowledge.create({
      data: {
        companyId: s.company.id,
        type: 'COMPANY',
        canonicalName: description,
        aliases: [],
        status: 'active',
      },
    });
    await db.memoryItem.create({
      data: {
        companyId: s.company.id,
        type: 'classification',
        content: JSON.stringify({
          pattern: description,
          glAccountId: s.expenseGl.id,
          direction: 'any',
          source: 'user_correction',
          entityId: knowledge.id,
        }),
        confidence: 'certain',
        status: 'active',
        sourceAuthor: 'test',
        sourceName: 'test',
      },
    });

    const csv = `Date,Description,Amount\n2025-05-01,${description},-100.00`;
    const result = await ImportService.importFile({
      companyId: s.company.id,
      bankAccountId: s.bankAccount.id,
      fileName: 't1.csv',
      extension: 'csv',
      buffer: Buffer.from(csv),
      content: csv,
      userId: s.user.id,
      bypassHolderValidation: true,
    });
    expect(result.transactionCount).toBe(1);

    const imported = await db.bankTransaction.findFirst({
      where: { statement: { bankAccountId: s.bankAccount.id }, description },
    });
    expect(imported).not.toBeNull();
    expect(imported!.glAccountId).toBe(s.expenseGl.id);

    const rows = await tracesFor(s.company.id, imported!.id);
    expect(rows).toHaveLength(1);
    expect(details(rows[0]!).source).toBe('KNOWLEDGE');
  });

  // T2: import rule hit -> RULE + matchedRuleId
  it('T2: import classified by rule engine -> RULE trace with matchedRuleId', async () => {
    const s = await setup('t2');
    const description = `T2RULEVENDOR${s.company.id.slice(-6)}`;
    const rule = await db.bankRule.create({
      data: {
        companyId: s.company.id,
        name: 't2-rule',
        conditionType: 'contains',
        conditionValue: 'T2RULEVENDOR',
        glAccountId: s.expenseGl.id,
        priority: 10,
      },
    });

    const csv = `Date,Description,Amount\n2025-05-01,${description},-100.00`;
    const result = await ImportService.importFile({
      companyId: s.company.id,
      bankAccountId: s.bankAccount.id,
      fileName: 't2.csv',
      extension: 'csv',
      buffer: Buffer.from(csv),
      content: csv,
      userId: s.user.id,
      bypassHolderValidation: true,
    });
    expect(result.transactionCount).toBe(1);

    const imported = await db.bankTransaction.findFirst({
      where: { statement: { bankAccountId: s.bankAccount.id }, description },
    });
    expect(imported).not.toBeNull();
    expect(imported!.glAccountId).toBe(s.expenseGl.id);

    const rows = await tracesFor(s.company.id, imported!.id);
    expect(rows).toHaveLength(1);
    const d = details(rows[0]!);
    expect(d.source).toBe('RULE');
    expect(d.matchedRuleId).toBe(rule.id);
  });

  // T3: pending/no final GL -> NO trace
  it('T3: unclassified import row (no final GL) -> NO final decision trace', async () => {
    const s = await setup('t3');
    const description = `T3NOMATCHVENDOR${s.company.id.slice(-6)}`;

    const csv = `Date,Description,Amount\n2025-05-01,${description},-100.00`;
    const result = await ImportService.importFile({
      companyId: s.company.id,
      bankAccountId: s.bankAccount.id,
      fileName: 't3.csv',
      extension: 'csv',
      buffer: Buffer.from(csv),
      content: csv,
      userId: s.user.id,
      bypassHolderValidation: true,
    });
    expect(result.transactionCount).toBe(1);

    const imported = await db.bankTransaction.findFirst({
      where: { statement: { bankAccountId: s.bankAccount.id }, description },
    });
    expect(imported).not.toBeNull();
    expect(imported!.glAccountId).toBeNull();

    const rows = await tracesFor(s.company.id, imported!.id);
    expect(rows).toHaveLength(0);
  });

  // T4: AI ACCEPT -> AI_HUMAN_APPROVED
  it('T4: AI proposal ACCEPT -> AI_HUMAN_APPROVED trace with approvalId', async () => {
    const s = await setup('t4');
    const proposal = await db.pendingApproval.create({
      data: {
        companyId: s.company.id,
        action: 'ai_classification_proposal',
        payload: {
          companyId: s.company.id,
          transactionId: s.importHash,
          bankAccountId: s.bankAccount.id,
          deterministicResult: 'ambiguous',
          aiProposal: {
            role: 'expense',
            glAccountCode: '6100',
            glAccountId: s.expenseGl.id,
            suggestSubAccount: false,
            subAccountName: null,
            conditions: [],
          },
          proposedEntity: { canonicalName: 'T4 Suggested', entityType: 'company' },
        },
        requestedBy: s.user.id,
        status: 'pending',
      },
    });

    const result = await decideAiProposal({
      companyId: s.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toMatchObject({ status: 'OK', decision: 'ACCEPT' });

    const rows = await tracesFor(s.company.id, s.tx.id);
    expect(rows).toHaveLength(1);
    const d = details(rows[0]!);
    expect(d.source).toBe('AI_HUMAN_APPROVED');
    expect(d.approvalId).toBe(proposal.id);
    expect(rows[0]!.entity).toBe('BankTransaction');
    expect(rows[0]!.entityId).toBe(s.tx.id);
  });

  // T5: AI CORRECT -> AI_HUMAN_APPROVED (approvalId preserved)
  it('T5: AI proposal CORRECT -> AI_HUMAN_APPROVED trace with approvalId', async () => {
    const s = await setup('t5');
    const proposal = await db.pendingApproval.create({
      data: {
        companyId: s.company.id,
        action: 'ai_classification_proposal',
        payload: {
          companyId: s.company.id,
          transactionId: s.importHash,
          bankAccountId: s.bankAccount.id,
          deterministicResult: 'ambiguous',
          aiProposal: {
            role: 'expense',
            glAccountCode: '6100',
            glAccountId: s.expenseGl.id,
            suggestSubAccount: false,
            subAccountName: null,
            conditions: [],
          },
          proposedEntity: { canonicalName: 'T5 Suggested', entityType: 'company' },
        },
        requestedBy: s.user.id,
        status: 'pending',
      },
    });

    const result = await decideAiProposal({
      companyId: s.company.id,
      approvalId: proposal.id,
      decision: 'CORRECT',
      glAccountId: s.expenseGl.id,
      confirmedEntity: { canonicalName: 'ACME SRL', entityType: 'company' },
    });
    expect(result).toMatchObject({ status: 'OK', decision: 'CORRECT' });

    const rows = await tracesFor(s.company.id, s.tx.id);
    expect(rows).toHaveLength(1);
    const d = details(rows[0]!);
    expect(d.source).toBe('AI_HUMAN_APPROVED');
    expect(d.approvalId).toBe(proposal.id);
  });

  // T6: manual reclassify (user_correction) -> USER_CORRECTION
  it('T6: manual reclassification -> USER_CORRECTION trace', async () => {
    const s = await setup('t6');
    const result = await reclassifyTransaction({
      companyId: s.company.id,
      transactionId: s.tx.id,
      glAccountId: s.expenseGl.id,
    });
    expect(result.status).toBe('OK');

    const rows = await tracesFor(s.company.id, s.tx.id);
    expect(rows).toHaveLength(1);
    expect(details(rows[0]!).source).toBe('USER_CORRECTION');
  });

  // T7: post-import correction (import_correction) -> IMPORT_CORRECTION
  it('T7: import correction -> IMPORT_CORRECTION trace', async () => {
    const s = await setup('t7');
    const result = await reclassifyTransaction({
      companyId: s.company.id,
      transactionId: s.tx.id,
      glAccountId: s.expenseGl.id,
      source: 'import_correction',
    });
    expect(result.status).toBe('OK');

    const rows = await tracesFor(s.company.id, s.tx.id);
    expect(rows).toHaveLength(1);
    expect(details(rows[0]!).source).toBe('IMPORT_CORRECTION');
  });

  // T8: cross-company trace isolation
  it('T8: a second company sees no traces of the first (tenant isolation)', async () => {
    const a = await setup('t8-a');
    const b = await setup('t8-b');

    const result = await reclassifyTransaction({
      companyId: a.company.id,
      transactionId: a.tx.id,
      glAccountId: a.expenseGl.id,
    });
    expect(result.status).toBe('OK');

    // Company A has its trace...
    expect(await tracesFor(a.company.id, a.tx.id)).toHaveLength(1);
    // ...company B has none for A's transaction (entityId never leaks).
    expect(await tracesFor(b.company.id, a.tx.id)).toHaveLength(0);
    // And a wrong-tenant reclassify is refused without writing any trace.
    const denied = await reclassifyTransaction({
      companyId: b.company.id,
      transactionId: a.tx.id,
      glAccountId: b.expenseGl.id,
    });
    expect(denied.status).toBe('TRANSACTION_NOT_FOUND');
    expect(await tracesFor(b.company.id, a.tx.id)).toHaveLength(0);
  });

  // T9: trace recording does not change confidence
  it('T9: recording a final decision trace does not change knowledge confidence', async () => {
    const s = await setup('t9');
    const item = await db.memoryItem.create({
      data: {
        companyId: s.company.id,
        type: 'classification',
        content: JSON.stringify({
          pattern: 'T9',
          glAccountId: s.expenseGl.id,
          direction: 'any',
          source: 'user_correction',
        }),
        confidence: 'tentative',
        status: 'active',
        sourceAuthor: 'test',
        sourceName: 'test',
      },
    });

    await recordFinalDecisionTrace({
      companyId: s.company.id,
      transactionId: s.tx.id,
      source: 'USER_CORRECTION',
    });

    const after = await db.memoryItem.findUnique({ where: { id: item.id } });
    expect(after!.confidence).toBe('tentative');
  });

  // T10: trace recording does not change accounting
  it('T10: recording a final decision trace does not change accounting', async () => {
    const s = await setup('t10');
    const before = await db.bankTransaction.findUnique({ where: { id: s.tx.id } });

    await recordFinalDecisionTrace({
      companyId: s.company.id,
      transactionId: s.tx.id,
      source: 'USER_CORRECTION',
    });

    const after = await db.bankTransaction.findUnique({ where: { id: s.tx.id } });
    expect(after!.glAccountId).toBe(before!.glAccountId);
    expect(after!.journalEntryId).toBe(before!.journalEntryId);
    expect(await tracesFor(s.company.id, s.tx.id)).toHaveLength(1);
  });
});
