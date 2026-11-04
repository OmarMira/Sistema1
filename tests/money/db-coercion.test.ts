import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db, withCompanyBackupTransaction } from '@/lib/db';
import { clearDatabase, createTestCompany } from '../helpers/factories';
import { MAX_SAFE_CENTS, fromCents, sumCents, toCents, toMoneyNumber } from '@/lib/money';

/**
 * S2 — the db.ts result layer must coerce Decimal money to `number` EXACTLY:
 * Decimal → integer cents (exact, via the money module) → number, with a loud
 * RangeError when the magnitude exceeds ±(2^53 − 1) cents.
 *
 * Fixtures store the adversarial values as raw Decimal strings so Postgres
 * Decimal(18,2) holds exactly 0.10 / 0.20 / 33.33 …, never a float artifact.
 */

describe('S2 — db.ts result coercion is exact at cent level', () => {
  /**
   * The coercion guard is a `compute` function, and Prisma materializes computed
   * result fields lazily: the thrown RangeError surfaces when a consumer reads
   * the money field (or serializes the row), not when the query resolves.
   */
  function captureAccessFailure(read: () => unknown): unknown {
    try {
      read();
      return null;
    } catch (error) {
      return error;
    }
  }

  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('coerces glAccount.balance from adversarial Decimal strings to exact numbers', async () => {
    const company = await createTestCompany('S2 Coercion Co');

    const rows = await Promise.all([
      db.glAccount.create({
        data: { companyId: company.id, code: '1101', name: 'Caja', accountType: 'asset', normalBalance: 'debit', balance: '0.10' },
      }),
      db.glAccount.create({
        data: { companyId: company.id, code: '1102', name: 'Banco', accountType: 'asset', normalBalance: 'debit', balance: '0.20' },
      }),
      db.glAccount.create({
        data: { companyId: company.id, code: '1103', name: 'Caja chica', accountType: 'asset', normalBalance: 'debit', balance: '-0.30' },
      }),
    ]);

    // Every returned field is already a plain number (the result-layer contract).
    for (const row of rows) expect(typeof row.balance).toBe('number');
    expect(rows[0].balance).toBe(0.1);
    expect(rows[1].balance).toBe(0.2);
    expect(rows[2].balance).toBe(-0.3);

    const found = await db.glAccount.findMany({
      where: { companyId: company.id },
      select: { code: true, balance: true },
      orderBy: { code: 'asc' },
    });
    expect(found.map((r) => r.code)).toEqual(['1101', '1102', '1103']);
    expect(found.map((r) => r.balance)).toEqual([0.1, 0.2, -0.3]);
    // Cents arithmetic over the coerced numbers is exact: 10 + 20 - 30 = 0.
    expect(sumCents(...found.map((r) => toCents(r.balance)))).toBe(0);
  });

  it('coerces journalLine debit/credit so a 33.33 + 33.33 + 33.34 post balances to 10000 cents', async () => {
    const company = await createTestCompany('S2 Journal Co');
    const asset = await db.glAccount.create({
      data: { companyId: company.id, code: '1100', name: 'Caja', accountType: 'asset', normalBalance: 'debit' },
    });
    const equity = await db.glAccount.create({
      data: { companyId: company.id, code: '3100', name: 'Capital', accountType: 'equity', normalBalance: 'credit' },
    });

    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'S2 exact post',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: asset.id, debit: '33.33', credit: '0.00' },
            { glAccountId: asset.id, debit: '33.33', credit: '0.00' },
            { glAccountId: asset.id, debit: '33.34', credit: '0.00' },
            { glAccountId: equity.id, debit: '0.00', credit: '100.00' },
          ],
        },
      },
    });

    const lines = await db.journalLine.findMany({ where: { entryId: entry.id } });
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(typeof line.debit).toBe('number');
      expect(typeof line.credit).toBe('number');
    }
    const debitCents = sumCents(...lines.map((l) => toCents(l.debit)));
    const creditCents = sumCents(...lines.map((l) => toCents(l.credit)));
    expect(debitCents).toBe(10000);
    expect(creditCents).toBe(10000);
    expect(debitCents - creditCents).toBe(0);
  });

  it('coerces bankTransaction.amount with mixed signs exactly', async () => {
    const company = await createTestCompany('S2 Bank Co');
    const gl = await db.glAccount.create({
      data: { companyId: company.id, code: '1100', name: 'Caja', accountType: 'asset', normalBalance: 'debit' },
    });
    const bankAccount = await db.bankAccount.create({
      data: {
        companyId: company.id,
        accountName: 'Banco',
        bankName: 'Test Bank',
        glAccountId: gl.id,
        balance: '0.10',
        initialBalance: '0.20',
      },
    });
    expect(bankAccount.balance).toBe(0.1);
    expect(bankAccount.initialBalance).toBe(0.2);

    const statement = await db.bankStatement.create({
      data: {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        startDate: new Date('2025-03-01'),
        endDate: new Date('2025-03-31'),
        openingBalance: '0.10',
        closingBalance: '0.20',
        totalCredits: '0.20',
        totalDebits: '0.10',
        format: 'pdf',
        fileName: 's2.pdf',
      },
    });
    expect(statement.openingBalance).toBe(0.1);
    expect(statement.closingBalance).toBe(0.2);
    expect(statement.totalCredits).toBe(0.2);
    expect(statement.totalDebits).toBe(0.1);

    await db.bankTransaction.create({
      data: { statementId: statement.id, date: new Date('2025-03-05'), description: 'Out', amount: '-0.10' },
    });
    await db.bankTransaction.create({
      data: { statementId: statement.id, date: new Date('2025-03-06'), description: 'In', amount: '0.20' },
    });

    const txs = await db.bankTransaction.findMany({ where: { statementId: statement.id }, orderBy: { date: 'asc' } });
    expect(txs.map((t) => t.amount)).toEqual([-0.1, 0.2]);
    expect(sumCents(...txs.map((t) => toCents(t.amount)))).toBe(10);
    expect(fromCents(sumCents(...txs.map((t) => toCents(t.amount))))).toBe(0.1);
  });

  it('PRESERVE: typical amounts coerce to the same numbers as before (Number(decimal))', async () => {
    const company = await createTestCompany('S2 Preserve Co');
    const amounts = ['1234.56', '250.50', '0.01', '999999.99', '-99.99', '0.00'];
    for (const [index, amount] of amounts.entries()) {
      const row = await db.glAccount.create({
        data: {
          companyId: company.id,
          code: `12${String(index).padStart(2, '0')}`,
          name: `Cuenta ${index}`,
          accountType: 'asset',
          normalBalance: 'debit',
          balance: amount,
        },
      });
      // Old behavior: Number(Prisma.Decimal) — identical for every valid amount.
      expect(row.balance).toBe(Number(amount));
      expect(toCents(row.balance)).toBe(toCents(amount));
      expect(toMoneyNumber(new Prisma.Decimal(amount))).toBe(row.balance);
    }
  });

  it('fails loudly when a stored magnitude exceeds 2^53-1 cents', async () => {
    const company = await createTestCompany('S2 Range Co');
    // Written through the raw backup capability: the extended client cannot
    // create such a row because mapping the response already guards the value.
    const created = await withCompanyBackupTransaction((tx) =>
      tx.glAccount.create({
        data: {
          companyId: company.id,
          code: '1999',
          name: 'Magnitud imposible',
          accountType: 'asset',
          normalBalance: 'debit',
          balance: new Prisma.Decimal('90071992547409.92'),
        },
      }),
    );
    // Raw Decimal results, never a silent number.
    expect(typeof created.balance).not.toBe('number');

    const row = await db.glAccount.findUniqueOrThrow({ where: { id: created.id } });
    const single = captureAccessFailure(() => row.balance);
    expect(single).toBeInstanceOf(RangeError);
    expect((single as Error).message).toMatch(/9007199254740991/);
    expect((single as Error).message).toMatch(/MAX_SAFE_INTEGER/);

    const rows = await db.glAccount.findMany({ where: { companyId: company.id, code: '1999' } });
    expect(captureAccessFailure(() => rows[0].balance)).toBeInstanceOf(RangeError);
    // Any API response that serializes the row fails loudly instead of drifting.
    expect(captureAccessFailure(() => JSON.stringify(rows))).toBeInstanceOf(RangeError);
  });

  it('keeps very large but realistic magnitudes exact ($11.26 trillion)', async () => {
    const company = await createTestCompany('S2 Boundary Co');
    // 2^50 cents = $11,258,999,068,426.24 — huge, yet still round-trips in a double.
    const row = await db.glAccount.create({
      data: {
        companyId: company.id,
        code: '1998',
        name: 'Magnitud grande',
        accountType: 'asset',
        normalBalance: 'debit',
        balance: '11258999068426.24',
      },
    });
    expect(typeof row.balance).toBe('number');
    expect(row.balance).toBe(Number('11258999068426.24'));
    expect(toCents(row.balance)).toBe(2 ** 50);
    expect(toCents(row.balance)).toBeLessThanOrEqual(MAX_SAFE_CENTS);
  });

  /**
   * S2 characterization — aggregate()/groupBy() do NOT pass through the
   * `result` overrides in db.ts: Prisma applies result extensions to model
   * results (find, create, update), not to aggregate buckets. `_sum.amount`
   * therefore stays a Decimal and every consumer must normalize it explicitly
   * (see the bypass list in src/lib/db.ts and the S3 follow-up task).
   */
  it('CHARACTERIZATION: aggregate _sum bypasses the result layer (Decimal out)', async () => {
    const company = await createTestCompany('S2 Aggregate Co');
    const gl = await db.glAccount.create({
      data: { companyId: company.id, code: '1100', name: 'Caja', accountType: 'asset', normalBalance: 'debit' },
    });
    const bankAccount = await db.bankAccount.create({
      data: { companyId: company.id, accountName: 'Banco', bankName: 'Test Bank', glAccountId: gl.id },
    });
    const statement = await db.bankStatement.create({
      data: {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        startDate: new Date('2025-04-01'),
        endDate: new Date('2025-04-30'),
        openingBalance: '0.00',
        closingBalance: '0.30',
        format: 'pdf',
        fileName: 's2-aggregate.pdf',
      },
    });
    for (const amount of ['0.10', '0.20']) {
      await db.bankTransaction.create({
        data: { statementId: statement.id, date: new Date('2025-04-02'), description: 'In', amount },
      });
    }

    const aggregate = await db.bankTransaction.aggregate({
      where: { statementId: statement.id },
      _sum: { amount: true },
    });
    // Bypass: not a plain number; still a Decimal. Consumers must convert.
    expect(typeof aggregate._sum.amount).not.toBe('number');
    expect(toCents(aggregate._sum.amount as unknown as Prisma.Decimal)).toBe(30);

    const grouped = await db.$transaction(async (tx) =>
      tx.bankTransaction.groupBy({
        by: ['statementId'],
        where: { statementId: statement.id },
        _sum: { amount: true },
      }),
    );
    expect(typeof grouped[0]._sum.amount).not.toBe('number');
    expect(toCents(grouped[0]._sum.amount as unknown as Prisma.Decimal)).toBe(30);
  });
});
