import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { parseOFX } from '@/lib/ofx-parser';

const CHILD = join(__dirname, 'ofx-tz-child.ts');
const TIMEZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/Madrid', 'Asia/Tokyo'];

function runChild(tz: string): Map<string, string> {
  const res = spawnSync(process.execPath, ['--no-warnings', CHILD], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  expect(res.error, `spawn failed for TZ=${tz}`).toBeUndefined();
  expect(res.status, `child exited non-zero for TZ=${tz}:\n${res.stderr}`).toBe(0);
  const lines = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) lines.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return lines;
}

const EXPECTED_CIVIL: Record<string, string> = {
  'tx:leap': '2024-02-29T00:00:00.000Z',
  'tx:nye': '2025-12-31T00:00:00.000Z',
  'tx:newyear': '2026-01-01T00:00:00.000Z',
  'tx:fom': '2026-03-01T00:00:00.000Z',
  'tx:dstspring': '2026-03-08T00:00:00.000Z',
  'tx:dstfall': '2026-11-01T00:00:00.000Z',
  'tx:full': '2026-02-28T00:00:00.000Z',
  'tx:rollover': '2026-03-02T00:00:00.000Z',
  'start:boundary': '2026-02-01T00:00:00.000Z',
  'end:boundary': '2026-02-28T00:00:00.000Z',
};

const EXPECTED_OFFSET: Record<string, string> = {
  'tx:offset-est': '2026-03-15T17:00:00.000Z',
  'tx:offset-cet': '2026-01-01T11:00:00.000Z',
  'tx:offset-edt': '2026-11-07T16:30:00.000Z',
  'tx:offset-gmt': '2026-02-10T15:00:00.000Z',
  'tx:offset-gmtpref': '2026-02-10T15:00:00.000Z',
};

describe('D8 OFX parser civil-date timezone regression (separate Node subprocess per TZ)', () => {
  it.each(TIMEZONES)(
    'civil DTPOSTED / DTSTART / DTEND pin UTC-midnight under TZ=%s',
    (tz) => {
      const out = runChild(tz);
      for (const [key, iso] of Object.entries(EXPECTED_CIVIL)) {
        expect(out.get(key), `${key} under TZ=${tz}`).toBe(iso);
      }
    },
  );

  it.each(TIMEZONES)(
    'explicit-offset DTPOSTED preserves the true instant under TZ=%s',
    (tz) => {
      const out = runChild(tz);
      for (const [key, iso] of Object.entries(EXPECTED_OFFSET)) {
        expect(out.get(key), `${key} under TZ=${tz}`).toBe(iso);
      }
    },
  );

  it('every parsed OFX date is identical across all five timezones', () => {
    const byTz = TIMEZONES.map((tz) => runChild(tz));
    const base = byTz[0]!;
    for (const key of base.keys()) {
      for (const other of byTz) {
        expect(other.get(key), `${key} differs across timezones`).toBe(base.get(key));
      }
    }
  });

  it('unparseable DTPOSTED keeps the existing fallback semantics (same mechanism)', () => {
    // Fewer than 8 numeric digits -> parseOFXDate falls back to `new Date()`
    // (unchanged behavior), so the transaction is kept with a valid non-NaN date.
    const xml = `<?xml version="1.0"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <BANKACCTFROM><ACCTID>1001001234</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20260201</DTSTART><DTEND>20260228</DTEND>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>202602</DTPOSTED>
            <TRNAMT>100.00</TRNAMT><FITID>BAD1</FITID><NAME>SHORT</NAME>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>1000.00</BALAMT></LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;
    const result = parseOFX(xml);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.date).toBeInstanceOf(Date);
    expect(Number.isNaN(result.transactions[0]!.date.getTime())).toBe(false);
  });
});
