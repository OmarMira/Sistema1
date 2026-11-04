/**
 * S6 (Wave 5, part 3) — one-time re-hash of legacy `BankTransaction.importHash`.
 *
 * Finding: rows hashed with the old month-scoped legacy hash only dedupe inside
 * their ORIGINAL statement month. The content hash (src/lib/accounting/
 * import-hash.ts) deliberately ignores the statement range, but rows written by
 * older builds still hold the legacy value, so re-importing the same rows under
 * a different month inserted duplicates.
 *
 * Contract pinned here:
 *  (a) the finding itself — a legacy-hashed row is NOT recognized under another
 *      statement month (before the migration);
 *  (b) `prisma/migrations/20261107000001_import_hash_content_rehash` recomputes
 *      every stored hash as the CONTENT hash from the row's own fields
 *      (company, account, UTC date, amount, normalized description/reference),
 *      matching `generateImportHash` byte for byte, including messy whitespace
 *      and mixed case;
 *  (c) the migration is idempotent — re-running it changes nothing;
 *  (d) after the migration the same rows ARE detected as duplicates under a
 *      different statement month, with no row duplicated;
 *  (e) the migration can never violate the unique index: when two legacy rows
 *      carry the SAME content, one is re-hashed and the other keeps the hash it
 *      already had (still dedupable through the legacy anchor lookup).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { POST } from '@/app/api/import/route';
import { createSession } from '@/lib/sessions';
import { initializeDefaultCompanyModuleEntitlements } from '@/lib/services/module-entitlement-initialization';
import { generateImportHash, generateLegacyImportHash } from '@/lib/accounting/import-hash';
import { toDateString, toStatementMonth } from '@/lib/accounting/date-window';
import {
  clearDatabase,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestUser,
} from '../helpers/factories';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'prisma/migrations/20261107000001_import_hash_content_rehash/migration.sql',
);

const ACCOUNT_NO = 'WAVE5-REHASH-ACC-1';
const BANK_NAME = 'Rehash Bank (CHECKING)';

/** Rows carry internal whitespace and mixed case on purpose: normalization. */
const ROWS = [
  { date: '20250305000000', amount: '50.00', fitid: 'REF   001', name: 'Coffee   SHOP' },
  { date: '20250306000000', amount: '-20.00', fitid: 'B2', name: 'BATCH ROW B' },
  { date: '20250307000000', amount: '1234.56', fitid: 'B3', name: 'Mixed  Case   Row' },
];

function ofxXml(period: { dtStart: string; dtEnd: string }): string {
  const rows = ROWS.map(
    (t) => `<STMTTRN>
      <TRNTYPE>OTHER</TRNTYPE>
      <DTPOSTED>${t.date}</DTPOSTED>
      <TRNAMT>${t.amount}</TRNAMT>
      <FITID>${t.fitid}</FITID>
      <NAME>${t.name}</NAME>
    </STMTTRN>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM>
          <BANKID>111000025</BANKID>
          <ACCTID>${ACCOUNT_NO}</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKNAME>${BANK_NAME}</BANKNAME>
        <BANKTRANLIST>
          <DTSTART>${period.dtStart}</DTSTART>
          <DTEND>${period.dtEnd}</DTEND>
${rows}
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>1264.56</BALAMT>
          <DTASOF>${period.dtEnd}</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
}

const MARCH = { dtStart: '20250301000000', dtEnd: '20250331000000' };
const APRIL = { dtStart: '20250401000000', dtEnd: '20250430000000' };

function statementFile(fileName: string, period: { dtStart: string; dtEnd: string }) {
  return new File([ofxXml(period)], fileName, { type: 'application/x-ofx' });
}

async function setup() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await createTestUser(`wave5-s6-rehash-${stamp}@example.com`);
  const company = await createTestCompany('wave5-s6-rehash');
  await initializeDefaultCompanyModuleEntitlements(db, company.id);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  const gl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Bank',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'Rehash Checking',
      bankName: BANK_NAME,
      accountNo: ACCOUNT_NO,
      glAccountId: gl.id,
      balance: 0,
      initialBalance: 0,
      isActive: true,
    },
  });
  return { user, company, token, gl, bankAccount };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function postImport(s: Setup, file: File) {
  const form = new FormData();
  form.append('file', file);
  form.append('companyId', s.company.id);
  const req = new NextRequest(`http://localhost/api/import?companyId=${s.company.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}` },
    body: form,
  });
  return POST(req, { params: Promise.resolve({}) } as never);
}

