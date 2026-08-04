import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { revertApplyRecord } from '@/lib/services/rollback-apply.service';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';
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

const mockGetSessionUserId = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

describe('4.9 - Classification-only rollback (integration, accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
    mockGetSessionUserId.mockReset();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('action=apply creates a durable record without journal; rollback clears classification and keeps the FK', async () => {
    const user = await createTestUser('class49@example.com');
    const company = await createTestCompany('Class Only 4.9');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const expenseGl = await createTestGlAccount({
      companyId: company.id,
      code: '6000',
      name: 'Expense',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    const bankGl = await createTestGlAccount({
      companyId: company.id,
      code: '1000',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const bankAccount = await createTestBankAccount(company.id, bankGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'CLASSIFY ONLY',
    });

    const rule = await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Classify Only Rule',
        conditionType: 'contains',
        conditionValue: 'CLASSIFY',
        transactionDirection: 'any',
        glAccountId: expenseGl.id,
        priority: 10,
        isActive: true,
      },
    });

    const initialExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const initialBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(initialExpense.balance)).toBe(0);
    expect(Number(initialBank.balance)).toBe(0);

    // ── 1) action=apply via the REAL route ──
    const { POST: applyRoute } = await import('@/app/api/bank-rules/[id]/route');
    const applyReq = new NextRequest(
      `http://localhost/api/bank-rules/${rule.id}?companyId=${company.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      },
    );
    const applyRes = await applyRoute(applyReq, { params: Promise.resolve({ id: rule.id }) });
    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.matched).toBe(1);

    // Durable record created, origin single-rule, state applied.
    const record = await db.ruleApplyRecord.findFirstOrThrow({ where: { companyId: company.id } });
    expect(record.origin).toBe('single-rule');
    expect(record.ruleId).toBe(rule.id);
    expect(record.state).toBe('applied');

    // No journal, no line.
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.journalLine.count({ where: { entry: { companyId: company.id } } })).toBe(0);

    // Transaction classified: glAccountId + matchedRuleId + ruleApplyRecordId.
    let txApplied = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txApplied.glAccountId).toBe(expenseGl.id);
    expect(txApplied.matchedRuleId).toBe(rule.id);
    expect(txApplied.ruleApplyRecordId).toBe(record.id);
    // journalEntryId/journalLineId stay null (classification-only).
    expect(txApplied.journalEntryId).toBeNull();
    expect(txApplied.journalLineId).toBeNull();

    const recordId = record.id;

    // ── 2) Rollback via the service (same engine the rollback route calls) ──
    const result = await revertApplyRecord(company.id, recordId, user.id);
    expect(result.status).toBe('reverted');

    // Record reverted.
    const recordPost = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(recordPost.state).toBe('reverted');

    // Classification cleared; links stay null; FK preserved (1-table model).
    const txPost = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txPost.glAccountId).toBeNull();
    expect(txPost.matchedRuleId).toBeNull();
    expect(txPost.journalEntryId).toBeNull();
    expect(txPost.journalLineId).toBeNull();
    expect(txPost.ruleApplyRecordId).toBe(recordId);

    // Not matchingRule cleared journal nor balances: still zero journals and
    // balances identical to initial (no recalc side effect).
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.journalLine.count({ where: { entry: { companyId: company.id } } })).toBe(0);
    const expensePost = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const bankPost = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(expensePost.balance)).toBe(Number(initialExpense.balance));
    expect(Number(bankPost.balance)).toBe(Number(initialBank.balance));

    // Exactly one RULE_REVERTED with the full filter.
    const revertAudits = await db.auditLog.count({
      where: {
        companyId: company.id,
        action: 'RULE_REVERTED',
        entity: 'RuleApplyRecord',
        entityId: recordId,
        userId: user.id,
      },
    });
    expect(revertAudits).toBe(1);

    // ── 3) Re-eligibility: the transaction matches the eligibility filter again ──
    const eligible = await db.bankTransaction.count({
      where: eligibleForClassificationWhere({ id: tx.id }),
    });
    expect(eligible).toBe(1);
  });
});