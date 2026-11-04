/**
 * S2 (Wave 5) — per-file atomicity for multi-file imports.
 *
 * Before this change POST /api/import could only ever receive ONE file, and the
 * whole file (parse + statement + transactions + journal entries) ran inside a
 * single interactive transaction. A batch therefore had no per-file outcome at
 * all: one bad file either aborted the batch or was silently absent from the
 * response.
 *
 * These tests pin the new contract on the real fixture database:
 *  (a) a batch of two files where the SECOND fails → the FIRST stays committed,
 *      the response reports file 1 imported and file 2 failed with a Spanish
 *      reason, and the overall status is 'partial' (HTTP 200: a partially
 *      successful batch cannot be described by a single status code);
 *  (b) a duplicate of an already-imported file inside the same batch is reported
 *      as 'skipped' (content-hash dedupe), never as 'failed';
 *  (c) PRESERVE — a single-file import keeps the exact response shape it has
 *      today, success and error alike (no `results`, no `status` key);
 *  (d) IMPORT_STATEMENT_TIMEOUT_MS is applied with SET LOCAL to the import
 *      transaction only: a tiny budget produces a clear Spanish timeout message
 *      (never a raw Prisma dump) and leaves the pooled connection untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { POST } from '@/app/api/import/route';
import { createSession } from '@/lib/sessions';
import { initializeDefaultCompanyModuleEntitlements } from '@/lib/services/module-entitlement-initialization';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const KNOWN_ACCOUNT_NO = 'WAVE5-BATCH-ACC-1';
const KNOWN_BANK_NAME = 'Alpha Bank (CHECKING)';
const UNKNOWN_ACCOUNT_NO = 'WAVE5-BATCH-ACC-UNKNOWN';
const UNKNOWN_BANK_NAME = 'Gamma Bank (SAVINGS)';

interface Row {
  date: string;
  amount: string;
  fitid: string;
  name: string;
}

/** XML OFX (magic bytes: "<?xml") — the parser reads BANKNAME/ACCTID/ACCTTYPE. */
function ofxXml(options: {
  bankName: string;
  accountNo: string;
  dtStart: string;
  dtEnd: string;
  closingBalance: string;
  rows: Row[];
}): string {
  const rows = options.rows
    .map(
      (t) => `<STMTTRN>
      <TRNTYPE>OTHER</TRNTYPE>
      <DTPOSTED>${t.date}</DTPOSTED>
      <TRNAMT>${t.amount}</TRNAMT>
      <FITID>${t.fitid}</FITID>
      <NAME>${t.name}</NAME>
    </STMTTRN>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM>
          <BANKID>111000025</BANKID>
          <ACCTID>${options.accountNo}</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKNAME>${options.bankName}</BANKNAME>
        <BANKTRANLIST>
          <DTSTART>${options.dtStart}</DTSTART>
          <DTEND>${options.dtEnd}</DTEND>
${rows}
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>${options.closingBalance}</BALAMT>
          <DTASOF>${options.dtEnd}</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
}

function importableFile(
  fileName = 'batch-ok.ofx',
  extraRows: Row[] = [],
  period: { dtStart: string; dtEnd: string } = { dtStart: '20250301000000', dtEnd: '20250331000000' },
) {
  return new File(
    [
      ofxXml({
        bankName: 'Alpha Bank',
        accountNo: KNOWN_ACCOUNT_NO,
        dtStart: period.dtStart,
        dtEnd: period.dtEnd,
        closingBalance: '30.00',
        rows: [
          { date: '20250305000000', amount: '50.00', fitid: 'B1', name: 'BATCH ROW A' },
          { date: '20250306000000', amount: '-20.00', fitid: 'B2', name: 'BATCH ROW B' },
          ...extraRows,
        ],
      }),
    ],
    fileName,
    { type: 'application/x-ofx' },
  );
}

/** Same institution/account as `importableFile`, so the ROWS dedupe. */
function duplicateFile(fileName = 'batch-dup.ofx') {
  return importableFile(fileName);
}

/** A file whose bank account cannot be resolved → BankAccountRequiredError. */
function unresolvableFile(fileName = 'batch-broken.ofx') {
  return new File(
    [
      ofxXml({
        bankName: 'Gamma Bank',
        accountNo: UNKNOWN_ACCOUNT_NO,
        dtStart: '20250401000000',
        dtEnd: '20250430000000',
        closingBalance: '10.00',
        rows: [{ date: '20250405000000', amount: '10.00', fitid: 'G1', name: 'BATCH ROW G' }],
      }),
    ],
    fileName,
    { type: 'application/x-ofx' },
  );
}

async function setup() {
  const user = await createTestUser(`wave5-s2-${Date.now()}@example.com`);
  const company = await createTestCompany('wave5-s2-batching');
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
      accountName: 'Alpha Checking',
      bankName: KNOWN_BANK_NAME,
      accountNo: KNOWN_ACCOUNT_NO,
      glAccountId: gl.id,
      balance: 0,
      initialBalance: 0,
      isActive: true,
    },
  });

  return { user, company, token, gl, bankAccount };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function postImport(s: Setup, files: File[], fieldName: 'file' | 'files' = 'files') {
  const form = new FormData();
  for (const file of files) {
    form.append(fieldName, file);
  }
  form.append('companyId', s.company.id);

  const req = new NextRequest(`http://localhost/api/import?companyId=${s.company.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}` },
    body: form,
  });

  return POST(req, { params: Promise.resolve({}) } as never);
}

