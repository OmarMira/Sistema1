// Block 4 FIX-1 — multi-account bank resolution (test for the product change).
//
// Demonstrates the demonstrated product gap:
//   findOrCreateBankAccount resolved by bankName BEFORE accountNumber, so a
//   company holding two accounts at the same institution had every statement
//   silently attached to whichever account the bank-name lookup returned
//   first — regardless of the account number on the statement itself.
//
// Resolution precedence under test: explicit bankAccountId > accountNumber >
// bankName fallback.
//
// This test drives the REAL productive path (ImportService.importFile over an
// OFX statement, the only format that carries an account number into
// findOrCreateBankAccount) and asserts WHICH bank account the statement and
// its transactions were attached to. It reads the persisted statement, so it
// cannot pass by inspecting return values alone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { ImportService } from '@/lib/services/import.service';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const SHARED_BANK = 'Shared Institution';
// parseOFX returns bankName as `${BANKNAME} (${ACCTTYPE})`, so the value the
// importer actually looks up carries the account-type suffix. The stored
// accounts MUST use that exact value for the bank-name lookup to match at all
// — which is precisely the condition under which the shared bank name can
// capture the wrong account.
const STORED_BANK_NAME = `${SHARED_BANK} (CHECKING)`;
const ACCOUNT_A = 'ACCOUNT-A';
const ACCOUNT_B = 'ACCOUNT-B';
const TX_DESCRIPTION = 'FIX1 MERCHANT';

function ofxStatement(accountId: string): string {
  return `<?OFX OFXHEADER="200" VERSION="200"?>
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS></SONRS>
  </SIGNONMSGSRSV1>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <TRNUID>1</TRNUID>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKNAME>${SHARED_BANK}</BANKNAME>
        <BANKACCTFROM>
          <BANKID>987654321</BANKID>
          <ACCTID>${accountId}</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20250301000000</DTSTART>
          <DTEND>20250331000000</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20250315</DTPOSTED>
            <TRNAMT>-100.00</TRNAMT>
            <FITID>FIX1-FIT-1</FITID>
            <NAME>${TX_DESCRIPTION}</NAME>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>100.00</BALAMT>
          <DTASOF>20250331120000</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
}

async function setupTwoAccountsAtSameBank() {
  const user = await createTestUser('fix1-multiacct@example.com');
  const company = await createTestCompany('fix1-multiacct');
  await createTestCompanyMember(user.id, company.id);

  const gl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Bank',
    accountType: 'asset',
    normalBalance: 'debit',
  });

  // Two ACTIVE accounts at the SAME institution, distinguished only by
  // account number — the exact shape that defeated bank-name resolution.
  const accountA = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'Shared Institution A',
      bankName: STORED_BANK_NAME,
      accountNo: ACCOUNT_A,
      glAccountId: gl.id,
      balance: 0,
      initialBalance: 0,
      isActive: true,
    },
  });
  const accountB = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'Shared Institution B',
      bankName: STORED_BANK_NAME,
      accountNo: ACCOUNT_B,
      glAccountId: gl.id,
      balance: 0,
      initialBalance: 0,
      isActive: true,
    },
  });

  return { user, company, gl, accountA, accountB };
}

type Setup = Awaited<ReturnType<typeof setupTwoAccountsAtSameBank>>;

async function importOfx(s: Setup, accountId: string, bankAccountId: string | null) {
  const content = ofxStatement(accountId);
  return ImportService.importFile({
    companyId: s.company.id,
    bankAccountId,
    fileName: `statement-${accountId}.ofx`,
    extension: 'ofx',
    buffer: Buffer.from(content),
    content,
    userId: s.user.id,
  });
}

/** Which bank account did the imported statement actually attach to? */
async function persistedBankAccountIdFor(
  companyId: string,
  description: string,
): Promise<string | null> {
  const tx = await db.bankTransaction.findFirst({
    where: { statement: { companyId }, description },
    include: { statement: { select: { bankAccountId: true } } },
  });
  return tx?.statement.bankAccountId ?? null;
}

describe('Block 4 FIX-1 — bank account resolution precedence', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('resolves by accountNumber even when another account shares the same bankName', async () => {
    const s = await setupTwoAccountsAtSameBank();

    // No explicit bankAccountId. The statement carries ACCOUNT_B; BOTH
    // accounts share the same bankName.
    await importOfx(s, ACCOUNT_B, null);

    const attachedTo = await persistedBankAccountIdFor(s.company.id, TX_DESCRIPTION);

    // The shared bank name must NOT capture ACCOUNT_B's statement into A.
    expect(attachedTo).toBe(s.accountB.id);
    expect(attachedTo).not.toBe(s.accountA.id);

    // And the statement itself must live on B, not on A.
    const statements = await db.bankStatement.findMany({
      where: { companyId: s.company.id },
      select: { bankAccountId: true },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.bankAccountId).toBe(s.accountB.id);
  });

  it('keeps explicit bankAccountId above accountNumber', async () => {
    const s = await setupTwoAccountsAtSameBank();

    // Statement says ACCOUNT_B, but the caller explicitly selected A.
    // Explicit id must still win.
    await importOfx(s, ACCOUNT_B, s.accountA.id);

    const attachedTo = await persistedBankAccountIdFor(s.company.id, TX_DESCRIPTION);
    expect(attachedTo).toBe(s.accountA.id);
  });
});
