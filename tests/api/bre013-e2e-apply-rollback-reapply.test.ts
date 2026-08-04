import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';
import { executeApplyAllUseCase } from '@/lib/services/apply-all-use-case';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

// E2E BRE-013 3.3: journaled apply → rollback → idempotent re-rollback → re-apply.
// Verifies fresh RuleApplyRecord + fresh JournalEntry IDs, prior record stays
// reverted, idempotent second revert, and no partial classification/journal/balance.
describe('BRE-013 3.3 — E2E apply → rollback → re-apply (accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('journaled apply → rollback → idempotent re-rollback → re-apply with fresh IDs', async () => {
    // ── Seed ────────────────────────────────────────────────
    const user = await createTestUser('e2e3@example.com');
    const company = await createTestCompany('E2E 3.3');
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
      description: 'TEST EXPENSE',
    });

    const rule = await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'E2E Rule',
        conditionType: 'contains',
        conditionValue: 'TEST',
        transactionDirection: 'any',
        glAccountId: expenseGl.id,
        priority: 10,
        isActive: true,
      },
    });

    const { POST: rollbackPOST } = await import('@/app/api/bank-rules/applications/[id]/rollback/route');

    // ── 1) Apply (journaled) via use-case (the same path apply-all route delegates to) ──
    const apply1 = await executeApplyAllUseCase(company.id, { confirmed: true, userId: user.id });
    expect(apply1.enforcement?.status).toBe('EXECUTED');
    expect(apply1.applyResult.applyRecordId).toBeTruthy();
    expect(apply1.applyResult.journalEntryCount).toBe(1);

    const record1 = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: apply1.applyResult.applyRecordId! } });
    const journal1 = await db.journalEntry.findFirstOrThrow({ where: { ruleApplyRecordId: record1.id } });

    const txApplied = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txApplied.ruleApplyRecordId).toBe(record1.id);
    expect(txApplied.glAccountId).toBe(expenseGl.id);
    expect(journal1.status).toBe('posted');

    const journalId1 = journal1.id;
    const recordId1 = record1.id;

    // ── 2) Rollback via the REAL route ──
    const rollback1 = await rollbackPOST(
      new NextRequest(
        `http://localhost/api/bank-rules/applications/${recordId1}/rollback?companyId=${company.id}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ),
      { params: Promise.resolve({ id: recordId1 }) },
    );
    expect(rollback1.status).toBe(200);
    const rollbackBody1 = await rollback1.json();
    expect(rollbackBody1.status).toBe('reverted');

    const record1Reverted = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId1 } });
    expect(record1Reverted.state).toBe('reverted');
    const journal1Void = await db.journalEntry.findUniqueOrThrow({ where: { id: journalId1 } });
    expect(journal1Void.status).toBe('void');

    const txReverted = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txReverted.glAccountId).toBeNull();
    expect(txReverted.matchedRuleId).toBeNull();
    expect(txReverted.journalEntryId).toBeNull();
    expect(txReverted.journalLineId).toBeNull();
    // FK no queda limpio: apunta al registro revertido hasta nuevo apply (decisión 1 tabla)
    expect(txReverted.ruleApplyRecordId).toBe(recordId1);

    // ── 3) Idempotent second rollback via the REAL route ──
    const rollback2 = await rollbackPOST(
      new NextRequest(
        `http://localhost/api/bank-rules/applications/${recordId1}/rollback?companyId=${company.id}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ),
      { params: Promise.resolve({ id: recordId1 }) },
    );
    expect(rollback2.status).toBe(200);
    const rollbackBody2 = await rollback2.json();
    expect(rollbackBody2.status).toBe('already-reverted');

    const revertAudits = await db.auditLog.count({
      where: { action: 'RULE_REVERTED', entityId: recordId1 },
    });
    expect(revertAudits).toBe(1);

    // ── 4) Re-apply (journaled) → must produce FRESH record + journal IDs ──
    const apply2 = await executeApplyAllUseCase(company.id, { confirmed: true, userId: user.id });
    expect(apply2.enforcement?.status).toBe('EXECUTED');
    expect(apply2.applyResult.applyRecordId).toBeTruthy();
    expect(apply2.applyResult.journalEntryCount).toBe(1);

    const recordId2 = apply2.applyResult.applyRecordId!;
    expect(recordId2).not.toBe(recordId1);

    const record2 = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId2 } });
    const journal2 = await db.journalEntry.findFirstOrThrow({ where: { ruleApplyRecordId: recordId2 } });
    expect(journal2.id).not.toBe(journalId1);
    expect(journal2.status).toBe('posted');

    // Prior record stays reverted; fresh journal ID differs.
    const record1AfterReapply = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId1 } });
    expect(record1AfterReapply.state).toBe('reverted');
    expect(journal1Void.status).toBe('void');

    const txReapplied = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txReapplied.ruleApplyRecordId).toBe(recordId2);
    expect(txReapplied.glAccountId).toBe(expenseGl.id);
    expect(txReapplied.matchedRuleId).toBe(rule.id);
    expect(txReapplied.journalEntryId).toBe(journal2.id);

    // ── 5) No partial state ──
    // Exactly two records for the company: one reverted + one applied.
    const records = await db.ruleApplyRecord.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe(recordId1);
    expect(records[0].state).toBe('reverted');
    expect(records[1].id).toBe(recordId2);
    expect(records[1].state).toBe('applied');

    // Exactly one posted journal (journal2); journal1 void.
    const journalStates = await db.journalEntry.findMany({
      where: { ruleApplyRecordId: { in: [recordId1, recordId2] } },
      select: { id: true, status: true },
    });
    expect(journalStates).toHaveLength(2);
    const statusById = Object.fromEntries(journalStates.map((j) => [j.id, j.status]));
    expect(statusById[journalId1]).toBe('void');
    expect(statusById[journal2.id]).toBe('posted');

    // No orphan journal links: only one transaction, linked to record2 + journal2.
    expect(txReapplied.journalEntryId).toBe(journal2.id);
    const orphanedJournals = await db.journalEntry.count({
      where: { ruleApplyRecordId: null, companyId: company.id },
    });
    // No journal with ruleApplyRecordId null for this company.
    expect(orphanedJournals).toBe(0);

    // Balance invariant: GL balance equals recompute from POSTED lines only.
    // journal1 (void) must contribute nothing, so no partial balance remains.
    const expensePosted = await db.journalLine.aggregate({
      where: { glAccountId: expenseGl.id, entry: { status: 'posted' } },
      _sum: { debit: true, credit: true },
    });
    const recomputedExpense = Number(expensePosted._sum.debit || 0) - Number(expensePosted._sum.credit || 0);
    const expenseNow = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    expect(Number(expenseNow.balance)).toBe(recomputedExpense);

    const bankPosted = await db.journalLine.aggregate({
      where: { glAccountId: bankGl.id, entry: { status: 'posted' } },
      _sum: { debit: true, credit: true },
    });
    const recomputedBank = Number(bankPosted._sum.debit || 0) - Number(bankPosted._sum.credit || 0);
    const bankNow = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(bankNow.balance)).toBe(recomputedBank);
  });
});