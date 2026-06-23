import { describe, it, expect } from 'vitest';
import { parseOFX, ParsedOFX } from '@/lib/ofx-parser';

// ─── Helpers ──────────────────────────────────────────────────────────

function buildXMLOFX(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="200"?>
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <DTSERVER>20250301120000</DTSERVER>
      <LANGUAGE>ENG</LANGUAGE>
    </SONRS>
  </SIGNONMSGSRSV1>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <TRNUID>1</TRNUID>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM>
          <BANKID>123456789</BANKID>
          <ACCTID>1001001234</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20250301000000</DTSTART>
          <DTEND>20250331000000</DTEND>
          ${body}
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>3450.00</BALAMT>
          <DTASOF>20250331120000</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
}

function xmlTransaction(
  type: string,
  date: string,
  amount: string,
  fitId: string,
  name: string,
): string {
  return `<STMTTRN>
    <TRNTYPE>${type}</TRNTYPE>
    <DTPOSTED>${date}</DTPOSTED>
    <TRNAMT>${amount}</TRNAMT>
    <FITID>${fitId}</FITID>
    <NAME>${name}</NAME>
  </STMTTRN>`;
}

function buildSGMLOFX(body: string): string {
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
<BANKACCTFROM>
<BANKID>123456789
<ACCTID>1001001234
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20250301000000
<DTEND>20250331000000
${body}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>3450.00
<DTASOF>20250331120000
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
}

function sgmlTransaction(
  type: string,
  date: string,
  amount: string,
  fitId: string,
  name: string,
): string {
  return `<STMTTRN>
<TRNTYPE>${type}
<DTPOSTED>${date}
<TRNAMT>${amount}
<FITID>${fitId}
<NAME>${name}
</STMTTRN>`;
}

// ─── XML Parsing (OFX v2) ─────────────────────────────────────────────

