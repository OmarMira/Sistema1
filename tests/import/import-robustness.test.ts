// S20 — Import pipeline robustness
//
// Covers: content-only duplicate detection (statement-range independent),
// in-file duplicate skipping, ambiguous-KE quarantine, legitimate 0.00 closing
// balance, CSV encoding hardening (BOM / UTF-16) and CSV export injection
// neutralization.
//
// DB surface is deliberately minimal: the hash/decoder/CSV-cell helpers are
// unit-tested directly and only the pipeline behaviors that live in
// ImportService.importFile run against the fixture database.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateImportHash, generateLegacyImportHash } from '@/lib/accounting/import-hash';
import { csvCell } from '@/lib/csv-cell';
import { decodeCsvBuffer, parseCSV } from '@/lib/csv-parser';
import { exportToCSVContent } from '@/lib/reports/export-csv';
import { bankMovementsCSV } from '@/lib/dashboard/bank-activity';
import { ImportService } from '@/lib/services/import.service';
import { db } from '@/lib/db';
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories';

// ─── Unit: import hash is content-only ────────────────────────────────

describe('S20.1 — duplicate detection hashes the normalized row, not the statement range', () => {
  const base = {
    companyId: 'company-1',
    accountNumber: 'ACC-1',
    txDate: '2025-03-05',
    amount: 50,
    description: '  Payment   to Vendor ',
  };

  it('the same row produces the same hash under different statement months', () => {
    const february = generateImportHash({ ...base, statementMonth: '2025-02' });
    const march = generateImportHash({ ...base, statementMonth: '2025-03' });
    const noMonth = generateImportHash(base);

    expect(march).toBe(february);
    expect(noMonth).toBe(february);
  });

  it('the hash still separates rows that differ in content', () => {
    const reference = generateImportHash({ ...base, reference: 'FITID-1' });
    const otherAmount = generateImportHash({ ...base, amount: 50.01 });
    const otherDate = generateImportHash({ ...base, txDate: '2025-03-06' });

    expect(new Set([generateImportHash(base), reference, otherAmount, otherDate]).size).toBe(4);
  });

  it('description/reference normalization stays whitespace- and case-insensitive', () => {
    const canonical = generateImportHash({ ...base, description: 'payment to vendor', reference: 'FITID 1' });
    const noisy = generateImportHash({ ...base, description: 'PAYMENT    TO  Vendor', reference: ' fitid   1 ' });

    expect(noisy).toBe(canonical);
  });

  it('the legacy statement-month-scoped hash is still available for pre-existing rows', () => {
    const february = generateLegacyImportHash({ ...base, statementMonth: '2025-02' });
    const march = generateLegacyImportHash({ ...base, statementMonth: '2025-03' });

    expect(march).not.toBe(february);
    expect(february).not.toBe(generateImportHash({ ...base, statementMonth: '2025-02' }));
  });
});

// ─── Unit: CSV text decoding (BOM / UTF-16) ───────────────────────────

describe('S20.5 — uploaded CSV text is decoded before parsing', () => {
  const csv = 'date,description,amount\n2025-03-05,ACME SUPPLY,100.00\n';

  function utf16be(text: string): Buffer {
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    return be;
  }

  it('strips a UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]);
    const decoded = decodeCsvBuffer(buf);

    expect(decoded.startsWith('date,')).toBe(true);
    expect(parseCSV(decoded)).toHaveLength(1);
    expect(parseCSV(decoded)[0]!.description).toBe('ACME SUPPLY');
  });

  it('decodes UTF-16 LE (with BOM)', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]);
    const decoded = decodeCsvBuffer(buf);

    expect(parseCSV(decoded)).toHaveLength(1);
    expect(parseCSV(decoded)[0]!.description).toBe('ACME SUPPLY');
  });

  it('decodes UTF-16 BE (with BOM)', () => {
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(csv)]);
    const decoded = decodeCsvBuffer(buf);

    expect(parseCSV(decoded)).toHaveLength(1);
    expect(parseCSV(decoded)[0]!.description).toBe('ACME SUPPLY');
  });

  it('leaves plain UTF-8 untouched and handles BOM-less UTF-16 LE', () => {
    expect(decodeCsvBuffer(Buffer.from(csv, 'utf8'))).toBe(csv);

    const bomless = Buffer.from(csv, 'utf16le');
    expect(parseCSV(decodeCsvBuffer(bomless))[0]!.description).toBe('ACME SUPPLY');
  });
});

