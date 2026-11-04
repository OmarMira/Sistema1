/**
 * Wave 6 — T4 (S3). String -> Prisma enum for six columns:
 *   Company.entityType, GlAccount.accountType, GlAccount.normalBalance,
 *   BankTransaction.status, JournalEntry.status, ReconciliationPeriod.status.
 *
 * The migration is ADDITIVE: every enum label is the exact string the column
 * already stored, so no row is rewritten and no API payload changes (Prisma
 * serialises an enum to its string value). This file proves that claim end to
 * end, in this order:
 *
 *  1. STRUCTURE — the database really stores the six columns as PostgreSQL
 *     enums, each with exactly the historical label set in declaration order.
 *  2. ROUNDTRIP — every label of every enum can be written and read back through
 *     the Prisma client as the same string, and the historical defaults still
 *     apply when the field is omitted.
 *  3. REJECTION — a value outside the enum is refused by the Prisma client
 *     before it reaches the database, and refused by the database itself.
 *  4. NO DRIFT — rules/account-types.json and the CHART_OF_ACCOUNTS seed only
 *     use labels the enum accepts.
 *  5. PRESERVE — the pre-existing POST/GET /api/accounts contract is unchanged:
 *     same accepted values, same 400 message, and an unknown `?accountType=`
 *     filter still answers 200 with an empty list instead of a query error.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  BankTransactionStatus,
  CompanyEntityType,
  GlAccountAccountType,
  GlAccountNormalBalance,
  JournalEntryStatus,
  Prisma,
  ReconciliationPeriodStatus,
} from '@prisma/client';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { CHART_OF_ACCOUNTS } from '@/lib/chart-of-accounts';
import { readJsonConfig } from '@/lib/config-loader';
import { GET as accountsGET, POST as accountsPOST } from '@/app/api/accounts/route';
import {
  clearDatabase,
  createTestBankAccount,
  createTestBankStatement,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestUser,
} from '../helpers/factories';

/**
 * The exact label lists the migration creates. `enumsortorder` is asserted, so a
 * reordering or a silently added/removed label fails here.
 */
const EXPECTED_LABELS = {
  CompanyEntityType: ['INDIVIDUAL', 'BUSINESS'],
  GlAccountAccountType: ['asset', 'liability', 'equity', 'revenue', 'expense'],
  GlAccountNormalBalance: ['debit', 'credit'],
  BankTransactionStatus: ['unreviewed', 'pending_review', 'reconciled', 'ignored', 'posted', 'suspense'],
  JournalEntryStatus: ['draft', 'posted', 'void', 'pending_review'],
  ReconciliationPeriodStatus: ['open', 'completed', 'cancelled'],
} as const;

/** table.column -> the enum type that must own it. */
const ENUM_COLUMNS = [
  { tableName: 'Company', columnName: 'entityType', udt: 'CompanyEntityType' },
  { tableName: 'GlAccount', columnName: 'accountType', udt: 'GlAccountAccountType' },
  { tableName: 'GlAccount', columnName: 'normalBalance', udt: 'GlAccountNormalBalance' },
  { tableName: 'BankTransaction', columnName: 'status', udt: 'BankTransactionStatus' },
  { tableName: 'JournalEntry', columnName: 'status', udt: 'JournalEntryStatus' },
  { tableName: 'ReconciliationPeriod', columnName: 'status', udt: 'ReconciliationPeriodStatus' },
] as const;

