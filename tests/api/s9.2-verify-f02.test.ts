/**
 * S9.2.VERIFY — F-02: Opening Balance Equity TOCTOU Verification
 *
 * Forensic validation: is the findFirst+create pattern in ensureOpeningBalanceEquity
 * exploitable under concurrent load?
 *
 * Sends N=10 concurrent bank creation requests with opening balance > 0.
 * Each triggers ensureOpeningBalanceEquity which uses findFirst+create.
 *
 * Classification criteria:
 * - CONFIRMED_REPRODUCIBLE: failures in ALL 5 runs
 * - INTERMITTENT: failures in some but not all runs
 * - FALSE_POSITIVE: no failures in any run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { AsyncLocalStorage } from 'async_hooks';

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 'verify-f02-user'),
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
    requireCurrentUserId: vi.fn(() => 'verify-f02-user'),
    requestContext: {
      run: (ctx: unknown, fn: () => Promise<unknown>) => storage.run(ctx, fn),
    },
  };
});
vi.mock('@/lib/cache', () => ({
  companySettingsCache: { invalidate: vi.fn() },
  journalAccountsCache: { invalidate: vi.fn() },
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
vi.mock('@/lib/fiscal-period-guard', () => ({
  assertActiveFiscalPeriod: vi.fn(async () => undefined),
}));
vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: vi.fn(async () => ({ id: 'audit-log-id' })),
}));

// ── Constants ────────────────────────────────────────────────────────
const CID = `verify-f02-company-${Date.now()}`;
const BASE = `http://localhost/api`;
const N = 10; // concurrent requests per run
const RUNS = 5;

// ── Helpers ──────────────────────────────────────────────────────────
async function cleanBankData() {
  await db.auditLog.deleteMany({ where: { companyId: CID } });
  await db.bankTransaction.deleteMany({ where: { statement: { bankAccount: { companyId: CID } } } });
  await db.bankStatement.deleteMany({ where: { bankAccount: { companyId: CID } } });
  await db.bankAccount.deleteMany({ where: { companyId: CID } });
  await db.journalLine.deleteMany({ where: { entry: { companyId: CID } } });
  await db.journalEntry.deleteMany({ where: { companyId: CID } });
  await db.glAccount.deleteMany({ where: { companyId: CID } });
}

function buildBankRequest(name: string, glAccountId: string, balance: number) {
  return new NextRequest(`${BASE}/banks?companyId=${CID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountName: name,
      bankName: 'Test Bank',
      glAccountId,
      balance,
      currency: 'USD',
    }),
  });
}

// ── Setup ────────────────────────────────────────────────────────────
beforeAll(async () => {
  await db.company.upsert({
    where: { id: CID }, update: {},
    create: { id: CID, legalName: 'Verify F02 Co', entityType: 'BUSINESS', isActive: true },
  });
});

afterAll(async () => {
  await cleanBankData();
  await db.company.delete({ where: { id: CID } }).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════
// F-02: Opening Balance Equity TOCTOU — 5 Runs × N=10
// ═══════════════════════════════════════════════════════════════════════
describe('F-02: Opening Balance Equity — Forensic Verification', () => {
  const results: Array<{
    run: number;
    requests: number;
    count201: number;
    count400: number;
    count404: number;
    count500: number;
    banksCreated: number;
    glAccountsCreated: number;
    uniqueViolations: string[];
    patternFailures: string[];
  }> = [];

  afterAll(async () => {
    // Print final results table
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('F-02 RESULTS TABLE');
    console.log('═══════════════════════════════════════════════════════');
    console.log('| Run | Requests | 201 | 400 | 404 | 500 | Banks Created | UNIQUE Violations |');
    console.log('|-----|----------|-----|-----|-----|-----|---------------|-------------------|');
    for (const r of results) {
      console.log(`| ${r.run}   | ${r.requests}       | ${r.count201}   | ${r.count400}   | ${r.count404}   | ${r.count500}   | ${r.banksCreated}              | ${r.uniqueViolations.length}               |`);
    }

    const runsWithViolations = results.filter(r => r.uniqueViolations.length > 0 || r.patternFailures.length > 0).length;
    console.log(`\nReproduction rate: ${runsWithViolations}/${RUNS} runs`);

    let classification: string;
    if (runsWithViolations === RUNS) {
      classification = 'CONFIRMED_REPRODUCIBLE';
    } else if (runsWithViolations > 0) {
      classification = 'INTERMITTENT';
    } else {
      classification = 'FALSE_POSITIVE';
    }
    console.log(`Classification: ${classification}`);

    // Print violation evidence for each run
    for (const r of results) {
      if (r.uniqueViolations.length > 0 || r.patternFailures.length > 0) {
        console.log(`\n--- Run ${r.run} Violation Evidence ---`);
        for (const v of r.uniqueViolations) {
          console.log(`  UNIQUE: ${v}`);
        }
        for (const f of r.patternFailures) {
          console.log(`  PATTERN: ${f}`);
        }
      }
    }
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`Run ${run}/${RUNS}: 10 concurrent bank creates with opening balance`, async () => {
      await cleanBankData();

      // Create the GL asset account that banks will reference
      const glAccount = await db.glAccount.create({
        data: {
          companyId: CID,
          code: '1010',
          name: 'Cash',
          accountType: 'asset',
          normalBalance: 'debit',
          isActive: true,
        },
      });

      const { POST } = await import('@/app/api/banks/route');

      // Capture response bodies for error details
      const responseBodies: Array<{ status: number; body: unknown }> = [];

      const responses = await Promise.all(
        Array.from({ length: N }, (_, i) => {
          const req = buildBankRequest(
            `F02-Run${run}-Bank${i}`,
            glAccount.id,
            1000, // balance > 0 triggers ensureOpeningBalanceEquity
          );
          return POST(req, { params: Promise.resolve({}) });
        }),
      );

      // Collect response bodies
      for (const res of responses) {
        const body = await res.json().catch(() => null);
        responseBodies.push({ status: res.status, body });
      }

      const statuses = responseBodies.map(r => r.status);
      const count201 = statuses.filter((s) => s === 201).length;
      const count400 = statuses.filter((s) => s === 400).length;
      const count404 = statuses.filter((s) => s === 404).length;
      const count500 = statuses.filter((s) => s === 500).length;

      // Query DB state
      const banks = await db.bankAccount.findMany({ where: { companyId: CID } });
      const glAccounts = await db.glAccount.findMany({
        where: { companyId: CID, name: 'Opening Balance Equity' },
      });

      // Detect UNIQUE constraint violations in response bodies
      const uniqueViolations: string[] = [];
      const patternFailures: string[] = [];
      for (const r of responseBodies) {
        if (r.status === 500) {
          const bodyStr = JSON.stringify(r.body);
          if (bodyStr.includes('Unique constraint') || bodyStr.includes('unique constraint') || bodyStr.includes('P2002')) {
            uniqueViolations.push(bodyStr.slice(0, 200));
          } else {
            patternFailures.push(bodyStr.slice(0, 200));
          }
        }
        if (r.status === 400) {
          const bodyStr = JSON.stringify(r.body);
          if (bodyStr.includes('Unique constraint') || bodyStr.includes('P2002')) {
            uniqueViolations.push(`400: ${bodyStr.slice(0, 200)}`);
          }
        }
      }

      // Check if findFirst+create pattern failed: more than 1 Opening Balance Equity created
      const multipleEquityAccounts = glAccounts.length > 1;

      // Log run results
      console.log(`\n--- Run ${run} ---`);
      console.log(`Requests: ${N}, 201: ${count201}, 400: ${count400}, 404: ${count404}, 500: ${count500}`);
      console.log(`Banks created in DB: ${banks.length}`);
      console.log(`Opening Balance Equity GL accounts: ${glAccounts.length}`);
      console.log(`Multiple equity accounts: ${multipleEquityAccounts}`);

      if (uniqueViolations.length > 0) {
        console.log('UNIQUE constraint violations:');
        for (const v of uniqueViolations) {
          console.log(`  ${v}`);
        }
      }

      if (patternFailures.length > 0) {
        console.log('Pattern failures (findFirst+create):');
        for (const f of patternFailures) {
          console.log(`  ${f}`);
        }
      }

      // Store results
      results.push({
        run,
        requests: N,
        count201,
        count400,
        count404,
        count500,
        banksCreated: banks.length,
        glAccountsCreated: glAccounts.length,
        uniqueViolations,
        patternFailures,
      });

      // Assertions
      expect(count500).toBe(0);
      expect(banks.length).toBeGreaterThanOrEqual(1);
    });
  }
});
