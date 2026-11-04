import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { toCents, toMoneyNumber } from '@/lib/money';
import { recalculateBankAccountBalance } from '@/lib/reconciliation';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
} from '../helpers/factories';

/**
 * S3 — the remaining Decimal→number coercions at the aggregate boundary.
 *
 * `src/lib/reconciliation.ts` (bank account balance from reconciled amounts)
 * and the ai-assistant aggregate tool both receive Prisma.Decimal from
 * `aggregate()` and now normalize through src/lib/money.ts. For every valid
 * 2-decimal amount `toMoneyNumber(decimal)` is the same number `Number(decimal)`
 * returned, so these cases lock the equivalence instead of a value change; the
 * only behavioral difference is that an out-of-safe-range magnitude fails loudly
 * instead of returning a drifted number (that guard is covered in tests/money).
 */

async function seedScene(email: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(`W4 ${email}`);
  await createTestCompanyMember(user.id, company.id);
  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Bank',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bank = await createTestBankAccount(company.id, bankGl.id);
  const statement = await createTestBankStatement(company.id, bank.id);
  return { user, company, bankGl, bank, statement };
}

async function reconcile(statementId: string, amount: number, date: string) {
  const tx = await createTestBankTransaction(
    (await db.bankStatement.findUniqueOrThrow({ where: { id: statementId } })).companyId,
    statementId,
    { date, amount, description: 'Deposit' },
  );
  await db.bankTransaction.update({ where: { id: tx.id }, data: { isReconciled: true } });
  return tx;
}

describe('S3 — recalculateBankAccountBalance normalizes the aggregate through money.ts', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('stores the reconciled total as an exact cent value (0.10 + 0.20)', async () => {
    const { bank, statement } = await seedScene('w4-recon-balance@example.com');
    await reconcile(statement.id, 0.1, '2025-03-05');
    await reconcile(statement.id, 0.2, '2025-03-06');

    await recalculateBankAccountBalance(bank.id);

    const row = await db.bankAccount.findUniqueOrThrow({ where: { id: bank.id } });
    expect(toCents(row.balance)).toBe(30);
    expect(row.balance).toBe(0.3);
    // Only the reconciled sum changes; the opening figures are untouched.
    expect(toCents(row.initialBalance)).toBe(100_000);
  });

  it('stores an exact multi-thousand-row style total without drift', async () => {
    const { bank, statement } = await seedScene('w4-recon-balance-1000@example.com');
    for (let i = 0; i < 40; i++) {
      await reconcile(statement.id, i % 2 === 0 ? 0.3 : 0.7, '2025-03-05');
    }

    await recalculateBankAccountBalance(bank.id);

    const row = await db.bankAccount.findUniqueOrThrow({ where: { id: bank.id } });
    // 20 × 0.30 + 20 × 0.70 = 20.00
    expect(toCents(row.balance)).toBe(2000);
    expect(row.balance).toBe(20);
  });

  it('PRESERVE: an account with no reconciled transactions is zeroed, not left stale', async () => {
    const { bank, statement } = await seedScene('w4-recon-balance-empty@example.com');
    const unreconciled = await createTestBankTransaction(
      (await db.bankStatement.findUniqueOrThrow({ where: { id: statement.id } })).companyId,
      statement.id,
      { date: '2025-03-05', amount: 55, description: 'Pending' },
    );
    expect(unreconciled.isReconciled).toBe(false);

    await recalculateBankAccountBalance(bank.id);

    const row = await db.bankAccount.findUniqueOrThrow({ where: { id: bank.id } });
    expect(row.balance).toBe(0);
  });
});

describe('S3 — aggregate Decimal coercion agrees with the previous Number() value', () => {
  it('toMoneyNumber(decimal) === Number(decimal) for cent-granular amounts', () => {
    for (const text of ['0.30', '-0.30', '0.10', '0.20', '1234.56', '-9876.54', '0.00', '45000000000000.01']) {
      const decimal = new Prisma.Decimal(text);
      expect(toMoneyNumber(decimal)).toBe(Number(decimal));
      expect(toCents(toMoneyNumber(decimal))).toBe(toCents(decimal));
    }
  });
});
