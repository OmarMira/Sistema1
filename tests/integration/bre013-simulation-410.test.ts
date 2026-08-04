import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { simulateApply } from '@/lib/services/rule-simulation.service';
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

describe('4.10 - simulateApply integration (no side effects, accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('forecasts a match but persists nothing (no record, journal, line, balance, tx change)', async () => {
    const user = await createTestUser('sim49@example.com');
    const company = await createTestCompany('Sim 4.10');
    await createTestCompanyMember(user.id, company.id);

    const expenseGl = await createTestGlAccount({
      companyId: company.id,
      code: '6001',
      name: 'Sim Expense',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    const bankGl = await createTestGlAccount({
      companyId: company.id,
      code: '1001',
      name: 'Sim Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const bankAccount = await createTestBankAccount(company.id, bankGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-20',
      amount: 250,
      description: 'SIM ORDER 900',
    });

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Sim Rule',
        conditionType: 'contains',
        conditionValue: 'SIM',
        transactionDirection: 'any',
        glAccountId: expenseGl.id,
        priority: 1,
        isActive: true,
      },
    });

    // Baseline counts.
    const recordsBefore = await db.ruleApplyRecord.count({ where: { companyId: company.id } });
    const journalsBefore = await db.journalEntry.count({ where: { companyId: company.id } });
    const linesBefore = await db.journalLine.count({ where: { entry: { companyId: company.id } } });
    const txBefore = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    const expenseBefore = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });

    // Run the forecast twice to prove determinism + read-only.
    const first = await simulateApply(company.id, { limit: 200 });
    const second = await simulateApply(company.id, { limit: 200 });

    expect(first.readOnly).toBe(true);
    expect(first.recordCreated).toBe(false);
    expect(first.ledgerAccuracyNotGuaranteed).toBe(true);
    expect(first.matchResult.totalCount).toBe(1);
    expect(first.matchResult.matchedRules[0].txIds).toEqual([tx.id]);

    // Deterministic: same forecast both runs.
    expect(second.matchResult.totalCount).toBe(first.matchResult.totalCount);
    expect(second.matchResult.matchedRules[0].txIds).toEqual(first.matchResult.matchedRules[0].txIds);

    // NO side effects.
    expect(await db.ruleApplyRecord.count({ where: { companyId: company.id } })).toBe(recordsBefore);
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(journalsBefore);
    expect(await db.journalLine.count({ where: { entry: { companyId: company.id } } })).toBe(linesBefore);

    const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txAfter.glAccountId).toBeNull();
    expect(txAfter.matchedRuleId).toBeNull();
    expect(txAfter.ruleApplyRecordId).toBeNull();
    expect(txAfter.journalEntryId).toBeNull();
    expect(txAfter.journalLineId).toBeNull();

    const expenseAfter = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    expect(Number(expenseAfter.balance)).toBe(Number(expenseBefore.balance));

    // No audit events written by the simulation.
    expect(await db.auditLog.count({ where: { companyId: company.id } })).toBe(0);
  });
});