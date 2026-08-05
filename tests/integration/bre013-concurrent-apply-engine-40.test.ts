import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { executeApplyAll, matchTransactions } from '@/lib/services/apply-all-engine';
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
import { orchestrateConcurrentRace } from '../helpers/concurrency';

async function seedDisputedRow() {
  const user = await createTestUser('concurrent-a@example.com');
  const company = await createTestCompany('Concurrent A');
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

  const transaction = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-06-15',
    amount: 100,
    description: 'TEST EXPENSE',
  });

  const rule = await db.bankRule.create({
    data: {
      companyId: company.id,
      name: 'Concurrent Rule',
      conditionType: 'contains',
      conditionValue: 'TEST',
      transactionDirection: 'any',
      glAccountId: expenseGl.id,
      priority: 10,
      isActive: true,
    },
  });

  return { user, company, expenseGl, bankGl, transaction, rule };
}

describe('BRE-013 5.0 - Deterministic concurrent apply (engine) — single disputed BankTransaction', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('two concurrent executeApplyAll calls produce exactly ONE legit apply record, ONE journal with two lines, and no spurious record', async () => {
    const { user, company, expenseGl, transaction, rule } = await seedDisputedRow();

    // A single shared matchResult computed BEFORE the race.
    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(1);
    expect(matchResult.matchedRules[0].txIds).toContain(transaction.id);

    const ctx = { userId: user.id, origin: 'batch' as const };

    await orchestrateConcurrentRace(
      (tx) => executeApplyAll(company.id, tx, matchResult, ctx),
      (tx) => executeApplyAll(company.id, tx, matchResult, ctx),
      { transactionId: transaction.id, timeoutMs: 4000 },
    );

    // ── Invariants ──────────────────────────────────────────────
    // 1. Exactly ONE durable apply record (no spurious/empty loser record).
    const records = await db.ruleApplyRecord.findMany({ where: { companyId: company.id } });
    expect(records).toHaveLength(1);

    const record = records[0];

    // 2. Single effective classification on the disputed row.
    const row = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(row.glAccountId).toBe(expenseGl.id);
    expect(row.matchedRuleId).toBe(rule.id);

    // 3. ruleApplyRecordId points to the single legit record (loser did not overwrite).
    expect(row.ruleApplyRecordId).toBe(record.id);

    // 4. Exactly one journal owned by that record, with exactly two lines.
    const journals = await db.journalEntry.findMany({ where: { ruleApplyRecordId: record.id } });
    expect(journals).toHaveLength(1);
    const lines = await db.journalLine.count({ where: { entryId: journals[0].id } });
    expect(lines).toBe(2);

    // 5. No ruleApplyRecord carries a journal count implying a fabricated apply.
    const totalJournals = await db.journalEntry.count({ where: { companyId: company.id } });
    expect(totalJournals).toBe(1);
  }, 60000);
});