interface StoredRow {
  id: string;
  date: Date;
  description: string;
  amount: unknown;
  reference: string | null;
  importHash: string | null;
}

async function storedRows(companyId: string): Promise<StoredRow[]> {
  const rows = await db.bankTransaction.findMany({
    where: { companyId },
    select: { id: true, date: true, description: true, amount: true, reference: true, importHash: true },
  });
  return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function contentHashOf(row: StoredRow, companyId: string): string {
  return generateImportHash({
    companyId,
    accountNumber: ACCOUNT_NO,
    txDate: toDateString(row.date),
    amount: Number(row.amount),
    description: row.description,
    reference: row.reference ?? undefined,
  });
}

/** The value an older build would have stored: the month-scoped legacy hash. */
function legacyHashOf(row: StoredRow, companyId: string, statementMonth: string): string {
  return generateLegacyImportHash({
    companyId,
    accountNumber: ACCOUNT_NO,
    statementMonth,
    txDate: toDateString(row.date),
    amount: Number(row.amount),
    description: row.description,
  });
}

/** Import March, then rewrite every hash to the legacy month-scoped value. */
async function seedLegacyHashedRows(s: Setup): Promise<StoredRow[]> {
  const res = await postImport(s, statementFile('march.ofx', MARCH));
  expect(res.status).toBe(200);

  const statement = await db.bankStatement.findFirstOrThrow({
    where: { bankAccountId: s.bankAccount.id },
    select: { startDate: true },
  });
  const statementMonth = toStatementMonth(statement.startDate);
  const rows = await storedRows(s.company.id);
  for (const row of rows) {
    await db.bankTransaction.update({
      where: { id: row.id },
      data: { importHash: legacyHashOf(row, s.company.id, statementMonth) },
    });
  }
  return storedRows(s.company.id);
}

async function applyMigration(): Promise<void> {
  await db.$executeRawUnsafe(readFileSync(MIGRATION_PATH, 'utf8'));
}

function hashSnapshot(rows: StoredRow[]): Record<string, string | null> {
  return Object.fromEntries(rows.map((row) => [row.id, row.importHash]));
}

describe('S6 (3) — legacy hashes only dedupe inside their original statement month', () => {
  beforeEach(async () => {
    await clearDatabase();
  });
  afterEach(async () => {
    await clearDatabase();
  });

  it('re-importing the same rows under another month inserts duplicates while the hashes are legacy', async () => {
    const s = await setup();
    await seedLegacyHashedRows(s);

    const res = await postImport(s, statementFile('april-before-migration.ofx', APRIL));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transactionCount).toBe(ROWS.length);
    // The finding: nothing was recognized, so every row was inserted again.
    expect(await db.bankTransaction.count({ where: { companyId: s.company.id } })).toBe(ROWS.length * 2);
  });
});