function countRows(bankAccountId: string, description: string) {
  return db.bankTransaction.count({
    where: { description, statement: { bankAccountId } },
  });
}

describe('S2 — multi-file import batches', () => {
  beforeEach(async () => {
    await clearDatabase();
    delete process.env.IMPORT_STATEMENT_TIMEOUT_MS;
  });

  afterEach(async () => {
    delete process.env.IMPORT_STATEMENT_TIMEOUT_MS;
    await clearDatabase();
  });

  it('a failing second file does not abort the batch: first file commits, second is reported', async () => {
    const s = await setup();

    const res = await postImport(s, [importableFile('batch-first.ofx'), unresolvableFile()]);
    const body = await res.json();

    // The batch answered with per-file results. A partially successful batch
    // cannot be expressed by one status code, so HTTP stays 200 and the body
    // carries the honest per-file outcome.
    expect(res.status).toBe(200);
    expect(body.status).toBe('partial');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(2);

    const [first, second] = body.results;
    expect(first.fileName).toBe('batch-first.ofx');
    expect(first.status).toBe('imported');
    expect(first.transactionCount).toBe(2);
    expect(first.duplicatesSkipped).toBe(0);
    expect(typeof first.statementId).toBe('string');
    expect(first.statementId.length).toBeGreaterThan(0);

    expect(second.fileName).toBe('batch-broken.ofx');
    expect(second.status).toBe('failed');
    // Spanish, human-readable reason — the account could not be resolved.
    expect(second.reason).toMatch(/cuenta bancaria/i);
    expect(second.transactionCount ?? 0).toBe(0);

    // The first file is REALLY committed, the second left nothing behind.
    expect(await countRows(s.bankAccount.id, 'BATCH ROW A')).toBe(1);
    expect(await countRows(s.bankAccount.id, 'BATCH ROW B')).toBe(1);
    expect(await countRows(s.bankAccount.id, 'BATCH ROW G')).toBe(0);
    expect(await db.bankStatement.count({ where: { companyId: s.company.id } })).toBe(1);
  });

  it('a duplicate of an already-imported file in the same batch is reported as skipped', async () => {
    const s = await setup();

    const res = await postImport(s, [importableFile('dup-first.ofx'), duplicateFile('dup-second.ofx')]);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('partial');
    expect(body.results).toHaveLength(2);

    const [first, second] = body.results;
    expect(first.status).toBe('imported');
    expect(first.transactionCount).toBe(2);

    // Content-hash dedupe, not a failure.
    expect(second.fileName).toBe('dup-second.ofx');
    expect(second.status).toBe('skipped');
    expect(second.duplicatesSkipped).toBe(2);
    expect(second.reason).toMatch(/duplicad/i);

    // Nothing was imported twice.
    expect(await countRows(s.bankAccount.id, 'BATCH ROW A')).toBe(1);
    expect(await countRows(s.bankAccount.id, 'BATCH ROW B')).toBe(1);
    expect(await db.bankStatement.count({ where: { companyId: s.company.id } })).toBe(1);
  });

  it('PRESERVE — a single-file import keeps the exact current response shape', async () => {
    const s = await setup();

    const okRes = await postImport(s, [importableFile('single.ofx')], 'file');
    const okBody = await okRes.json();

    expect(okRes.status).toBe(200);
    // Byte-compatible with the published single-file contract: no batch keys.
    expect(Object.keys(okBody).sort()).toEqual([
      'autoCategorizedCount',
      'bankAccountName',
      'duplicatesSkipped',
      'newAccountCreated',
      'statementId',
      'transactionCount',
    ]);
  });

  it('PRESERVE — a single-file failure keeps the exact current error shape', async () => {
    const s = await setup();

    const errRes = await postImport(s, [unresolvableFile('single-broken.ofx')], 'file');
    const errBody = await errRes.json();

    expect(errRes.status).toBe(400);
    expect(errBody.code).toBe('BANK_CREATION_REQUIRED');
    expect(typeof errBody.error).toBe('string');
    expect(Object.keys(errBody).sort()).toEqual(['code', 'details', 'error']);
    expect(errBody.results).toBeUndefined();
    expect(errBody.status).toBeUndefined();
  });
});