// ─── Unit: CSV export injection neutralization ────────────────────────

describe('S20.7 — CSV cells neutralize formula prefixes and double quotes', () => {
  it('prefixes every formula trigger so the spreadsheet cannot execute it', () => {
    for (const attack of ['=cmd|\' /c calc\'!A0', '+1+1', '-1+1', '@SUM(1+1)']) {
      const cell = csvCell(attack);
      expect(cell.startsWith(`"'`), `${attack} → ${cell}`).toBe(true);
    }
  });

  it('doubles embedded quotes and always wraps the value', () => {
    expect(csvCell('ACME "SUPPLY" LTD')).toBe('"ACME ""SUPPLY"" LTD"');
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('')).toBe('""');
  });

  it('the financial report export neutralizes hostile account names', () => {
    const content = exportToCSVContent(
      {
        accounts: [
          { code: '1010', name: '=HYPERLINK("http://evil","x")', accountType: 'asset', debit: 10, credit: 0, balance: 10 },
        ],
        totalDebits: 10,
        totalCredits: 0,
        balanced: false,
      },
      'company-1',
      'trial_balance',
      'hash-1',
    );

    expect(content).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(content).not.toContain(`"=HYPERLINK`);
  });

  it('the bank-movement export neutralizes hostile descriptions', () => {
    const csv = bankMovementsCSV([
      {
        statementId: 'stmt-1',
        ignored: false,
        fecha: '2025-03-05',
        descripcion: '=1+1',
        monto: 10,
        tipo: 'credito',
        cuenta_contable: 'Cash',
        conciliado: false,
      } as never,
    ]);

    expect(csv).toContain(`"'=1+1"`);
    expect(csv).not.toContain(`,=1+1,`);
  });
});

// ─── Integration: ImportService pipeline ──────────────────────────────

function buildOfx(options: {
  dtStart: string;
  dtEnd: string;
  ledgerBalance: string;
  transactions: Array<{ date: string; amount: string; fitid: string; name: string }>;
}): string {
  const rows = options.transactions
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
          <ACCTID>ACC-1</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>${options.dtStart}</DTSTART>
          <DTEND>${options.dtEnd}</DTEND>
${rows}
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>${options.ledgerBalance}</BALAMT>
          <DTASOF>${options.dtEnd}</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
}

const OFX_ROWS = [
  { date: '20250305000000', amount: '50.00', fitid: 'D1', name: 'OFX ROW A' },
  { date: '20250306000000', amount: '-20.00', fitid: 'E1', name: 'OFX ROW B' },
];

async function setupImport(name = 'Import Robustness Co') {
  const company = await createTestCompany(name);
  const cashGl = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'Checking',
      bankName: 'Test Bank',
      accountNo: 'ACC-1',
      glAccountId: cashGl.id,
      balance: 0,
      currency: 'USD',
      isActive: true,
    },
  });
  return { company, cashGl, bankAccount };
}

function importCsv(companyId: string, bankAccountId: string, content: string, encoding = 'utf8') {
  return ImportService.importFile({
    companyId,
    bankAccountId,
    fileName: 'robustness.csv',
    extension: 'csv',
    buffer: Buffer.from(content, encoding as BufferEncoding),
    content,
    userId: 'test-user',
  });
}

function importOfx(companyId: string, bankAccountId: string, content: string) {
  return ImportService.importFile({
    companyId,
    bankAccountId,
    fileName: 'robustness.ofx',
    extension: 'ofx',
    buffer: Buffer.from(content),
    content,
    userId: 'test-user',
  });
}

function countInAccount(bankAccountId: string, description: string) {
  return db.bankTransaction.count({ where: { description, statement: { bankAccountId } } });
}

