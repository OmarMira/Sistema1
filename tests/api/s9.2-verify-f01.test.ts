/**
 * S9.2.VERIFY — F-01: Fiscal Period Overlap Verification
 *
 * Forensic validation: is the TOCTOU in POST /api/fiscal-periods reproducible?
 * Sends N=20 concurrent requests with overlapping date ranges, 5 runs.
 *
 * Classification criteria:
 * - CONFIRMED_REPRODUCIBLE: overlaps in ALL 5 runs
 * - INTERMITTENT: overlaps in some but not all runs
 * - FALSE_POSITIVE: overlaps NEVER found
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { AsyncLocalStorage } from 'async_hooks';

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 'verify-f01-user'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(async () => undefined),
  requireActiveTenantAccess: vi.fn(async () => undefined),
}));
vi.mock('@/lib/context-storage', () => {
  const storage = new AsyncLocalStorage();
  return {
    requireCompanyContext: vi.fn(() => {
      const ctx = storage.getStore();
      if (!ctx?.companyId) throw new Error('Company context required');
      return ctx;
    }),
    requireCurrentUserId: vi.fn(() => 'verify-f01-user'),
    requestContext: {
      run: (ctx: unknown, fn: () => Promise<unknown>) => storage.run(ctx, fn),
    },
  };
});
vi.mock('@/lib/cache', () => ({
  companySettingsCache: { invalidate: vi.fn() },
}));
vi.mock('@/lib/server-i18n', () => ({
  serverT: vi.fn((_l: string, k: string) => k),
}));
vi.mock('@/lib/validate-request', () => ({
  validateRequest: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    return body;
  }),
}));

// ── Constants ────────────────────────────────────────────────────────
const CID = `verify-f01-company-${Date.now()}`;
const BASE = `http://localhost/api`;
const N = 20; // concurrent requests per run
const RUNS = 5;

// ── Helpers ──────────────────────────────────────────────────────────
async function cleanFiscalPeriods() {
  await db.auditLog.deleteMany({ where: { companyId: CID } });
  await db.fiscalPeriod.deleteMany({ where: { companyId: CID } });
}

function buildRequest(name: string, startDate: string, endDate: string) {
  return new NextRequest(`${BASE}/fiscal-periods?companyId=${CID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-locale': 'es' },
    body: JSON.stringify({ name, startDate, endDate }),
  });
}

function detectOverlaps(periods: Array<{ id: string; name: string; startDate: Date; endDate: Date }>) {
  const overlaps: Array<{
    a: { id: string; name: string; startDate: Date; endDate: Date };
    b: { id: string; name: string; startDate: Date; endDate: Date };
  }> = [];
  for (let i = 0; i < periods.length; i++) {
    for (let j = i + 1; j < periods.length; j++) {
      const a = periods[i];
      const b = periods[j];
      if (a.startDate < b.endDate && a.endDate > b.startDate) {
        overlaps.push({ a, b });
      }
    }
  }
  return overlaps;
}

// ── Setup ────────────────────────────────────────────────────────────
beforeAll(async () => {
  await db.company.upsert({
    where: { id: CID }, update: {},
    create: { id: CID, legalName: 'Verify F01 Co', entityType: 'BUSINESS', isActive: true },
  });
});

afterAll(async () => {
  await cleanFiscalPeriods();
  await db.company.delete({ where: { id: CID } }).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════
// F-01: Fiscal Period Overlap — 5 Runs × N=20
// ═══════════════════════════════════════════════════════════════════════
describe('F-01: Fiscal Period Overlap — Forensic Verification', () => {
  const results: Array<{
    run: number;
    requests: number;
    count200: number;
    count409: number;
    count500: number;
    periodsCreated: number;
    overlapsFound: boolean;
    overlapDetails: string[];
  }> = [];

  afterAll(async () => {
    // Print final results table
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('F-01 RESULTS TABLE');
    console.log('═══════════════════════════════════════════════════════');
    console.log('| Run | Requests | 200 | 409 | 500 | Periods Created | Overlaps Found |');
    console.log('|-----|----------|-----|-----|-----|----------------|----------------|');
    for (const r of results) {
      console.log(`| ${r.run}   | ${r.requests}       | ${r.count200}   | ${r.count409}   | ${r.count500}   | ${r.periodsCreated}              | ${r.overlapsFound ? 'YES' : 'NO'}            |`);
    }

    const runsWithOverlaps = results.filter(r => r.overlapsFound).length;
    console.log(`\nReproduction rate: ${runsWithOverlaps}/${RUNS} runs`);

    let classification: string;
    if (runsWithOverlaps === RUNS) {
      classification = 'CONFIRMED_REPRODUCIBLE';
    } else if (runsWithOverlaps > 0) {
      classification = 'INTERMITTENT';
    } else {
      classification = 'FALSE_POSITIVE';
    }
    console.log(`Classification: ${classification}`);

    // Print overlap evidence for each run
    for (const r of results) {
      if (r.overlapsFound) {
        console.log(`\n--- Run ${r.run} Overlap Evidence ---`);
        for (const detail of r.overlapDetails) {
          console.log(detail);
        }
      }
    }
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`Run ${run}/${RUNS}: 20 concurrent overlapping fiscal periods`, async () => {
      await cleanFiscalPeriods();

      const { POST } = await import('@/app/api/fiscal-periods/route');

      // All requests overlap: same month range, different names
      const responses = await Promise.all(
        Array.from({ length: N }, (_, i) => {
          const req = buildRequest(
            `F01-Run${run}-P${i}`,
            '2026-06-01',
            '2026-06-30',
          );
          return POST(req, { params: Promise.resolve({}) });
        }),
      );

      const statuses = await Promise.all(responses.map((r) => r.status));
      const count200 = statuses.filter((s) => s === 200).length;
      const count409 = statuses.filter((s) => s === 409).length;
      const count500 = statuses.filter((s) => s === 500).length;

      // Query all periods created
      const periods = await db.fiscalPeriod.findMany({
        where: { companyId: CID },
        orderBy: { startDate: 'asc' },
      });

      // Detect overlaps
      const overlaps = detectOverlaps(periods);
      const overlapDetails: string[] = [];
      for (const o of overlaps) {
        overlapDetails.push(
          `OVERLAP: "${o.a.name}" (${o.a.startDate.toISOString().slice(0, 10)} → ${o.a.endDate.toISOString().slice(0, 10)}) ` +
          `× "${o.b.name}" (${o.b.startDate.toISOString().slice(0, 10)} → ${o.b.endDate.toISOString().slice(0, 10)})`
        );
      }

      // SQL overlap detection query
      const sqlOverlaps = await db.$queryRaw`
        SELECT a.id, a.name, a."startDate", a."endDate", b.id as id2, b.name as name2, b."startDate" as startDate2, b."endDate" as endDate2
        FROM "FiscalPeriod" a
        JOIN "FiscalPeriod" b ON a."companyId" = b."companyId"
          AND a.id < b.id
          AND a."startDate" < b."endDate"
          AND a."endDate" > b."startDate"
        WHERE a."companyId" = ${CID}
      ` as Array<{ id: string; name: string; startDate: Date; endDate: Date; id2: string; name2: string; startDate2: Date; endDate2: Date }>;

      // Log run results
      console.log(`\n--- Run ${run} ---`);
      console.log(`Requests: ${N}, 200: ${count200}, 409: ${count409}, 500: ${count500}`);
      console.log(`Periods created in DB: ${periods.length}`);
      console.log(`Overlaps detected (in-memory): ${overlaps.length}`);
      console.log(`Overlaps detected (SQL): ${sqlOverlaps.length}`);

      if (periods.length > 0) {
        console.log('Period records:');
        for (const p of periods) {
          console.log(`  [${p.id.slice(0, 8)}] "${p.name}" ${p.startDate.toISOString().slice(0, 10)} → ${p.endDate.toISOString().slice(0, 10)}`);
        }
      }

      if (overlapDetails.length > 0) {
        console.log('Overlap details:');
        for (const d of overlapDetails) {
          console.log(`  ${d}`);
        }
      }

      // Store results
      results.push({
        run,
        requests: N,
        count200,
        count409,
        count500,
        periodsCreated: periods.length,
        overlapsFound: overlaps.length > 0 || sqlOverlaps.length > 0,
        overlapDetails,
      });

      // Assertions
      expect(count500).toBe(0);
      expect(periods.length).toBeGreaterThanOrEqual(1);

      // The key question: did the TOCTOU exploit succeed?
      // If more than 1 period was created with overlapping dates, the answer is YES
      if (periods.length > 1) {
        expect(overlaps.length).toBeGreaterThan(0);
      }
    });
  }
});
