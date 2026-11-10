import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
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

const DUP_IDEMPOTENCY_KEY = 'dup-key-4.4';
const NONEXISTENT_USER_ID = 'nonexistent-user-4.5';

async function seedJournaledScenario() {
  const user = await createTestUser('atomic44@example.com');
  const company = await createTestCompany('Atomic 4.4');
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
      name: 'Atomic Rule',
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

describe('4.4 - Apply atomicity on duplicate idempotencyKey (engine integration, accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('P2002 on RuleApplyRecord.create rolls back classification, journal, lines, links, and balances', async () => {
    const { user, company, expenseGl, bankGl, transaction, rule } = await seedJournaledScenario();

    // Pre-existing record that consumes the idempotency key we will reuse.
    await db.ruleApplyRecord.create({
      data: {
        companyId: company.id,
        origin: 'batch',
        userId: user.id,
        state: 'applied',
        idempotencyKey: DUP_IDEMPOTENCY_KEY,
      },
    });

    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(1);
    expect(matchResult.matchedRules[0].txIds).toContain(transaction.id);

    const initialExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const initialBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    const initialAuditCount = await db.auditLog.count({ where: { companyId: company.id } });

    let thrown: unknown;
    await db.$transaction(async (tx) => {
      try {
        await executeApplyAll(company.id, tx, matchResult, {
          userId: user.id,
          origin: 'batch',
          idempotencyKey: DUP_IDEMPOTENCY_KEY,
        });
      } catch (error) {
        thrown = error;
        throw error;
      }
    }).catch((error) => {
      thrown = error;
    });

    expect(thrown).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((thrown as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

    // Classification unchanged.
    const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(txAfter.glAccountId).toBeNull();
    expect(txAfter.matchedRuleId).toBeNull();
    expect(txAfter.journalEntryId).toBeNull();
    expect(txAfter.journalLineId).toBeNull();
    expect(txAfter.ruleApplyRecordId).toBeNull();

    // Zero journals and zero lines.
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.journalLine.count({ where: { entry: { companyId: company.id } } })).toBe(0);

    // Balances identical to initial.
    const expenseAfter = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const bankAfter = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(expenseAfter.balance)).toBe(Number(initialExpense.balance));
    expect(Number(bankAfter.balance)).toBe(Number(initialBank.balance));

    // Only the pre-existing rule apply record remains; no new audit log for the failed run.
    const records = await db.ruleApplyRecord.findMany({ where: { companyId: company.id } });
    expect(records).toHaveLength(1);
    expect(records[0].idempotencyKey).toBe(DUP_IDEMPOTENCY_KEY);
    expect(records[0].state).toBe('applied');

    const auditAfter = await db.auditLog.count({ where: { companyId: company.id } });
    expect(auditAfter).toBe(initialAuditCount);
  });
});

//
// 4.5 - removed: it asserted a rollback triggered by a nonexistent AuditLog.userId,
// which depended on the AuditLog foreign key to User. Migration
// 20261109010000_immutable_audit_user_reference removed every AuditLog foreign key on
// purpose (retained history must survive user deletion), so that failure can never
// occur and the premise is gone. The replacement coverage for audit-write rollback
// must inject a real database failure instead; tracked in docs/backup-consolidation-record.md.
//