describe('S6 (3) — migration 20261107000001 re-hashes stored rows to the content hash', () => {
  beforeEach(async () => {
    await clearDatabase();
  });
  afterEach(async () => {
    await clearDatabase();
  });

  it('rewrites every legacy hash to the content hash computed from the row itself', async () => {
    const s = await setup();
    const seeded = await seedLegacyHashedRows(s);

    // The two hash shapes really are different for these rows, so the migration
    // has something to do (guards against a vacuous assertion).
    for (const row of seeded) {
      expect(row.importHash).toBe(legacyHashOf(row, s.company.id, '2025-03'));
      expect(row.importHash).not.toBe(contentHashOf(row, s.company.id));
    }

    await applyMigration();

    const migrated = await storedRows(s.company.id);
    expect(migrated).toHaveLength(ROWS.length);
    for (const row of migrated) {
      // Description with collapsed whitespace/lowercase, negative amount,
      // reference with internal spaces: all normalized identically to JS.
      expect(row.importHash).toBe(contentHashOf(row, s.company.id));
      expect(row.importHash).not.toBe(legacyHashOf(row, s.company.id, '2025-03'));
    }
  });

  it('is idempotent: re-running the migration changes nothing', async () => {
    const s = await setup();
    await seedLegacyHashedRows(s);

    await applyMigration();
    const once = hashSnapshot(await storedRows(s.company.id));
    await applyMigration();
    const twice = hashSnapshot(await storedRows(s.company.id));

    expect(twice).toEqual(once);
  });

  it('makes a re-import under a DIFFERENT statement month detect duplicates', async () => {
    const s = await setup();
    await seedLegacyHashedRows(s);
    await applyMigration();
    const before = await storedRows(s.company.id);

    const res = await postImport(s, statementFile('april-after-migration.ofx', APRIL));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Detected as duplicates, not as new rows: the content hash now matches
    // whatever statement month the file is imported under.
    expect(body.transactionCount).toBe(0);
    expect(body.duplicatesSkipped).toBe(ROWS.length);
    // Nothing was inserted, and the stored rows kept their content hashes.
    expect(await db.bankTransaction.count({ where: { companyId: s.company.id } })).toBe(ROWS.length);
    expect(hashSnapshot(await storedRows(s.company.id))).toEqual(hashSnapshot(before));
  });

  it('never violates the unique index when two legacy rows share the same content', async () => {
    const s = await setup();
    // Two statements covering the same rows: the duplicate pair a legacy build
    // produced across statement ranges.
    const first = await db.bankStatement.create({
      data: {
        companyId: s.company.id,
        bankAccountId: s.bankAccount.id,
        startDate: new Date('2025-03-01T00:00:00.000Z'),
        endDate: new Date('2025-03-31T00:00:00.000Z'),
        openingBalance: 0,
        closingBalance: 0,
        totalCredits: 0,
        totalDebits: 0,
        format: 'ofx',
      },
    });
    const second = await db.bankStatement.create({
      data: {
        companyId: s.company.id,
        bankAccountId: s.bankAccount.id,
        startDate: new Date('2025-04-01T00:00:00.000Z'),
        endDate: new Date('2025-04-30T00:00:00.000Z'),
        openingBalance: 0,
        closingBalance: 0,
        totalCredits: 0,
        totalDebits: 0,
        format: 'ofx',
      },
    });
    const shared = { date: new Date('2025-03-05T00:00:00.000Z'), description: 'Coffee   SHOP', amount: 50, companyId: s.company.id };
    const legacyMarch = generateLegacyImportHash({
      companyId: s.company.id, accountNumber: ACCOUNT_NO, statementMonth: '2025-03',
      txDate: '2025-03-05', amount: 50, description: 'Coffee   SHOP',
    });
    const legacyApril = generateLegacyImportHash({
      companyId: s.company.id, accountNumber: ACCOUNT_NO, statementMonth: '2025-04',
      txDate: '2025-03-05', amount: 50, description: 'Coffee   SHOP',
    });
    expect(legacyMarch).not.toBe(legacyApril);
    await db.bankTransaction.create({ data: { ...shared, statementId: first.id, importHash: legacyMarch } });
    await db.bankTransaction.create({ data: { ...shared, statementId: second.id, importHash: legacyApril } });

    await applyMigration();

    const rows = await storedRows(s.company.id);
    const contentHash = generateImportHash({
      companyId: s.company.id, accountNumber: ACCOUNT_NO, txDate: '2025-03-05',
      amount: 50, description: 'Coffee   SHOP',
    });
    const hashes = rows.map((row) => row.importHash);
    // Exactly one row owns the content hash; the twin keeps a hash it already
    // had, so it stays dedupable instead of colliding on the unique index.
    expect(hashes.filter((hash) => hash === contentHash)).toHaveLength(1);
    const untouched = hashes.find((hash) => hash !== contentHash);
    expect([legacyMarch, legacyApril]).toContain(untouched);
  });
});