async function seedCompany() {
  const user = await createTestUser('wave6-enum@example.com');
  const company = await createTestCompany('Wave6 Enum Co');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

async function seedBanking(companyId: string) {
  const gl = await createTestGlAccount({
    companyId,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await createTestBankAccount(companyId, gl.id, 'Enum Bank');
  const statement = await createTestBankStatement(companyId, bankAccount.id);
  return { glAccountId: gl.id, bankAccountId: bankAccount.id, statementId: statement.id };
}

function accountsRequest(url: string, token: string, init?: RequestInit) {
  return new NextRequest(`http://localhost${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

describe('S3 — String -> enum migration', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // ── 1. STRUCTURE ────────────────────────────────────────────────────
  describe('database structure', () => {
    it('stores all six columns as the declared PostgreSQL enums', async () => {
      const rows = await db.$queryRawUnsafe<
        { table_name: string; column_name: string; udt_name: string }[]
      >(
        `SELECT table_name, column_name, udt_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY(ARRAY['Company','GlAccount','BankTransaction','JournalEntry','ReconciliationPeriod'])
            AND column_name = ANY(ARRAY['entityType','accountType','normalBalance','status'])`,
      );
      const udtByColumn = new Map(
        rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]),
      );

      for (const column of ENUM_COLUMNS) {
        expect(
          udtByColumn.get(`${column.tableName}.${column.columnName}`),
          `${column.tableName}.${column.columnName} must be ${column.udt}`,
        ).toBe(column.udt);
      }
    });

    it('keeps exactly the historical label set, in declaration order', async () => {
      const rows = await db.$queryRawUnsafe<{ typname: string; labels: string[] }[]>(
        `SELECT t.typname AS typname,
                array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = ANY(ARRAY['CompanyEntityType','GlAccountAccountType','GlAccountNormalBalance','BankTransactionStatus','JournalEntryStatus','ReconciliationPeriodStatus'])
          GROUP BY t.typname`,
      );
      const labelsByType = new Map(rows.map((row) => [row.typname, row.labels]));

      for (const [typeName, expected] of Object.entries(EXPECTED_LABELS)) {
        expect(labelsByType.get(typeName), `${typeName} must exist in the database`).toEqual([
          ...expected,
        ]);
      }
    });
  });

  // ── 2. ROUNDTRIP ────────────────────────────────────────────────────
  describe('roundtrip: every label persists as its own string', () => {
    it('Company.entityType accepts both labels and defaults to BUSINESS', async () => {
      for (const entityType of EXPECTED_LABELS.CompanyEntityType) {
        const created = await db.company.create({
          data: { legalName: `Enum ${entityType}`, entityType },
        });
        const read = await db.company.findUniqueOrThrow({ where: { id: created.id } });
        expect(read.entityType).toBe(entityType);
        expect(typeof read.entityType).toBe('string');
      }

      const defaulted = await db.company.create({ data: { legalName: 'Enum Default Co' } });
      const readDefaulted = await db.company.findUniqueOrThrow({ where: { id: defaulted.id } });
      // The text default survived the type change.
      expect(readDefaulted.entityType).toBe('BUSINESS');
    });

    it('GlAccount.accountType and normalBalance accept every label', async () => {
      const { company } = await seedCompany();
      let sequence = 0;

      for (const accountType of EXPECTED_LABELS.GlAccountAccountType) {
        for (const normalBalance of EXPECTED_LABELS.GlAccountNormalBalance) {
          sequence += 1;
          const code = `9${String(sequence).padStart(3, '0')}`;
          const created = await db.glAccount.create({
            data: {
              companyId: company.id,
              code,
              name: `${accountType}/${normalBalance}`,
              accountType,
              normalBalance,
            },
          });
          const read = await db.glAccount.findUniqueOrThrow({ where: { id: created.id } });
          expect(read.accountType).toBe(accountType);
          expect(read.normalBalance).toBe(normalBalance);
          expect(typeof read.accountType).toBe('string');
          expect(typeof read.normalBalance).toBe('string');
        }
      }
    });

    it('BankTransaction.status accepts every label and defaults to posted', async () => {
      const { company } = await seedCompany();
      const { statementId } = await seedBanking(company.id);

      for (const status of EXPECTED_LABELS.BankTransactionStatus) {
        const created = await db.bankTransaction.create({
          data: {
            statementId,
            companyId: company.id,
            date: new Date('2026-05-01'),
            description: `enum ${status}`,
            amount: 10,
            status,
          },
        });
        const read = await db.bankTransaction.findUniqueOrThrow({ where: { id: created.id } });
        expect(read.status).toBe(status);
        expect(typeof read.status).toBe('string');
      }

      const defaulted = await db.bankTransaction.create({
        data: {
          statementId,
          companyId: company.id,
          date: new Date('2026-05-02'),
          description: 'enum default',
          amount: 11,
        },
      });
      expect(defaulted.status).toBe('posted');
    });

    it('JournalEntry.status accepts every label and defaults to draft', async () => {
      const { company } = await seedCompany();

      for (const status of EXPECTED_LABELS.JournalEntryStatus) {
        const created = await db.journalEntry.create({
          data: { companyId: company.id, date: new Date('2026-05-01'), description: `enum ${status}`, status },
        });
        const read = await db.journalEntry.findUniqueOrThrow({ where: { id: created.id } });
        expect(read.status).toBe(status);
        expect(typeof read.status).toBe('string');
      }

      const defaulted = await db.journalEntry.create({
        data: { companyId: company.id, date: new Date('2026-05-02'), description: 'enum default' },
      });
      expect(defaulted.status).toBe('draft');
    });

    it('ReconciliationPeriod.status accepts every label and defaults to open', async () => {
      const { user, company } = await seedCompany();
      const { bankAccountId } = await seedBanking(company.id);

      for (const status of EXPECTED_LABELS.ReconciliationPeriodStatus) {
        const created = await db.reconciliationPeriod.create({
          data: { companyId: company.id, bankAccountId, userId: user.id, status },
        });
        const read = await db.reconciliationPeriod.findUniqueOrThrow({ where: { id: created.id } });
        expect(read.status).toBe(status);
        expect(typeof read.status).toBe('string');
      }

      const defaulted = await db.reconciliationPeriod.create({
        data: { companyId: company.id, bankAccountId, userId: user.id },
      });
      expect(defaulted.status).toBe('open');
    });
  });

  // ── 3. REJECTION ────────────────────────────────────────────────────
  describe('rejection: values outside the enum are refused', () => {
    it('the Prisma client refuses an unknown GlAccount.accountType', async () => {
      const { company } = await seedCompany();
      await expect(
        db.glAccount.create({
          data: {
            companyId: company.id,
            code: '8888',
            name: 'Income (legacy spelling)',
            // `income` is the value the old free-form String column allowed and
            // the enum deliberately does not: the account type is `revenue`.
            accountType: 'income' as never,
            normalBalance: 'credit',
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientValidationError);
    });

    it('the database refuses an unknown BankTransaction.status written past the client', async () => {
      const { company } = await seedCompany();
      const { statementId } = await seedBanking(company.id);
      const tx = await db.bankTransaction.create({
        data: {
          statementId,
          companyId: company.id,
          date: new Date('2026-05-03'),
          description: 'guard',
          amount: 1,
        },
      });

      await expect(
        db.$executeRawUnsafe(
          `UPDATE "BankTransaction" SET "status" = 'bogus' WHERE "id" = $1`,
          tx.id,
        ),
      ).rejects.toThrow();

      const unchanged = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      expect(unchanged.status).toBe('posted');
    });

    it('the database refuses an unknown JournalEntry.status written past the client', async () => {
      const { company } = await seedCompany();
      const entry = await db.journalEntry.create({
        data: { companyId: company.id, date: new Date('2026-05-03'), description: 'guard' },
      });

      await expect(
        db.$executeRawUnsafe(`UPDATE "JournalEntry" SET "status" = 'suspense' WHERE "id" = $1`, entry.id),
      ).rejects.toThrow();

      const unchanged = await db.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(unchanged.status).toBe('draft');
    });

    it('the type system rejects a non-member (compile-time contract)', () => {
      // Runtime no-ops: `expectTypeOf` and `satisfies` are erased. They pin the
      // generated client contract for any typechecker that covers tests/.
      expectTypeOf<GlAccountAccountType>().toEqualTypeOf<
        'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
      >();
      expectTypeOf<GlAccountNormalBalance>().toEqualTypeOf<'debit' | 'credit'>();
      expectTypeOf<CompanyEntityType>().toEqualTypeOf<'INDIVIDUAL' | 'BUSINESS'>();
      expectTypeOf<JournalEntryStatus>().toEqualTypeOf<'draft' | 'posted' | 'void' | 'pending_review'>();
      expectTypeOf<ReconciliationPeriodStatus>().toEqualTypeOf<'open' | 'completed' | 'cancelled'>();
      expectTypeOf<BankTransactionStatus>().toEqualTypeOf<
        'unreviewed' | 'pending_review' | 'reconciled' | 'ignored' | 'posted' | 'suspense'
      >();

      // @ts-expect-error — `income` is not a member of GlAccountAccountType.
      const notAnAccountType = 'income' satisfies GlAccountAccountType;
      expect(notAnAccountType).toBe('income');
    });
  });

  // ── 4. NO DRIFT ─────────────────────────────────────────────────────
  describe('no drift between the enum and its reference data', () => {
    it('rules/account-types.json declares exactly the enum labels', async () => {
      const config = await readJsonConfig<Record<string, unknown>>('account-types.json');
      expect(Object.keys(config).sort()).toEqual([...EXPECTED_LABELS.GlAccountAccountType].sort());
    });

    it('the chart-of-accounts seed only uses labels the enum accepts', () => {
      const acceptedTypes = new Set<string>(EXPECTED_LABELS.GlAccountAccountType);
      const acceptedBalances = new Set<string>(EXPECTED_LABELS.GlAccountNormalBalance);

      for (const account of CHART_OF_ACCOUNTS) {
        expect(acceptedTypes.has(account.type), `${account.code} accountType ${account.type}`).toBe(true);
        expect(
          acceptedBalances.has(account.normalBalance),
          `${account.code} normalBalance ${account.normalBalance}`,
        ).toBe(true);
      }
    });
  });

  // ── 5. PRESERVE ─────────────────────────────────────────────────────
  describe('preserve: the /api/accounts contract is unchanged', () => {
    it('POST accepts every accountType and stores it verbatim', async () => {
      const { company, token } = await seedCompany();
      let sequence = 0;

      for (const accountType of EXPECTED_LABELS.GlAccountAccountType) {
        sequence += 1;
        const res = await accountsPOST(
          accountsRequest(`/api/accounts?companyId=${company.id}`, token, {
            method: 'POST',
            body: JSON.stringify({
              code: `7${String(sequence).padStart(3, '0')}`,
              name: `Account ${accountType}`,
              accountType,
              normalBalance: 'credit',
            }),
          }),
          { params: Promise.resolve({}) },
        );
        expect(res.status, `POST accountType=${accountType}`).toBe(201);
        const payload = (await res.json()) as { account: { accountType: string; normalBalance: string } };
        expect(payload.account.accountType).toBe(accountType);
        expect(payload.account.normalBalance).toBe('credit');
        // The JSON value is the plain string, not an enum wrapper.
        expect(typeof payload.account.accountType).toBe('string');
      }
    });

    it('POST still answers 400 with the same message for an unknown accountType', async () => {
      const { company, token } = await seedCompany();
      const before = await db.glAccount.count({ where: { companyId: company.id } });

      const res = await accountsPOST(
        accountsRequest(`/api/accounts?companyId=${company.id}`, token, {
          method: 'POST',
          body: JSON.stringify({
            code: '7777',
            name: 'Legacy income',
            accountType: 'income',
            normalBalance: 'credit',
          }),
        }),
        { params: Promise.resolve({}) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid accountType. Must be one of: asset, liability, equity, revenue, expense',
      });
      // Nothing was written.
      expect(await db.glAccount.count({ where: { companyId: company.id } })).toBe(before);
    });

    it('GET filters by accountType and answers 200 with an empty list for an unknown value', async () => {
      const { company, token } = await seedCompany();
      await createTestGlAccount({
        companyId: company.id,
        code: '1000',
        name: 'Cash',
        accountType: 'asset',
        normalBalance: 'debit',
      });
      await createTestGlAccount({
        companyId: company.id,
        code: '4000',
        name: 'Sales',
        accountType: 'revenue',
        normalBalance: 'credit',
      });

      const filtered = await accountsGET(
        accountsRequest(`/api/accounts?companyId=${company.id}&accountType=asset`, token),
        { params: Promise.resolve({}) },
      );
      expect(filtered.status).toBe(200);
      const filteredBody = (await filtered.json()) as { accounts: { code: string }[] };
      expect(filteredBody.accounts.map((a) => a.code)).toEqual(['1000']);

      const unknown = await accountsGET(
        accountsRequest(`/api/accounts?companyId=${company.id}&accountType=income`, token),
        { params: Promise.resolve({}) },
      );
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ accounts: [] });
    });
  });
});