describe('parseOFX — XML (OFX v2)', () => {
  it('parses a full realistic OFX XML with multiple transactions', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
      ${xmlTransaction('CREDIT', '20250305120000', '2500.00', 'TRN002', 'SALARY DEPOSIT')}
      ${xmlTransaction('DEBIT', '20250310140000', '-1500.00', 'TRN003', 'RENT PAYMENT')}
    `);

    const result = parseOFX(xml);

    expect(result).toBeDefined();
    expect(result.bankName).toBe('Unknown Bank (CHECKING)');
    expect(result.accountNumber).toBe('1001001234');
    expect(result.transactions).toHaveLength(3);
    expect(result.closingBalance).toBe(3450.00);
    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.endDate).toBeInstanceOf(Date);
  });

  it('extracts BANKNAME from XML content', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
    `);
    // Insert BANKNAME inside the STMTRS block
    xml = xml.replace('<BANKACCTFROM>', '<BANKNAME>Test Bank</BANKNAME>\n    <BANKACCTFROM>');

    const result = parseOFX(xml);
    expect(result.bankName).toMatch(/Test Bank/);
  });

  it('extracts ORG as fallback for bank name when BANKNAME is missing', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
    `);
    xml = xml.replace('<BANKACCTFROM>', '<ORG>National Bank</ORG>\n    <BANKACCTFROM>');

    const result = parseOFX(xml);
    expect(result.bankName).toMatch(/National Bank/);
  });

  it('extracts AVAILBAL when LEDGERBAL is absent', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
    `);
    // Remove LEDGERBAL and add AVAILBAL
    xml = xml.replace(
      /<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/,
      '<AVAILBAL><BALAMT>5000.00</BALAMT><DTASOF>20250331120000</DTASOF></AVAILBAL>',
    );

    const result = parseOFX(xml);
    expect(result.closingBalance).toBe(5000.00);
  });

  it('defaults closingBalance to 0 when no BALAMT is found', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
    `);
    // Remove the LEDGERBAL block entirely
    xml = xml.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/, '');

    const result = parseOFX(xml);
    expect(result.closingBalance).toBe(0);
  });

  it('parses transaction fields correctly', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250315143000', '-89.99', 'TRN010', 'UBER EATS')}
    `);

    const result = parseOFX(xml);
    const txn = result.transactions[0];

    expect(txn.description).toBe('UBER EATS');
    expect(txn.amount).toBe(-89.99);
    expect(txn.reference).toBe('TRN010');
    expect(txn.date.getFullYear()).toBe(2025);
    expect(txn.date.getMonth()).toBe(2); // March (0-indexed)
    expect(txn.date.getDate()).toBe(15);
    expect(txn.date.getHours()).toBe(14);
    expect(txn.date.getMinutes()).toBe(30);
  });

  it('uses PAYEE as fallback when NAME is missing', () => {
    const xml = buildXMLOFX(`
      <STMTTRN>
        <TRNTYPE>CREDIT</TRNTYPE>
        <DTPOSTED>20250301080000</DTPOSTED>
        <TRNAMT>100.00</TRNAMT>
        <FITID>TRN020</FITID>
        <PAYEE>Direct Deposit</PAYEE>
      </STMTTRN>
    `);

    const result = parseOFX(xml);
    expect(result.transactions[0].description).toBe('Direct Deposit');
  });

  it('handles multiple transactions with credits and debits', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '5000.00', 'TRN100', 'SALARY')}
      ${xmlTransaction('DEBIT', '20250302080000', '-1500.00', 'TRN101', 'RENT')}
      ${xmlTransaction('DEBIT', '20250303080000', '-200.00', 'TRN102', 'GROCERIES')}
      ${xmlTransaction('CREDIT', '20250304080000', '750.00', 'TRN103', 'FREELANCE')}
    `);

    const result = parseOFX(xml);
    expect(result.transactions).toHaveLength(4);

    const credits = result.transactions.filter((t) => t.amount > 0);
    const debits = result.transactions.filter((t) => t.amount < 0);
    expect(credits).toHaveLength(2);
    expect(debits).toHaveLength(2);

    // openingBalance = closingBalance - totalCredits + totalDebits
    // 3450 - (5000 + 750) + (1500 + 200) = 3450 - 5750 + 1700 = -600
    expect(result.openingBalance).toBeCloseTo(-600, 1);
  });

  it('sorts transactions by date ascending', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250315080000', '-30.00', 'TRN200', 'LATE')}
      ${xmlTransaction('CREDIT', '20250301080000', '1000.00', 'TRN201', 'EARLY')}
      ${xmlTransaction('DEBIT', '20250310080000', '-50.00', 'TRN202', 'MIDDLE')}
    `);

    const result = parseOFX(xml);
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0].reference).toBe('TRN201'); // March 1
    expect(result.transactions[1].reference).toBe('TRN202'); // March 10
    expect(result.transactions[2].reference).toBe('TRN200'); // March 15
  });

  it('uses transaction dates as startDate/endDate when DTSTART/DTEND are missing', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '100.00', 'TRN300', 'FIRST')}
      ${xmlTransaction('CREDIT', '20250331080000', '200.00', 'TRN301', 'LAST')}
    `);
    // Remove DTSTART/DTEND
    xml = xml.replace(/<DTSTART>.*?<\/DTSTART>\s*<DTEND>.*?<\/DTEND>\s*/g, '');

    const result = parseOFX(xml);
    expect(result.startDate.getMonth()).toBe(2); // March
    expect(result.startDate.getDate()).toBe(1);
    expect(result.endDate.getMonth()).toBe(2);
    expect(result.endDate.getDate()).toBe(31);
  });
});

// ─── SGML Parsing (OFX v1) ────────────────────────────────────────────

describe('parseOFX — SGML (OFX v1)', () => {
  it('parses a full realistic OFX SGML with multiple transactions', () => {
    const sgml = buildSGMLOFX(`
${sgmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
${sgmlTransaction('CREDIT', '20250305120000', '2500.00', 'TRN002', 'SALARY DEPOSIT')}
${sgmlTransaction('DEBIT', '20250310140000', '-1500.00', 'TRN003', 'RENT PAYMENT')}
    `);

    const result = parseOFX(sgml);

    expect(result).toBeDefined();
    expect(result.bankName).toBe('Unknown Bank (CHECKING)');
    expect(result.accountNumber).toBe('1001001234');
    expect(result.transactions).toHaveLength(3);
    expect(result.closingBalance).toBe(3450.00);
  });

  it('parses SGML transaction fields correctly', () => {
    const sgml = buildSGMLOFX(`
${sgmlTransaction('DEBIT', '20250315143000', '-89.99', 'TRN010', 'UBER EATS')}
    `);

    const result = parseOFX(sgml);
    const txn = result.transactions[0];

    expect(txn.description).toBe('UBER EATS');
    expect(txn.amount).toBe(-89.99);
    expect(txn.reference).toBe('TRN010');
    expect(txn.date.getFullYear()).toBe(2025);
    expect(txn.date.getMonth()).toBe(2);
    expect(txn.date.getDate()).toBe(15);
  });

  it('extracts BANKNAME from SGML content', () => {
    let sgml = buildSGMLOFX(`
${sgmlTransaction('DEBIT', '20250301080000', '-50.00', 'TRN001', 'AMAZON PURCHASE')}
    `);
    sgml = sgml.replace(
      '<BANKACCTFROM>',
      '<BANKNAME>Test Bank\n<BANKACCTFROM>',
    );

    const result = parseOFX(sgml);
    expect(result.bankName).toMatch(/Test Bank/);
  });

  it('handles SGML with no closing tags on values', () => {
    const sgml = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '',
      '<OFX>',
      '<BANKMSGSRSV1>',
      '<STMTTRNRS>',
      '<STMTRS>',
      '<CURDEF>USD',
      '<BANKACCTFROM>',
      '<BANKID>999999',
      '<ACCTID>2002005678',
      '<ACCTTYPE>SAVINGS',
      '</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<DTSTART>20250601',
      '<DTEND>20250630',
      '<STMTTRN>',
      '<TRNTYPE>CREDIT',
      '<DTPOSTED>20250615',
      '<TRNAMT>500.00',
      '<FITID>T001',
      '<NAME>DEPOSIT',
      '</STMTTRN>',
      '</BANKTRANLIST>',
      '<LEDGERBAL>',
      '<BALAMT>5000.00',
      '</LEDGERBAL>',
      '</STMTRS>',
      '</STMTTRNRS>',
      '</BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n');

    const result = parseOFX(sgml);
    expect(result.transactions).toHaveLength(1);
    expect(result.accountNumber).toBe('2002005678');
    expect(result.bankName).toContain('SAVINGS');
    expect(result.closingBalance).toBe(5000.00);
    expect(result.transactions[0].amount).toBe(500.00);
  });

  it('sorts SGML transactions by date ascending', () => {
    const sgml = buildSGMLOFX(`
${sgmlTransaction('DEBIT', '20250315080000', '-30.00', 'TRN200', 'LATE')}
${sgmlTransaction('CREDIT', '20250301080000', '1000.00', 'TRN201', 'EARLY')}
${sgmlTransaction('DEBIT', '20250310080000', '-50.00', 'TRN202', 'MIDDLE')}
    `);

    const result = parseOFX(sgml);
    expect(result.transactions[0].reference).toBe('TRN201');
    expect(result.transactions[1].reference).toBe('TRN202');
    expect(result.transactions[2].reference).toBe('TRN200');
  });
});

// ─── Auto-Detection ───────────────────────────────────────────────────

describe('parseOFX — format auto-detection', () => {
  it('detects XML via <?xml declaration', () => {
    const xml = '<?xml version="1.0"?>\n<OFX>\n</OFX>';
    // Will throw because no transactions, but the important thing
    // is it enters the XML path (not SGML), and the SGML path would throw
    // a different error
    expect(() => parseOFX(xml)).toThrow('No transactions found');
  });

  it('detects XML via <OFX> prefix', () => {
    const content = '<OFX>\n</OFX>';
    expect(() => parseOFX(content)).toThrow('No transactions found');
  });

  it('routes SGML format to SGML parser', () => {
    const sgml = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      '',
      '<OFX>',
      '<BANKMSGSRSV1>',
      '<STMTTRNRS>',
      '<STMTRS>',
      '<BANKACCTFROM>',
      '<ACCTID>1001',
      '<ACCTTYPE>CHECKING',
      '</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<STMTTRN>',
      '<TRNTYPE>CREDIT',
      '<DTPOSTED>20250301',
      '<TRNAMT>100.00',
      '<FITID>X1',
      '<NAME>Test',
      '</STMTTRN>',
      '</BANKTRANLIST>',
      '<LEDGERBAL>',
      '<BALAMT>500.00',
      '</LEDGERBAL>',
      '</STMTRS>',
      '</STMTTRNRS>',
      '</BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n');

    const result = parseOFX(sgml);
    expect(result.transactions).toHaveLength(1);
    expect(result.accountNumber).toBe('1001');
    expect(result.closingBalance).toBe(500);
  });
});

// ─── Date Parsing ─────────────────────────────────────────────────────

describe('parseOFX — date handling', () => {
  it('parses YYYYMMDD dates', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250315', '100.00', 'D1', 'TEST')}
    `);

    const result = parseOFX(xml);
    const date = result.transactions[0].date;
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2); // March
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it('parses YYYYMMDDHHMMSS dates', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250315143000', '100.00', 'D2', 'TEST')}
    `);

    const result = parseOFX(xml);
    const date = result.transactions[0].date;
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(30);
    expect(date.getSeconds()).toBe(0);
  });

  it('strips timezone suffix like [−5:EST]', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250315[-5:EST]', '100.00', 'D3', 'TEST')}
    `);

    const result = parseOFX(xml);
    const date = result.transactions[0].date;
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);

    // Also test with full datetime + timezone
    const xml2 = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250315143000[-5:EST]', '200.00', 'D4', 'TEST')}
    `);
    const result2 = parseOFX(xml2);
    expect(result2.transactions[0].date.getHours()).toBe(14);
    expect(result2.transactions[0].date.getMinutes()).toBe(30);
  });

  it('strips timezone suffix like [−5.0:GMT]', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250315[+1.0:CET]', '100.00', 'D5', 'TEST')}
    `);

    const result = parseOFX(xml);
    const date = result.transactions[0].date;
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
  });

  it('handles dates with milliseconds suffix', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250315143000.123', '100.00', 'D6', 'TEST')}
    `);

    const result = parseOFX(xml);
    const date = result.transactions[0].date;
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(30);
  });
});

// ─── Empty / No Transactions ──────────────────────────────────────────

describe('parseOFX — empty / no transactions', () => {
  it('throws when XML has no STMTTRN blocks', () => {
    const xml = buildXMLOFX('');
    expect(() => parseOFX(xml)).toThrow('No transactions found');
  });

  it('throws when SGML has no STMTTRN blocks', () => {
    const sgml = buildSGMLOFX('');
    expect(() => parseOFX(sgml)).toThrow('No transactions found');
  });

  it('throws on completely empty content', () => {
    expect(() => parseOFX('')).toThrow('No transactions found');
  });

  it('throws on whitespace-only content', () => {
    expect(() => parseOFX('   \n\n  ')).toThrow('No transactions found');
  });

  it('throws when result has no valid transactions after filtering', () => {
    // Transactions with missing required fields should be skipped,
    // resulting in no transactions
    const xml = buildXMLOFX(`
      <STMTTRN>
        <TRNTYPE>DEBIT</TRNTYPE>
        <!-- missing DTPOSTED and TRNAMT -->
        <FITID>INVALID</FITID>
        <NAME>BROKEN</NAME>
      </STMTTRN>
    `);
    expect(() => parseOFX(xml)).toThrow('No transactions found');
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────

describe('parseOFX — edge cases', () => {
  it('handles negative amounts', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-500.00', 'E1', 'WITHDRAWAL')}
    `);

    const result = parseOFX(xml);
    expect(result.transactions[0].amount).toBe(-500.00);
  });

  it('handles positive amounts without + sign', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '1000.00', 'E2', 'DEPOSIT')}
    `);

    const result = parseOFX(xml);
    expect(result.transactions[0].amount).toBe(1000.00);
  });

  it('defaults bankName to "Unknown Bank" when BANKNAME and ORG are missing', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '100.00', 'E3', 'TEST')}
    `);

    const result = parseOFX(xml);
    expect(result.bankName).toBe('Unknown Bank (CHECKING)');
  });

  it('defaults accountNumber to empty string when ACCTID is missing', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '100.00', 'E4', 'TEST')}
    `);
    // Remove ACCTID
    xml = xml.replace(/<ACCTID>.*?<\/ACCTID>\s*/g, '');

    const result = parseOFX(xml);
    expect(result.accountNumber).toBe('');
  });

  it('uses default ACCTTYPE if not found', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '100.00', 'E5', 'TEST')}
    `);
    xml = xml.replace(/<ACCTTYPE>.*?<\/ACCTTYPE>\s*/g, '');

    const result = parseOFX(xml);
    expect(result.bankName).toContain('CHECKING');
  });

  it('handles description with TRNTYPE and FITID when NAME and PAYEE are missing', () => {
    const xml = buildXMLOFX(`
      <STMTTRN>
        <TRNTYPE>DEBIT</TRNTYPE>
        <DTPOSTED>20250301080000</DTPOSTED>
        <TRNAMT>-25.00</TRNAMT>
        <FITID>E6</FITID>
      </STMTTRN>
    `);

    const result = parseOFX(xml);
    expect(result.transactions[0].description).toBe('DEBIT E6');
  });

  it('handles large numbers of transactions', () => {
    const transactions = Array.from({ length: 50 }, (_, i) => {
      const day = (i % 28) + 1;
      const dayStr = day.toString().padStart(2, '0');
      const amount = (i % 2 === 0) ? `-${(i + 1) * 10}.00` : `${(i + 1) * 10}.00`;
      return xmlTransaction('DEBIT', `202503${dayStr}080000`, amount, `B${i}`, `TX ${i}`);
    }).join('\n');

    const xml = buildXMLOFX(`\n${transactions}\n`);

    const result = parseOFX(xml);
    expect(result.transactions).toHaveLength(50);
    // All should be sorted by date
    for (let i = 1; i < result.transactions.length; i++) {
      expect(result.transactions[i].date.getTime()).toBeGreaterThanOrEqual(
        result.transactions[i - 1].date.getTime(),
      );
    }
  });

  it('computes opening balance correctly when all transactions are debits', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-100.00', 'O1', 'EXPENSE1')}
      ${xmlTransaction('DEBIT', '20250302080000', '-200.00', 'O2', 'EXPENSE2')}
    `);

    const result = parseOFX(xml);
    // opening = 3450 - 0 + (100 + 200) = 3750
    expect(result.openingBalance).toBe(3750);
  });

  it('computes opening balance correctly when all transactions are credits', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('CREDIT', '20250301080000', '500.00', 'O3', 'INCOME1')}
      ${xmlTransaction('CREDIT', '20250302080000', '300.00', 'O4', 'INCOME2')}
    `);

    const result = parseOFX(xml);
    // opening = 3450 - (500 + 300) + 0 = 2650
    expect(result.openingBalance).toBe(2650);
  });

  it('computes opening balance when closingBalance is 0', () => {
    let xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250301080000', '-100.00', 'O5', 'EXPENSE')}
      ${xmlTransaction('CREDIT', '20250302080000', '300.00', 'O6', 'INCOME')}
    `);
    xml = xml.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/, '');

    const result = parseOFX(xml);
    // opening = 0 - 300 + 100 = -200
    expect(result.openingBalance).toBe(-200);
  });
});

// ─── Realistic Bank OFX Scenarios ─────────────────────────────────────

describe('parseOFX — realistic bank scenarios', () => {
  it('parses a full checking account statement with mixed transactions', () => {
    const xml = buildXMLOFX(`
      ${xmlTransaction('DEBIT', '20250303100000', '-35.50', 'R001', 'UBER TRIP')}
      ${xmlTransaction('DEBIT', '20250305120000', '-89.99', 'R002', 'NETFLIX SUBSCRIPTION')}
      ${xmlTransaction('CREDIT', '20250306090000', '3200.00', 'R003', 'PAYROLL DEPOSIT')}
      ${xmlTransaction('DEBIT', '20250307150000', '-120.00', 'R004', 'ELECTRIC BILL')}
      ${xmlTransaction('DEBIT', '20250308110000', '-15.75', 'R005', 'COFFEE SHOP')}
      ${xmlTransaction('DEBIT', '20250310180000', '-250.00', 'R006', 'GROCERY STORE')}
      ${xmlTransaction('CREDIT', '20250312140000', '45.00', 'R007', 'REFUND')}
      ${xmlTransaction('DEBIT', '20250315080000', '-1500.00', 'R008', 'RENT PAYMENT')}
    `);

    const result = parseOFX(xml);

    expect(result.transactions).toHaveLength(8);
    expect(result.bankName).toBe('Unknown Bank (CHECKING)');
    expect(result.accountNumber).toBe('1001001234');

    // Check sorting
    for (let i = 1; i < result.transactions.length; i++) {
      expect(result.transactions[i].date.getTime()).toBeGreaterThanOrEqual(
        result.transactions[i - 1].date.getTime(),
      );
    }

    // Calculate expected opening balance
    const totalCredits = 3200 + 45; // 3245
    const totalDebits = 35.50 + 89.99 + 120 + 15.75 + 250 + 1500; // 2011.24
    const expectedOpening = 3450 - 3245 + 2011.24; // 2216.24
    expect(result.openingBalance).toBeCloseTo(expectedOpening, 1);
  });

  it('parses a savings account statement with fewer transactions', () => {
    const sgml = buildSGMLOFX(`
${sgmlTransaction('CREDIT', '20250301080000', '1000.00', 'S001', 'TRANSFER IN')}
${sgmlTransaction('DEBIT', '20250315080000', '-200.00', 'S002', 'TRANSFER OUT')}
${sgmlTransaction('CREDIT', '20250325080000', '50.23', 'S003', 'INTEREST PAYMENT')}
    `);

    const result = parseOFX(sgml);
    expect(result.transactions).toHaveLength(3);
    // 3450 - (1000 + 50.23) + 200 = 2599.77
    expect(result.openingBalance).toBeCloseTo(2599.77, 1);
  });
});
