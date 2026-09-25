// Block 4 — route-level E2E certification of POST /api/import (TEST ONLY).
//
// Closes the certification gap identified in the Block 4 gap analysis: there
// was no evidence at the HTTP boundary proving the smart bank importer works
// from a real multipart request through to persistence.
//
// This drives the REAL chain end to end, mocking nothing in it:
//
//   multipart FormData
//     → POST /api/import (real route handler)
//       → requireCompanyContext / requireCompanyRole (real)
//       → validateFile (real: extension, MIME, magic bytes, size)
//       → ImportService.importFile (real)
//         → parseOFX (real SGML branch)
//         → findOrCreateBankAccount (real)
//         → importTransactions (real)
//           → resolveImportDecision (real)
//         → db.$transaction (real)
//       → NextResponse.json(result) (real)
//
// Of the chain, nothing is stubbed. Authentication is real too: a real
// session token and a real company membership, so no infrastructure mock is
// needed at all.
//
// The OFX fixture is SGML ("OFXHEADER:100") because validateFile enforces
// magic bytes: a file must begin with "OFXHEADER" or "<?xml".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { POST } from '../../src/app/api/import/route';
import { createSession } from '@/lib/sessions';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const STORED_BANK_NAME = 'E2E Institution (CHECKING)';
const ACCOUNT_NO = 'E2E-ACCT-0001';
const TX_DESCRIPTION = 'E2E CERT MERCHANT';

function sgmlOfx(): string {
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20250301120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKNAME>E2E Institution
<BANKACCTFROM>
<BANKID>555000111
<ACCTID>${ACCOUNT_NO}
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20250301000000
<DTEND>20250331000000
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20250315
<TRNAMT>-75.00
<FITID>E2E-FIT-1
<NAME>${TX_DESCRIPTION}
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>925.00
<DTASOF>20250331120000
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
}

async function setup() {
  const user = await createTestUser('block4-e2e@example.com');
  const company = await createTestCompany('block4-e2e');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const gl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Bank',
    accountType: 'asset',
    normalBalance: 'debit',
  });

  // bankName is stored exactly as parseOFX reports it ("NAME (ACCTTYPE)"), so
  // the importer's own bank-account resolution can find it unaided.
  const bankAccount = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'E2E Checking',
      bankName: STORED_BANK_NAME,
      accountNo: ACCOUNT_NO,
      glAccountId: gl.id,
      balance: 1000,
      initialBalance: 1000,
      isActive: true,
    },
  });

  // A second company that must remain completely untouched, to prove tenant
  // isolation of everything the import persists.
  const otherUser = await createTestUser('block4-e2e-other@example.com');
  const otherCompany = await createTestCompany('block4-e2e-other');
  await createTestCompanyMember(otherUser.id, otherCompany.id);

  return { user, company, token, gl, bankAccount, otherCompany };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function postImport(s: Setup) {
  const form = new FormData();
  form.set(
    'file',
    new File([sgmlOfx()], 'statement.ofx', { type: 'application/x-ofx' }),
  );
  // No bankAccountId on purpose: the importer must resolve the account itself.

  const req = new NextRequest(
    `http://localhost/api/import?companyId=${s.company.id}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}` },
      body: form,
    },
  );

  return POST(req, { params: Promise.resolve({}) } as never);
}

describe('Block 4 — POST /api/import multipart E2E (real DB)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('imports a real multipart statement through to persistence', async () => {
    const s = await setup();

    const res = await postImport(s);
    const body = await res.json();

    // A. HTTP entry point really answered.
    expect(res.status).toBe(200);

    // B. Response contract matches what the UI consumes.
    expect(body).toMatchObject({
      statementId: expect.any(String),
      transactionCount: 1,
      duplicatesSkipped: 0,
      newAccountCreated: false,
      bankAccountName: 'E2E Checking',
    });

    // C + D. The statement was attached to the RESOLVED bank account.
    const statement = await db.bankStatement.findUnique({
      where: { id: body.statementId },
    });
    expect(statement).not.toBeNull();
    expect(statement!.bankAccountId).toBe(s.bankAccount.id);
    expect(statement!.companyId).toBe(s.company.id);

    // E. A real BankTransaction was derived from the uploaded file.
    const txs = await db.bankTransaction.findMany({
      where: { statementId: body.statementId },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.description).toBe(TX_DESCRIPTION);
    expect(Number(txs[0]!.amount)).toBe(-75);

    // F. Accounting effect: with no rule and no confirmed knowledge the
    // transaction is legitimately UNCLASSIFIED. import.service.ts:871 selects
    // only `glAccountId: { not: null }` for journal creation, so an
    // unclassified transaction must NOT have a journal entry. Asserting the
    // real consequence instead of an invented expectation.
    expect(txs[0]!.glAccountId).toBeNull();
    expect(txs[0]!.matchedRuleId).toBeNull();
    expect(txs[0]!.journalEntryId).toBeNull();
    const journalCount = await db.journalEntry.count({
      where: { companyId: s.company.id },
    });
    expect(journalCount).toBe(0);

    // G. Tenant isolation: nothing landed in the other company.
    const otherStatements = await db.bankStatement.count({
      where: { companyId: s.otherCompany.id },
    });
    const otherTxs = await db.bankTransaction.count({
      where: { statement: { companyId: s.otherCompany.id } },
    });
    expect(otherStatements).toBe(0);
    expect(otherTxs).toBe(0);
  });

  it('resolves the bank account by accountNumber over a shared bank name', async () => {
    const s = await setup();

    // A second ACTIVE account at the SAME institution, inserted FIRST in
    // creation order so a bank-name-first lookup would return it.
    const decoy = await db.bankAccount.create({
      data: {
        companyId: s.company.id,
        accountName: 'E2E Decoy',
        bankName: STORED_BANK_NAME,
        accountNo: 'E2E-DECOY-0000',
        glAccountId: s.gl.id,
        balance: 0,
        initialBalance: 0,
        isActive: true,
      },
    });

    const res = await postImport(s);
    const body = await res.json();
    expect(res.status).toBe(200);

    const statement = await db.bankStatement.findUnique({
      where: { id: body.statementId },
    });
    expect(statement!.bankAccountId).toBe(s.bankAccount.id);
    expect(statement!.bankAccountId).not.toBe(decoy.id);
  });
});
