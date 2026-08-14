import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';

// G6/F6 contract: the blanket $allModels.$allOperations Decimal→Number
// conversion is REMOVED. Instance fields keep their explicit `result`
// overrides (number), while aggregate/groupBy results are no longer coerced
// (Prisma.Decimal). Consumers that depend on numbers must normalize explicitly.
describe('G6 — decimal contract: no blanket Decimal→Number conversion', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('instance fields from result overrides are still numbers (findMany)', async () => {
    const user = await createTestUser('g6-a@example.com');
    const company = await createTestCompany('G6 A');
    await createTestCompanyMember(user.id, company.id);
    const gl = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash', normalBalance: 'debit' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 123.45,
      description: 'G6 contract',
    });

    const tx = await db.bankTransaction.findFirst({ where: { description: 'G6 contract' } });
    expect(tx).not.toBeNull();
    expect(typeof tx!.amount).toBe('number');
    expect(tx!.amount).toBe(123.45);

    const acc = await db.bankAccount.findUnique({ where: { id: bankAccount.id } });
    expect(acc).not.toBeNull();
    expect(typeof acc!.balance).toBe('number');
    expect(typeof acc!.initialBalance).toBe('number');
  });

  it('aggregate _sum is NO LONGER coerced: returns Prisma.Decimal (blanket removed)', async () => {
    const user = await createTestUser('g6-b@example.com');
    const company = await createTestCompany('G6 B');
    await createTestCompanyMember(user.id, company.id);
    const gl = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash', normalBalance: 'debit' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-10',
      amount: 100,
      description: 'TX-1',
    });
    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-11',
      amount: 23.45,
      description: 'TX-2',
    });

    const agg = await db.bankTransaction.aggregate({
      _sum: { amount: true },
      where: { statementId: statement.id },
    });

    expect(agg._sum.amount).toBeInstanceOf(Prisma.Decimal);
    expect(Number(agg._sum.amount ?? 0)).toBe(123.45);
  });

  it('journal entry line debits/credits keep number contract and normalize via Number()', async () => {
    const user = await createTestUser('g6-c@example.com');
    const company = await createTestCompany('G6 C');
    await createTestCompanyMember(user.id, company.id);
    const gl1 = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash', normalBalance: 'debit' });
    const gl2 = await createTestGlAccount({ companyId: company.id, code: '6000', name: 'Expense', normalBalance: 'debit' });
    await createTestJournalEntry(company.id, {
      date: '2025-03-31',
      description: 'G6 journal',
      lines: [
        { glAccountId: gl1.id, debit: 500, credit: 0, description: 'd' },
        { glAccountId: gl2.id, debit: 0, credit: 500, description: 'c' },
      ],
    });

    const entry = await db.journalEntry.findFirst({ where: { description: 'G6 journal' }, include: { lines: true } });
    expect(entry).not.toBeNull();
    for (const line of entry!.lines) {
      expect(typeof line.debit).toBe('number');
      expect(typeof line.credit).toBe('number');
    }
  });
});
