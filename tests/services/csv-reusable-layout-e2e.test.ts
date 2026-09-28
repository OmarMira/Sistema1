// CSV reusable format knowledge — causal E2E (CSV-2.1 §15).
//
// Every case drives the REAL productive boundary: ImportService.importFile
// over the real test database (Prisma, tenant lookup, persistence, mapping
// application and ImportService itself are product code, never mocked).
//
//   CASE 1 — first import: no stored knowledge -> discovery runs exactly
//            once -> the discovered mapping is persisted under the exact
//            structural fingerprint (delimiter + "\n" + ordered normalized
//            headers joined with "\u001F").
//   CASE 2 — second import with the same layout: stored mapping reused,
//            discovery call-count delta = 0 (the reuse proof).
//   CASE 3 — a different layout is a different identity: discovery again,
//            second profile row, first row untouched (reference index 3
//            proves the non-null reference path persists).
//   CASE 4 — tenant isolation: another company importing the same layout
//            cannot see the first company's profile -> its own discovery,
//            its own profile row.
//   CASE 5 — stale mapping: a stored but wrong (in-range) mapping yields
//            zero valid rows on apply, falls back to discovery and is
//            repaired in place via upsert.
//
// The ONLY instrument in this file is an observational call-count wrapper
// around discoverCsvMapping: every call still executes the REAL function
// and returns its real result; nothing about behavior is substituted.
// No Prisma/persistence/lookup/tenant/applyCsvLayout/ImportService mock
// exists here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { ImportService } from '@/lib/services/import.service';
import {
  inspectCsvLayout,
  csvLayoutFingerprint,
  discoverCsvMapping,
} from '@/lib/csv-parser';
import {
  createTestCompany,
  createTestGlAccount,
  createTestBankAccount,
  clearDatabase,
} from '../helpers/factories';

// ─── §15 — observational call-count wrapper (passthrough, real impl) ──

vi.mock('@/lib/csv-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csv-parser')>();
  return { ...actual, discoverCsvMapping: vi.fn(actual.discoverCsvMapping) };
});
const discoverySpy = vi.mocked(discoverCsvMapping);

// ─── Fixtures ─────────────────────────────────────────────────────────
// Every import uses globally distinct rows so duplicate-skip semantics can
// never mask a reuse result; only the LAYOUT (headers + delimiter) repeats.

// Layout A: comma, headers date/description/amount — CASE 1
const CSV_A1 =
  'date,description,amount\n2026-01-15,WALMART MEXICO,-250.00\n2026-01-16,AMAZON MKTPLACE,45.99\n';
// Layout A — CASE 2 first import (seeds the profile)
const CSV_A2_FIRST =
  'date,description,amount\n2026-02-10,COSTCO,-88.40\n2026-02-11,SHELL STATION,-60.00\n';
// Layout A — CASE 2 second import (the reuse proof)
const CSV_A2_SECOND = 'date,description,amount\n2026-02-20,SPOTIFY AB,-9.99\n';
// Layout A — CASE 3 first import
const CSV_A3 = 'date,description,amount\n2026-03-05,TARGET CORP,-33.10\n';
// Layout B: semicolon, headers fecha/concepto/importe/referencia — CASE 3
const CSV_B =
  'fecha;concepto;importe;referencia\n2026-03-08;PEMEX GASOLINA;350.50;REF-777\n';
// Layout A — CASE 4 tenant A
const CSV_A4 =
  'date,description,amount\n2026-04-05,HOMEDEPOT,-120.00\n2026-04-06,UBER TRIP,-15.30\n';
// Layout A — CASE 4 tenant B (same layout, distinct rows)
const CSV_A4_B = 'date,description,amount\n2026-04-10,NETFLIX,-17.99\n';
// Layout A — CASE 5 stale-repair import
const CSV_A5 =
  'date,description,amount\n2026-05-05,STALE REPAIR CO,-10.00\n2026-05-06,STALE REPAIR CO,-20.00\n';

// Structural identities, pinned as literals per the §8 contract:
// delimiter + "\n" + orderedNormalizedHeaders.join("\u001F").
const FP_A = ',\ndate\u001Fdescription\u001Famount';
const FP_B = ';\nfecha\u001Fconcepto\u001Fimporte\u001Freferencia';