describe('S2 — configurable import statement timeout', () => {
  beforeEach(async () => {
    await clearDatabase();
    delete process.env.IMPORT_STATEMENT_TIMEOUT_MS;
  });

  afterEach(async () => {
    delete process.env.IMPORT_STATEMENT_TIMEOUT_MS;
    await clearDatabase();
  });

  it('a tiny IMPORT_STATEMENT_TIMEOUT_MS aborts with a clear Spanish message and no raw Prisma dump', async () => {
    const s = await setup();
    process.env.IMPORT_STATEMENT_TIMEOUT_MS = '1';

    // Deterministic timeout source: another session holds the bank-account row
    // lock, so the import transaction's own UPDATE waits and the configured
    // 1 ms statement budget cancels it. If SET LOCAL were NOT applied inside the
    // import transaction, that UPDATE would simply wait for the lock instead.
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockTimer = setTimeout(() => releaseLock(), 2_000);
    const blocker = db
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'SELECT id FROM "BankAccount" WHERE id = $1 FOR UPDATE',
            s.bankAccount.id,
          );
          await lockGate;
        },
        { timeout: 10_000, maxWait: 5_000 },
      )
      .catch(() => undefined);

    try {
      const res = await postImport(s, [importableFile('too-slow.ofx')], 'file');
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.code).toBe('IMPORT_TIMEOUT');
      expect(body.error).toMatch(/tiempo/i);
      expect(body.error).toMatch(/IMPORT_STATEMENT_TIMEOUT_MS/);
      // Never a raw driver/ORM dump.
      expect(String(body.error)).not.toMatch(/prisma|P20\d\d|statement timeout/i);
      expect(JSON.stringify(body)).not.toMatch(/Invalid `prisma/i);

      // The failed file rolled back atomically.
      expect(await db.bankStatement.count({ where: { companyId: s.company.id } })).toBe(0);
      expect(await countRows(s.bankAccount.id, 'BATCH ROW A')).toBe(0);
    } finally {
      releaseLock();
      clearTimeout(lockTimer);
      await blocker;
    }
  });

  it('PRESERVE — the timeout is transaction-local: the pooled connection keeps the default', async () => {
    const s = await setup();

    const okRes = await postImport(s, [importableFile('default-timeout.ofx')], 'file');
    expect(okRes.status).toBe(200);

    // SET LOCAL must never leak onto the pooled connection. This asserts the
    // observable half of (d): with no env var the import still succeeds, and no
    // session-wide statement_timeout survives the transaction.
    const [row] = await db.$queryRaw<Array<{ statement_timeout: string }>>`
      SELECT current_setting('statement_timeout') AS statement_timeout
    `;
    expect(row!.statement_timeout).toBe('0');

    // A configured budget (well above the 5s Prisma default) still imports.
    process.env.IMPORT_STATEMENT_TIMEOUT_MS = '120000';
    const stillOk = await postImport(
      s,
      [
        importableFile(
          'configured-timeout.ofx',
          [{ date: '20250407000000', amount: '5.00', fitid: 'B3', name: 'BATCH ROW C' }],
          { dtStart: '20250401000000', dtEnd: '20250430000000' },
        ),
      ],
      'file',
    );
    expect(stillOk.status).toBe(200);

    const [after] = await db.$queryRaw<Array<{ statement_timeout: string }>>`
      SELECT current_setting('statement_timeout') AS statement_timeout
    `;
    expect(after!.statement_timeout).toBe('0');
  });
});
