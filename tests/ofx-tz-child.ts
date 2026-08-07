/**
 * D8 cross-timezone OFX subprocess probe.
 *
 * NOT a test file: vitest never collects it. The parent test
 * (tests/ofx-parser-timezone-regression.test.ts) spawns this file as its own
 * Node process once per timezone (process.env.TZ set at spawn), so Date
 * behavior is genuinely per-process. Every line printed is `key=value`.
 *
 * Only modules whose transitive imports Node's native type-stripping can
 * resolve are imported here (no extensionless relative imports in the graph).
 */
import { parseOFX } from '../src/lib/ofx-parser.ts';

function xmlStatement(posted: string, start: string, end: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <BANKACCTFROM>
          <ACCTID>1001001234</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>${start}</DTSTART>
          <DTEND>${end}</DTEND>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>${posted}</DTPOSTED>
            <TRNAMT>100.00</TRNAMT>
            <FITID>D8</FITID>
            <NAME>TEST</NAME>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>1000.00</BALAMT>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
}

function print(key: string, value: string) {
  console.log(`${key}=${value}`);
}

function probe(label: string, posted: string, start: string, end: string) {
  const result = parseOFX(xmlStatement(posted, start, end));
  print(`tx:${label}`, result.transactions[0]!.date.toISOString());
  print(`start:${label}`, result.startDate.toISOString());
  print(`end:${label}`, result.endDate.toISOString());
}

// Civil dates without an explicit offset -> YYYY-MM-DDT00:00:00.000Z.
probe('leap', '20240229', '20240201', '20240229');
probe('nye', '20251231', '20251201', '20251231');
probe('newyear', '20260101', '20260101', '20260131');
probe('fom', '20260301', '20260301', '20260331');
probe('dstspring', '20260308', '20260301', '20260331');
probe('dstfall', '20261101', '20261101', '20261130');
probe('full', '20260228143000', '20260201', '20260228');
probe('rollover', '20260230', '20260201', '20260228');

// Statement boundary dates.
probe('boundary', '20260215', '20260201', '20260228');

// Explicit-offset values -> preserve the true instant.
probe('offset-est', '20260315120000[-5:EST]', '20260301', '20260331');
probe('offset-cet', '20260101120000[+1.0:CET]', '20260101', '20260131');
probe('offset-edt', '20261107123000[-4:EDT]', '20261101', '20261130');
probe('offset-gmt', '20260210150000[0:GMT]', '20260201', '20260228');
probe('offset-gmtpref', '20260210150000[gmt:0]', '20260201', '20260228');