// Companies created by this file (scoped cleanup — clearDatabase only
// discovers companies through @example.com users).
let touchedCompanyIds: string[] = [];

async function setupCompany(tag: string) {
  const company = await createTestCompany(`CSV reuse ${tag}`);
  const gl = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bank = await createTestBankAccount(company.id, gl.id);
  touchedCompanyIds.push(company.id);
  return { company, bank };
}

async function runCsv(
  s: { company: { id: string }; bank: { id: string } },
  fileName: string,
  content: string,
) {
  return ImportService.importFile({
    companyId: s.company.id,
    bankAccountId: s.bank.id,
    fileName,
    extension: 'csv',
    buffer: Buffer.from(content),
    content,
  });
}

describe('CSV reusable format knowledge — causal E2E through ImportService.importFile', () => {
  beforeEach(async () => {
    await clearDatabase();
    discoverySpy.mockClear();
  });

  afterEach(async () => {
    if (touchedCompanyIds.length > 0) {
      await db.csvLayoutProfile.deleteMany({
        where: { companyId: { in: touchedCompanyIds } },
      });
      touchedCompanyIds = [];
    }
    await clearDatabase();
    discoverySpy.mockClear();
  });

  it('CASE 1 — first import: no knowledge -> discovery once -> mapping persisted under the exact fingerprint', async () => {
    const s = await setupCompany('case1');

    // The fingerprint contract is pinned both as a literal and through the
    // real inspection implementation.
    expect(csvLayoutFingerprint(inspectCsvLayout(CSV_A1))).toBe(FP_A);

    const before = await db.csvLayoutProfile.findUnique({
      where: {
        companyId_fingerprint: { companyId: s.company.id, fingerprint: FP_A },
      },
    });
    expect(before).toBeNull();

    const result = await runCsv(s, 'case1.csv', CSV_A1);
    expect(result.transactionCount).toBe(2);

    // First import has no stored knowledge -> discovery ran exactly once.
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    const after = await db.csvLayoutProfile.findUnique({
      where: {
        companyId_fingerprint: { companyId: s.company.id, fingerprint: FP_A },
      },
    });
    expect(after).not.toBeNull();
    expect(after!.companyId).toBe(s.company.id);
    expect(after!.fingerprint).toBe(FP_A);
    expect(after!.delimiter).toBe(',');
    expect(after!.dateColumnIndex).toBe(0);
    expect(after!.descriptionColumnIndex).toBe(1);
    expect(after!.amountColumnIndex).toBe(2);
    expect(after!.referenceColumnIndex).toBeNull();
  });

  it('CASE 2 — second import with the same layout reuses the stored mapping: discovery delta = 0', async () => {
    const s = await setupCompany('case2');

    const first = await runCsv(s, 'case2-first.csv', CSV_A2_FIRST);
    expect(first.transactionCount).toBe(2);
    expect(discoverySpy).toHaveBeenCalledTimes(1); // seeded by the first import

    discoverySpy.mockClear();

    // Same layout (same fingerprint), different rows. A successful import
    // with ZERO new discovery calls proves the stored mapping was applied.
    const second = await runCsv(s, 'case2-second.csv', CSV_A2_SECOND);
    expect(second.transactionCount).toBe(1);
    expect(discoverySpy).toHaveBeenCalledTimes(0); // ← reuse: delta = 0

    const rows = await db.csvLayoutProfile.findMany({
      where: { companyId: s.company.id },
    });
    expect(rows).toHaveLength(1); // reused, not duplicated
    expect(rows[0]!.fingerprint).toBe(FP_A);
    expect(rows[0]!.dateColumnIndex).toBe(0);
    expect(rows[0]!.descriptionColumnIndex).toBe(1);
    expect(rows[0]!.amountColumnIndex).toBe(2);
  });

  it('CASE 3 — different layout: new identity -> discovery again -> second profile, first untouched', async () => {
    const s = await setupCompany('case3');

    await runCsv(s, 'case3-a.csv', CSV_A3);
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    discoverySpy.mockClear();

    // New delimiter + new headers = new fingerprint -> lookup misses ->
    // discovery must run again and persist a separate profile.
    const result = await runCsv(s, 'case3-b.csv', CSV_B);
    expect(result.transactionCount).toBe(1);
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    expect(csvLayoutFingerprint(inspectCsvLayout(CSV_B))).toBe(FP_B);

    const rowA = await db.csvLayoutProfile.findUnique({
      where: {
        companyId_fingerprint: { companyId: s.company.id, fingerprint: FP_A },
      },
    });
    expect(rowA).not.toBeNull();
    expect(rowA!.delimiter).toBe(',');
    expect(rowA!.referenceColumnIndex).toBeNull();

    const rowB = await db.csvLayoutProfile.findUnique({
      where: {
        companyId_fingerprint: { companyId: s.company.id, fingerprint: FP_B },
      },
    });
    expect(rowB).not.toBeNull();
    expect(rowB!.delimiter).toBe(';');
    expect(rowB!.dateColumnIndex).toBe(0);
    expect(rowB!.descriptionColumnIndex).toBe(1);
    expect(rowB!.amountColumnIndex).toBe(2);
    expect(rowB!.referenceColumnIndex).toBe(3); // non-null reference persisted

    const total = await db.csvLayoutProfile.count({
      where: { companyId: s.company.id },
    });
    expect(total).toBe(2);
  });

  it('CASE 4 — tenant isolation: another company with the same layout discovers its own profile', async () => {
    const a = await setupCompany('case4-tenant-a');
    const b = await setupCompany('case4-tenant-b');

    await runCsv(a, 'case4-a.csv', CSV_A4);
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    discoverySpy.mockClear();

    // Tenant B has NO stored knowledge for this fingerprint. If the lookup
    // ignored the tenant boundary it would find A's row and skip discovery.
    const result = await runCsv(b, 'case4-b.csv', CSV_A4_B);
    expect(result.transactionCount).toBe(1);
    expect(discoverySpy).toHaveBeenCalledTimes(1); // ← tenant-scoped lookup

    const rows = await db.csvLayoutProfile.findMany({
      where: {
        fingerprint: FP_A,
        companyId: { in: [a.company.id, b.company.id] },
      },
    });
    expect(rows).toHaveLength(2); // one profile per tenant

    const rowA = rows.find((r) => r.companyId === a.company.id)!;
    const rowB = rows.find((r) => r.companyId === b.company.id)!;
    expect(rowA.delimiter).toBe(',');
    expect(rowA.dateColumnIndex).toBe(0);
    expect(rowB.delimiter).toBe(',');
    expect(rowB.dateColumnIndex).toBe(0);
    expect(rowB.descriptionColumnIndex).toBe(1);
  });

  it('CASE 5 — stale mapping: stored wrong mapping rejected -> rediscovered -> repaired in place', async () => {
    const s = await setupCompany('case5');

    // Seed a stale-but-IN-RANGE mapping (date/description swapped): the
    // applicability guard passes, but applying it produces zero valid rows,
    // so the product must fall back to discovery and repair the profile.
    await db.csvLayoutProfile.create({
      data: {
        companyId: s.company.id,
        fingerprint: FP_A,
        delimiter: ',',
        dateColumnIndex: 1, // ← wrong: points at the description column
        descriptionColumnIndex: 0, // ← wrong: points at the date column
        amountColumnIndex: 2,
        referenceColumnIndex: null,
      },
    });

    const result = await runCsv(s, 'case5.csv', CSV_A5);
    expect(result.transactionCount).toBe(2); // recovered through rediscovery
    expect(discoverySpy).toHaveBeenCalledTimes(1); // stale -> discovered again

    const rows = await db.csvLayoutProfile.findMany({
      where: { companyId: s.company.id, fingerprint: FP_A },
    });
    expect(rows).toHaveLength(1); // repaired in place (upsert, no duplicate)
    expect(rows[0]!.delimiter).toBe(',');
    expect(rows[0]!.dateColumnIndex).toBe(0); // ← REPAIRED
    expect(rows[0]!.descriptionColumnIndex).toBe(1); // ← REPAIRED
    expect(rows[0]!.amountColumnIndex).toBe(2);
    expect(rows[0]!.referenceColumnIndex).toBeNull();
  });
});
