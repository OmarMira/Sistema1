/**
 * D8 cross-timezone subprocess probe.
 *
 * NOT a test file: vitest never collects it. The parent test
 * (tests/parsers-timezone-regression.test.ts) spawns this file as its own Node
 * process once per timezone (process.env.TZ set at spawn), so Date behavior is
 * genuinely per-process. Every line printed is `key=value`.
 *
 * Only modules whose transitive imports Node's native type-stripping can
 * resolve are imported here (no extensionless relative imports in the graph).
 */
import { civilDateFromParts, civilDateFromString } from '../src/lib/accounting/civil-date.ts';
import { toDateString, toStatementMonth } from '../src/lib/accounting/date-window.ts';
import { generateImportHash } from '../src/lib/accounting/import-hash.ts';

const VECTORS = ['2026-01-01', '2026-03-01', '2026-12-31', '2024-02-29'];

function print(key: string, value: string) {
  console.log(`${key}=${value}`);
}

for (const v of VECTORS) {
  const [y, m, d] = v.split('-').map(Number);
  const fromParts = civilDateFromParts(y!, m!, d!);
  const fromString = civilDateFromString(v);
  print(`helper:${v}`, fromParts ? fromParts.toISOString() : 'null');
  print(`str:${v}`, fromString ? fromString.toISOString() : 'null');
}

// Dedup material for a single logical transaction. `toDateString`/`toStatementMonth`
// read UTC components, so for a canonical UTC-midnight civil date they are the same
// under every TZ and therefore produce the same importHash.
const companyId = 'company-d8';
const accountNumber = 'acct-0001';
const amount = 42.5;
const description = 'Same   Description ';

for (const v of VECTORS) {
  const date = civilDateFromString(v);
  if (!date) continue;
  const txDate = toDateString(date);
  const statementMonth = toStatementMonth(date);
  const hash = generateImportHash({
    companyId,
    accountNumber,
    statementMonth,
    txDate,
    amount,
    description,
  });
  print(`hash:${v}`, `${txDate}|${statementMonth}|${hash}`);
}
