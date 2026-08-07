import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { parseCSV } from '@/lib/csv-parser';
import { generateImportHash } from '@/lib/accounting/import-hash';
import { toDateString, toStatementMonth } from '@/lib/accounting/date-window';

const CHILD = join(__dirname, 'parsers-tz-child.ts');
const TIMEZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/Madrid', 'Asia/Tokyo'];
const VECTORS = ['2026-01-01', '2026-03-01', '2026-12-31', '2024-02-29'];

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

describe('D8 civil-date timezone regression (separate Node subprocess per TZ)', () => {
  it.each(TIMEZONES)(
    'the civil-date helper pins YYYY-MM-DDT00:00:00.000Z for all four vectors under TZ=%s',
    (tz) => {
      const out = runChild(tz);
      for (const v of VECTORS) {
        expect(out.get(`helper:${v}`), `helper:${v} under TZ=${tz}`).toBe(
          `${v}T00:00:00.000Z`,
        );
        expect(out.get(`str:${v}`), `str:${v} under TZ=${tz}`).toBe(`${v}T00:00:00.000Z`);
      }
    },
  );

  it.each(TIMEZONES)(
    'the dedup material (txDate|statementMonth|importHash) is canonical under TZ=%s',
    (tz) => {
      const out = runChild(tz);
      for (const v of VECTORS) {
        expect(out.get(`hash:${v}`), `hash:${v} under TZ=${tz}`).toBe(
          `${v}|${v.slice(0, 7)}|${expectedHash(v)}`,
        );
      }
    },
  );

  it('the same transaction produces identical dedup material across all five timezones', () => {
    const byTz = TIMEZONES.map((tz) => runChild(tz));
    const base = byTz[0]!;
    for (const key of base.keys()) {
      if (!key.startsWith('hash:')) continue;
      for (const other of byTz) {
        expect(other.get(key), `${key} differs across timezones`).toBe(base.get(key));
      }
    }
  });
});

function expectedHash(v: string): string {
  const date = new Date(`${v}T00:00:00.000Z`);
  return generateImportHash({
    companyId: 'company-d8',
    accountNumber: 'acct-0001',
    statementMonth: toStatementMonth(date),
    txDate: toDateString(date),
    amount: 42.5,
    description: 'Same   Description ',
  });
}

describe('D8 real CSV parser regression (in-process, repo resolver)', () => {
  it('parses every supported date format to the canonical UTC-midnight instant', () => {
    const csv = [
      'Date,Description,Amount',
      '2026-01-01,iso,1.00',
      '03/01/2026,slash,1.00',
      '25/12/2026,ddmm,1.00',
      '15 Jan 2026,text,1.00',
    ].join('\n');
    const txs = parseCSV(csv);
    expect(txs.map((t) => t.date.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-12-25T00:00:00.000Z',
      '2026-01-15T00:00:00.000Z',
    ]);
  });

  it('skips rows with nonexistent civil dates instead of silently rolling them over', () => {
    const csv = [
      'Date,Description,Amount',
      '2026-02-30,rollover,1.00',
      '2025-02-29,nonleap,1.00',
      '2026-01-01,valid,1.00',
    ].join('\n');
    const txs = parseCSV(csv);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.description).toBe('valid');
    expect(txs[0]!.date.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
