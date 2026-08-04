import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { executeApplyAll, matchTransactions } from '@/lib/services/apply-all-engine';
import { revertApplyRecord } from '@/lib/services/rollback-apply.service';
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

async function seedJournaledScenario() {
  const user = await createTestUser('revert46@example.com');
  const company = await createTestCompany('Revert 4.6');
  await createTestCompanyMember(user.id, company.id);

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
      name: 'Revert Rule',
      conditionType: 'contains',
      conditionValue: 'TEST',
      transactionDirection: 'any',
      glAccountId: expenseGl.id,
      priority: 10,
      isActive: true,
    },
  });

  return { user, company, expenseGl, bankGl, transaction: tx, rule };
}

describe('4.6 - Journaled rollback fully compensates (service integration, accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('revert applies compensation: journal void, links nulled, balances recomputed, record reverted, one RULE_REVERTED', async () => {
    const { user, company, expenseGl, bankGl, transaction, rule } = await seedJournaledScenario();

    // ── Snapshot 1: Initial state (Balances are 0) ──
    const initialExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const initialBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(initialExpense.balance)).toBe(0);
    expect(Number(initialBank.balance)).toBe(0);

    // Build a REAL applied, journaled state.
    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(1);

    const applied = await db.$transaction(async (tx) =>
      executeApplyAll(company.id, tx, matchResult, {
        userId: user.id,
        origin: 'batch',
      }),
    );
    expect(applied.applyRecordId).toBeTruthy();
    expect(applied.journalEntryCount).toBe(1);
    const recordId = applied.applyRecordId!;

    const journalPre = await db.journalEntry.findFirstOrThrow({ where: { ruleApplyRecordId: recordId } });
    const journalId = journalPre.id;
    expect(journalPre.status).toBe('posted');

    const txPre = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(txPre.glAccountId).toBe(expenseGl.id);
    expect(txPre.matchedRuleId).toBe(rule.id);
    expect(txPre.journalEntryId).toBe(journalId);
    expect(txPre.ruleApplyRecordId).toBe(recordId);

    // ── Snapshot 2: Applied state (Balances must have changed from initial) ──
    const expPre = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const bankPre = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(expPre.balance)).not.toBe(Number(initialExpense.balance));
    expect(Number(bankPre.balance)).not.toBe(Number(initialBank.balance));

    // ── Revert (successful) ──
    const result = await revertApplyRecord(company.id, recordId, user.id);
    expect(result.status).toBe('reverted');

    // RuleApplyRecord reverted.
    const recordPost = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(recordPost.state).toBe('reverted');

    // Journal void.
    const journalPost = await db.journalEntry.findUniqueOrThrow({ where: { id: journalId } });
    expect(journalPost.status).toBe('void');

    // Links: journalEntryId -> null proves the rollback cleared the accounting
    // link. journalLineId is NOT set by the apply-all engine (only the
    // fuzzy-match audit link route populates it), so it is already null in
    // this path — its assertion is a contract consistency check, not rollback
    // evidence.
    const txPost = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(txPost.journalEntryId).toBeNull();
    expect(txPost.journalLineId).toBeNull();
    // Classification cleared per contract.
    expect(txPost.glAccountId).toBeNull();
    expect(txPost.matchedRuleId).toBeNull();
    
    // EXPLICIT DESIGN DECISION:
    // The rollback preserves the FK to the reverted RuleApplyRecord (ruleApplyRecordId)
    // to maintain the historic lineage of this transaction, until a new apply overwrites it.
    // This is a deliberate single-table model decision to avoid orphaned records, NOT a bug.
    expect(txPost.ruleApplyRecordId).toBe(recordId);

    // ── Snapshot 3: Reverted state (Balances must return to initial snapshot & match aggregate of posted lines) ──
    const expPost = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const bankPost = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(expPost.balance)).toBe(Number(initialExpense.balance));
    expect(Number(bankPost.balance)).toBe(Number(initialBank.balance));

    for (const glId of [expenseGl.id, bankGl.id]) {
      const posted = await db.journalLine.aggregate({
        where: { glAccountId: glId, entry: { status: 'posted' } },
        _sum: { debit: true, credit: true },
      });
      const gl = await db.glAccount.findUniqueOrThrow({ where: { id: glId } });
      const recomputed =
        gl.normalBalance === 'debit'
          ? Number(posted._sum.debit || 0) - Number(posted._sum.credit || 0)
          : Number(posted._sum.credit || 0) - Number(posted._sum.debit || 0);
      expect(Number(gl.balance)).toBe(recomputed);
    }

    // Exactly one RULE_REVERTED audit, filtered precisely.
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

    // No partial effects: exactly one record, journals unchanged count (still 1, now void),
    // two journal lines retained (no orphans).
    const records = await db.ruleApplyRecord.findMany({ where: { companyId: company.id } });
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('reverted');
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(1);
    expect(
      await db.journalLine.count({ where: { entry: { companyId: company.id } } }),
    ).toBe(2);
    expect(
      await db.journalEntry.count({
        where: { companyId: company.id, ruleApplyRecordId: null },
      }),
    ).toBe(0);
  });
});