describe('S20 — import pipeline robustness (database)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('S20.1 — re-importing the same rows under a different statement range is detected as duplicates', async () => {
    const { company, bankAccount } = await setupImport();

    // Statement covering February + March: statementMonth derives to 2025-02.
    const first = await importOfx(
      company.id,
      bankAccount.id,
      buildOfx({ dtStart: '20250201000000', dtEnd: '20250331000000', ledgerBalance: '30.00', transactions: OFX_ROWS }),
    );
    expect(first.transactionCount).toBe(2);
    expect(first.duplicatesSkipped).toBe(0);

    // Same rows again, now under a March-only statement range: statementMonth 2025-03.
    const second = await importOfx(
      company.id,
      bankAccount.id,
      buildOfx({ dtStart: '20250301000000', dtEnd: '20250331000000', ledgerBalance: '30.00', transactions: OFX_ROWS }),
    );

    expect(second.transactionCount).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(await countInAccount(bankAccount.id, 'OFX ROW A')).toBe(1);
    expect(await countInAccount(bankAccount.id, 'OFX ROW B')).toBe(1);
  });

  it('PRESERVE S20.1 — re-importing the identical statement range is still deduplicated', async () => {
    const { company, bankAccount } = await setupImport();
    const content = buildOfx({
      dtStart: '20250201000000',
      dtEnd: '20250331000000',
      ledgerBalance: '30.00',
      transactions: OFX_ROWS,
    });

    await importOfx(company.id, bankAccount.id, content);
    const again = await importOfx(company.id, bankAccount.id, content);

    expect(again.transactionCount).toBe(0);
    expect(again.duplicatesSkipped).toBe(2);
    expect(await db.bankStatement.count({ where: { bankAccountId: bankAccount.id } })).toBe(1);
  });

  it('S20.1 — rows hashed the legacy way are still detected at the same statement range', async () => {
    const { company, bankAccount } = await setupImport();

    const statement = await db.bankStatement.create({
      data: {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        startDate: new Date('2025-02-01T00:00:00.000Z'),
        endDate: new Date('2025-02-15T00:00:00.000Z'),
        openingBalance: 0,
        closingBalance: 50,
        format: 'ofx',
        fileName: 'legacy.ofx',
      },
    });
    await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-03-05T00:00:00.000Z'),
        description: 'OFX ROW A',
        amount: 50,
        importHash: generateLegacyImportHash({
          companyId: company.id,
          accountNumber: 'ACC-1',
          statementMonth: '2025-02',
          txDate: '2025-03-05',
          amount: 50,
          description: 'OFX ROW A',
        }),
      },
    });

    const result = await importOfx(
      company.id,
      bankAccount.id,
      buildOfx({ dtStart: '20250201000000', dtEnd: '20250331000000', ledgerBalance: '30.00', transactions: OFX_ROWS }),
    );

    // ROW A came from the legacy-hashed row; only ROW B is new.
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.transactionCount).toBe(1);
    expect(await countInAccount(bankAccount.id, 'OFX ROW A')).toBe(1);
  });

  it('S20.2 — identical rows inside one file are skipped, not fatal', async () => {
    const { company, bankAccount } = await setupImport();

    const content =
      'date,description,amount\n' +
      '2025-05-01,DUP ROW,10.00\n' +
      '2025-05-01,DUP ROW,10.00\n' +
      '2025-05-02,OTHER ROW,20.00\n';

    const result = await importCsv(company.id, bankAccount.id, content);

    expect(result.transactionCount).toBe(2);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.rejectedRows ?? []).toHaveLength(1);
    expect((result.rejectedRows ?? [])[0]).toMatchObject({ reason: 'duplicate_in_file', description: 'DUP ROW' });
    expect(await countInAccount(bankAccount.id, 'DUP ROW')).toBe(1);
    expect(await countInAccount(bankAccount.id, 'OTHER ROW')).toBe(1);
  });

  it('S20.3 — an ambiguous KE row is quarantined with a per-row error instead of aborting the import', async () => {
    const { company, bankAccount } = await setupImport();
    const ambiguous = 'ZENITH TRADING AMBIGUOUS';

    await db.companyKnowledge.create({
      data: { companyId: company.id, type: 'COMPANY', canonicalName: ambiguous, aliases: [], status: 'active' },
    });
    await db.companyKnowledge.create({
      data: {
        companyId: company.id,
        type: 'COMPANY',
        canonicalName: `${ambiguous} RIVAL`,
        aliases: [ambiguous],
        status: 'active',
      },
    });

    const content =
      'date,description,amount\n' +
      `2025-06-10,${ambiguous},-70.00\n` +
      '2025-06-11,CLEAN ROW,-10.00\n';

    const result = await importCsv(company.id, bankAccount.id, content);

    expect(result.transactionCount).toBe(1);
    expect(result.rejectedRows ?? []).toHaveLength(1);
    expect((result.rejectedRows ?? [])[0]).toMatchObject({ reason: 'ke_error', description: ambiguous });
    expect(await countInAccount(bankAccount.id, ambiguous)).toBe(0);
    expect(await countInAccount(bankAccount.id, 'CLEAN ROW')).toBe(1);

    // The quarantined row never reached the DB, so it must not inflate the
    // statement totals either.
    const statement = await db.bankStatement.findUnique({ where: { id: result.statementId } });
    expect(Number(statement!.totalDebits)).toBe(10);
    expect(Number(statement!.totalCredits)).toBe(0);
  });

  it('PRESERVE S20.3 — a file whose every row is ambiguous still fails closed with KE_ERROR', async () => {
    const { company, bankAccount } = await setupImport();
    const ambiguous = 'ORION TRADING AMBIGUOUS';

    await db.companyKnowledge.create({
      data: { companyId: company.id, type: 'COMPANY', canonicalName: ambiguous, aliases: [], status: 'active' },
    });
    await db.companyKnowledge.create({
      data: {
        companyId: company.id,
        type: 'COMPANY',
        canonicalName: `${ambiguous} RIVAL`,
        aliases: [ambiguous],
        status: 'active',
      },
    });

    const statementsBefore = await db.bankStatement.count({ where: { bankAccountId: bankAccount.id } });

    await expect(
      importCsv(company.id, bankAccount.id, `date,description,amount\n2025-06-10,${ambiguous},-70.00\n`),
    ).rejects.toThrow('KE_ERROR');

    expect(await db.bankStatement.count({ where: { bankAccountId: bankAccount.id } })).toBe(statementsBefore);
    expect(await countInAccount(bankAccount.id, ambiguous)).toBe(0);
  });

  it('S20.4 — a legitimate 0.00 closing balance is stored as 0.00', async () => {
    const { company, bankAccount } = await setupImport();

    // Dropped rows make the recomputed balance diverge from the source balance:
    // the in-file duplicate is skipped, so the statement totals no longer
    // reconstruct the reported closing balance. The source value (0.00) must win.
    const content = buildOfx({
      dtStart: '20250701000000',
      dtEnd: '20250731000000',
      ledgerBalance: '0.00',
      transactions: [
        { date: '20250705000000', amount: '50.00', fitid: 'DUP', name: 'CLOSING DUP' },
        { date: '20250705000000', amount: '50.00', fitid: 'DUP', name: 'CLOSING DUP' },
        { date: '20250706000000', amount: '-20.00', fitid: 'EXP', name: 'CLOSING EXPENSE' },
      ],
    });

    const result = await importOfx(company.id, bankAccount.id, content);
    expect(result.duplicatesSkipped).toBe(1);

    const statement = await db.bankStatement.findUnique({ where: { id: result.statementId } });
    expect(statement).not.toBeNull();
    expect(Number(statement!.closingBalance)).toBe(0);
  });

  it('S20.5 — a BOM-prefixed CSV imported through the pipeline parses', async () => {
    const { company, bankAccount } = await setupImport();

    const csv = 'date,description,amount\n2025-08-01,BOM ROW,15.00\n';
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const buffer = Buffer.concat([bom, Buffer.from(csv, 'utf8')]);
    const content = decodeCsvBuffer(buffer);

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'bom.csv',
      extension: 'csv',
      buffer,
      content,
      userId: 'test-user',
    });

    expect(result.transactionCount).toBe(1);
    expect(await countInAccount(bankAccount.id, 'BOM ROW')).toBe(1);
  });
});
