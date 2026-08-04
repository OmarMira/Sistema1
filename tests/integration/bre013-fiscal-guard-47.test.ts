import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { executeApplyAll, matchTransactions } from '@/lib/services/apply-all-engine';
import { revertApplyRecord } from '@/lib/services/rollback-apply.service';
import { ForbiddenError } from '@/lib/api-error';
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

async function seedScenario(prefix: string, email: string, companyName: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(companyName);
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

  const rule = await db.bankRule.create({
    data: {
      companyId: company.id,
      name: `${prefix} Rule`,
      conditionType: 'contains',
      conditionValue: 'TEST',
      transactionDirection: 'any',
      glAccountId: expenseGl.id,
      priority: 10,
      isActive: true,
    },
  });

  return { user, company, expenseGl, bankGl, statement, rule };
}

async function createFiscalPeriod(
  companyId: string,
  name: string,
  startDate: string,
  endDate: string,
  isLocked: boolean,
) {
  return db.fiscalPeriod.create({
    data: { companyId, name, startDate: new Date(startDate), endDate: new Date(endDate), isLocked },
  });
}

describe('4.7 - Per-transaction fiscal guard: two-period batch, one locked (integration, accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('apply aborts wholly when one of the two targeted transactions falls in a locked period', async () => {
    const { user, company, expenseGl, bankGl, statement, rule } = await seedScenario(
      'GuardApply', 'guardapply47@example.com', 'Guard Apply 4.7',
    );

    // Two periods: June open, July locked.
    await createFiscalPeriod(company.id, '2025-06', '2025-06-01', '2025-06-30', false);
    await createFiscalPeriod(company.id, '2025-07', '2025-07-01', '2025-07-31', true);

    const openTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST JUNE',
    });
    const lockedTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-07-15',
      amount: 200,
      description: 'TEST JULY',
    });

    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(2);
    expect(matchResult.matchedRules[0].txIds.sort()).toEqual([lockedTx.id, openTx.id].sort());

    const initialExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const initialBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    const initialAuditCount = await db.auditLog.count({ where: { companyId: company.id } });

    let thrown: unknown;
    await db.$transaction(async (tx) => {
      try {
        await executeApplyAll(company.id, tx, matchResult, { userId: user.id, origin: 'batch' });
      } catch (error) {
        thrown = error;
        throw error;
      }
    }).catch((error) => {
      thrown = error;
    });

    // The guard throws ForbiddenError for the locked-period transaction.
    expect(thrown).toBeInstanceOf(ForbiddenError);
    // Pin the CAUSE: the rejection must come from the fiscal guard, not another
    // ForbiddenError (permissions, company, user, etc.). code === 'FORBIDDEN'
    // narrows the error class; the message confirms the locked period.
    const guardError = thrown as ForbiddenError;
    expect(guardError.code).toBe('FORBIDDEN');
    expect(guardError.message).toContain('closed period');
    expect(guardError.message).toContain('2025-07');

    // Whole abort: no record, no journal, no line.
    expect(await db.ruleApplyRecord.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.journalLine.count({ where: { entry: { companyId: company.id } } })).toBe(0);

    // No partial classification on EITHER transaction (the open one included).
    for (const txId of [openTx.id, lockedTx.id]) {
      const tx = await db.bankTransaction.findUniqueOrThrow({ where: { id: txId } });
      expect(tx.glAccountId).toBeNull();
      expect(tx.matchedRuleId).toBeNull();
      expect(tx.journalEntryId).toBeNull();
      expect(tx.ruleApplyRecordId).toBeNull();
    }

    // Balances unchanged.
    const expenseAfter = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const bankAfter = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(expenseAfter.balance)).toBe(Number(initialExpense.balance));
    expect(Number(bankAfter.balance)).toBe(Number(initialBank.balance));

    // No audit appended by the aborted run.
    const auditAfter = await db.auditLog.count({ where: { companyId: company.id } });
    expect(auditAfter).toBe(initialAuditCount);
  });

  it('revert rejects the whole operation when any affected transaction falls in a locked period', async () => {
    const { user, company, expenseGl, bankGl, statement, rule } = await seedScenario(
      'GuardRevert', 'guardrevert47@example.com', 'Guard Revert 4.7',
    );

    // Single open period for the successful apply.
    await createFiscalPeriod(company.id, '2025-06', '2025-06-01', '2025-06-30', false);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE',
    });

    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(1);

    const applied = await db.$transaction(async (ptx) =>
      executeApplyAll(company.id, ptx, matchResult, { userId: user.id, origin: 'batch' }),
    );
    expect(applied.applyRecordId).toBeTruthy();
    expect(applied.journalEntryCount).toBe(1);
    const recordId = applied.applyRecordId!;

    const journal = await db.journalEntry.findFirstOrThrow({ where: { ruleApplyRecordId: recordId } });
    const journalId = journal.id;
    expect(journal.status).toBe('posted');

    const appliedExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const appliedBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(appliedExpense.balance)).not.toBe(0);
    expect(Number(appliedBank.balance)).not.toBe(0);

    // ── Now lock the period that contains the affected transaction ──
    await db.fiscalPeriod.updateMany({
      where: { companyId: company.id, name: '2025-06' },
      data: { isLocked: true },
    });

    let thrown: unknown;
    await revertApplyRecord(company.id, recordId, user.id).catch((error) => {
      thrown = error;
    });
    expect(thrown).toBeInstanceOf(ForbiddenError);
    // Pin the CAUSE: the rejection must come from the fiscal guard, not another
    // ForbiddenError. The revert guard (rollback-apply.service.ts) raises this
    // for the locked period before touching any journal.
    const revertGuardError = thrown as ForbiddenError;
    expect(revertGuardError.code).toBe('FORBIDDEN');
    expect(revertGuardError.message).toContain('closed period');

    // Whole abort: record stays applied, journal stays posted, links intact.
    const recordAfter = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(recordAfter.state).toBe('applied');

    const journalAfter = await db.journalEntry.findUniqueOrThrow({ where: { id: journalId } });
    expect(journalAfter.status).toBe('posted');

    const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txAfter.ruleApplyRecordId).toBe(recordId);
    expect(txAfter.glAccountId).toBe(expenseGl.id);
    expect(txAfter.matchedRuleId).toBe(rule.id);
    expect(txAfter.journalEntryId).toBe(journalId);

    // Balances identical to the applied snapshot (no partial recalc).
    const expenseAfter = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const bankAfter = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(expenseAfter.balance)).toBe(Number(appliedExpense.balance));
    expect(Number(bankAfter.balance)).toBe(Number(appliedBank.balance));

    // No RULE_REVERTED audit, no partial effects.
    const revertAudits = await db.auditLog.count({
      where: { companyId: company.id, action: 'RULE_REVERTED', entityId: recordId },
    });
    expect(revertAudits).toBe(0);
  });
});