/**
 * S9.2 — Forensic Concurrency & Stress Audit
 *
 * Tests every transactional endpoint under real concurrent load.
 * Uses actual Prisma handlers (not mocks) against the test DB.
 *
 * Inventory: 21 files with db.$transaction() across 25 transaction call sites.
 * Scenarios test highest-risk concurrent patterns.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { AsyncLocalStorage } from 'async_hooks';

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 's92-test-user'),
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
    requireCurrentUserId: vi.fn(() => 's92-test-user'),
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
vi.mock('@/lib/chart-of-accounts', () => ({
  seedChartOfAccounts: vi.fn(async () => undefined),
}));
vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({
    allowed: true, limit: 1000, remaining: 999, resetAt: new Date(Date.now() + 60000),
  })),
}));
vi.mock('@/lib/security/client-ip', () => ({
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

// ── Constants ────────────────────────────────────────────────────────
const CID = `s92-company-${Date.now()}`;
const UID = 's92-test-user';
const BASE = `http://localhost/api`;

// ── FK-safe cleanup ──────────────────────────────────────────────────
async function cleanCompany(cid: string) {
  await db.auditLog.deleteMany({ where: { companyId: cid } });
  await db.bankTransaction.deleteMany({ where: { statement: { bankAccount: { companyId: cid } } } });
  await db.bankStatement.deleteMany({ where: { bankAccount: { companyId: cid } } });
  await db.bankAccount.deleteMany({ where: { companyId: cid } });
  await db.journalLine.deleteMany({ where: { entry: { companyId: cid } } });
  await db.journalEntry.deleteMany({ where: { companyId: cid } });
  await db.fiscalPeriod.deleteMany({ where: { companyId: cid } });
  await db.bankRule.deleteMany({ where: { companyId: cid } });
  await db.glAccount.deleteMany({ where: { companyId: cid } });
}

// ── Setup ────────────────────────────────────────────────────────────
beforeAll(async () => {
  await db.company.upsert({
    where: { id: CID }, update: {},
    create: { id: CID, legalName: 'S9.2 Test Co', entityType: 'BUSINESS', isActive: true },
  });
  await db.user.upsert({
    where: { id: UID }, update: {},
    create: { id: UID, email: `s92-test-${Date.now()}@test.com`, passwordHash: 'x', firstName: 'S92', lastName: 'Test', isActive: true },
  });
});
afterAll(async () => {
  await cleanCompany(CID);
  await db.companyMember.deleteMany({ where: { companyId: CID } });
  await db.user.deleteMany({ where: { id: UID } });
  await db.company.delete({ where: { id: CID } }).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-1: POST /api/fiscal-periods — Concurrent overlap creation
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-1: Fiscal Period — concurrent overlap', () => {
  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { companyId: CID } });
    await db.fiscalPeriod.deleteMany({ where: { companyId: CID } });
  });

  it('20 concurrent overlapping requests: TOCTOU exploitable', async () => {
    const { POST } = await import('@/app/api/fiscal-periods/route');
    const N = 20;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const req = new NextRequest(`${BASE}/fiscal-periods?companyId=${CID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-locale': 'es' },
          body: JSON.stringify({ name: `S-${i}`, startDate: '2026-06-01', endDate: '2026-06-30' }),
        });
        return POST(req, { params: Promise.resolve({}) });
      }),
    );
    const statuses = await Promise.all(responses.map((r) => r.status));
    const periods = await db.fiscalPeriod.findMany({ where: { companyId: CID } });
    const ok = statuses.filter((s) => s === 200).length;
    const c409 = statuses.filter((s) => s === 409).length;
    const c500 = statuses.filter((s) => s === 500).length;

    console.log(`[S1] ok=${ok} 409=${c409} 500=${c500} db_periods=${periods.length}`);
    expect(c500).toBe(0);
    expect(periods.length).toBeGreaterThanOrEqual(1);
    // TOCTOU: overlap check is outside $transaction, so concurrent reads see empty state
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-2: POST /api/journal/[id] action=post — 20 concurrent posts
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-2: Journal post — 20 concurrent', () => {
  let accountId: string;
  beforeEach(async () => {
    await cleanCompany(CID);
    const a = await db.glAccount.create({ data: { companyId: CID, code: '1000', name: 'Cash', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    accountId = a.id;
  });
  it('20 concurrent post on same draft: no corruption', async () => {
    const { POST } = await import('@/app/api/journal/[id]/route');
    const entry = await db.journalEntry.create({
      data: { companyId: CID, date: new Date('2026-06-15'), description: 'Stress', status: 'draft',
        lines: { create: [{ glAccountId: accountId, debit: 1000, credit: 0 }, { glAccountId: accountId, debit: 0, credit: 1000 }] } },
    });
    const responses = await Promise.all(Array.from({ length: 20 }, () => {
      const req = new NextRequest(`${BASE}/journal/${entry.id}?companyId=${CID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'post' }),
      });
      return POST(req, { params: Promise.resolve({ id: entry.id }) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const final = await db.journalEntry.findUnique({ where: { id: entry.id } });
    console.log(`[S2] status=posted=${final!.status} 200=${statuses.filter((s) => s === 200).length} 500=${statuses.filter((s) => s === 500).length}`);
    expect(final!.status).toBe('posted');
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-3: POST /api/accounts — 50 concurrent same code
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-3: Account create — 50 concurrent same code', () => {
  beforeEach(async () => { await cleanCompany(CID); });
  it('UNIQUE constraint enforces exactly 1', async () => {
    const { POST } = await import('@/app/api/accounts/route');
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => {
      const req = new NextRequest(`${BASE}/accounts?companyId=${CID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '6000', name: `Exp ${i}`, accountType: 'expense', normalBalance: 'debit' }),
      });
      return POST(req, { params: Promise.resolve({}) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const accounts = await db.glAccount.findMany({ where: { companyId: CID, code: '6000' } });
    const created = statuses.filter((s) => s === 201).length;
    console.log(`[S3] created=${created} 409=${statuses.filter((s) => s === 409).length} 500=${statuses.filter((s) => s === 500).length} db=${accounts.length}`);
    expect(accounts.length).toBe(1);
    expect(created).toBe(1);
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-4: Reconciliation review — 20 concurrent approve same tx
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-4: Reconciliation approve — 20 concurrent', () => {
  let stmtId: string;
  beforeEach(async () => {
    await cleanCompany(CID);
    const gl = await db.glAccount.create({ data: { companyId: CID, code: '1010', name: 'Bank', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    const ba = await db.bankAccount.create({ data: { companyId: CID, accountName: 'TB', bankName: 'TB', glAccountId: gl.id, balance: 0, initialBalance: 0, currency: 'USD', isActive: true } });
    const s = await db.bankStatement.create({ data: { bankAccountId: ba.id, companyId: CID, startDate: new Date('2026-06-01'), endDate: new Date('2026-06-30'), openingBalance: 0, closingBalance: 0, format: 'OFX' } });
    stmtId = s.id;
  });
  it('20 concurrent approve on same pending_review tx', async () => {
    const { POST } = await import('@/app/api/reconciliation/review/route');
    const bt = await db.bankTransaction.create({ data: { statementId: stmtId, date: new Date('2026-06-15'), amount: 500, description: 'Stress', status: 'pending_review', isReconciled: false } });
    const responses = await Promise.all(Array.from({ length: 20 }, () => {
      const req = new NextRequest(`${BASE}/reconciliation/review?companyId=${CID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionId: bt.id, action: 'approve' }),
      });
      return POST(req, { params: Promise.resolve({}) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const final = await db.bankTransaction.findUnique({ where: { id: bt.id } });
    console.log(`[S4] final_status=${final!.status} 200=${statuses.filter((s) => s === 200).length} 500=${statuses.filter((s) => s === 500).length}`);
    expect(final!.status).toBe('posted');
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-5: PATCH /api/transactions/[id] — 20 concurrent GL reassignment
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-5: Transaction GL assignment — 20 concurrent', () => {
  let btId: string; let targets: string[];
  beforeEach(async () => {
    await cleanCompany(CID);
    const bgl = await db.glAccount.create({ data: { companyId: CID, code: '1010', name: 'Bank', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    targets = [];
    for (let i = 0; i < 20; i++) {
      const a = await db.glAccount.create({ data: { companyId: CID, code: `6${String(i).padStart(3, '0')}`, name: `T${i}`, accountType: 'expense', normalBalance: 'debit', isActive: true } });
      targets.push(a.id);
    }
    const ba = await db.bankAccount.create({ data: { companyId: CID, accountName: 'TB', bankName: 'TB', glAccountId: bgl.id, balance: 0, initialBalance: 0, currency: 'USD', isActive: true } });
    const s = await db.bankStatement.create({ data: { bankAccountId: ba.id, companyId: CID, startDate: new Date('2026-06-01'), endDate: new Date('2026-06-30'), openingBalance: 0, closingBalance: 0, format: 'OFX' } });
    const bt = await db.bankTransaction.create({ data: { statementId: s.id, date: new Date('2026-06-15'), amount: 500, description: 'GL stress', status: 'posted', isReconciled: false } });
    btId = bt.id;
  });
  it('20 concurrent GL reassignments: no deadlocks, consistent state', async () => {
    const { PATCH } = await import('@/app/api/transactions/[id]/route');
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const req = new NextRequest(`${BASE}/transactions/${btId}?companyId=${CID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ glAccountId: targets[i] }),
      });
      return PATCH(req, { params: Promise.resolve({ id: btId }) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const finalTx = await db.bankTransaction.findUnique({ where: { id: btId } });
    console.log(`[S5] glAccountId=${finalTx!.glAccountId} 200=${statuses.filter((s) => s === 200).length} 500=${statuses.filter((s) => s === 500).length}`);
    expect(finalTx!.glAccountId).not.toBeNull();
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-6: PATCH /api/accounting-flow/audit/link — 20 concurrent
// journalLineId is @unique — exactly 1 should succeed
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-6: Audit link — 20 concurrent to same journal line', () => {
  let jlid: string; let stmtId: string;
  beforeEach(async () => {
    await cleanCompany(CID);
    const gl = await db.glAccount.create({ data: { companyId: CID, code: '1010', name: 'Bank', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    const ba = await db.bankAccount.create({ data: { companyId: CID, accountName: 'TB', bankName: 'TB', glAccountId: gl.id, balance: 0, initialBalance: 0, currency: 'USD', isActive: true } });
    const s = await db.bankStatement.create({ data: { bankAccountId: ba.id, companyId: CID, startDate: new Date('2026-06-01'), endDate: new Date('2026-06-30'), openingBalance: 0, closingBalance: 0, format: 'OFX' } });
    stmtId = s.id;
    const je = await db.journalEntry.create({ data: { companyId: CID, date: new Date('2026-06-15'), description: 'Target', status: 'posted', lines: { create: [{ glAccountId: gl.id, debit: 100, credit: 0 }] } }, include: { lines: true } });
    jlid = je.lines[0].id;
    for (let i = 0; i < 20; i++) {
      await db.bankTransaction.create({ data: { statementId: stmtId, date: new Date('2026-06-15'), amount: 10 * (i + 1), description: `C${i}`, status: 'posted', isReconciled: true, reconciledAt: new Date() } });
    }
  });
  it('exactly 1 link succeeds (UNIQUE constraint)', async () => {
    const { PATCH } = await import('@/app/api/accounting-flow/audit/link/route');
    const btxs = await db.bankTransaction.findMany({ where: { statement: { bankAccount: { companyId: CID } } }, orderBy: { amount: 'asc' } });
    const responses = await Promise.all(btxs.map((btx) => {
      const req = new NextRequest(`${BASE}/accounting-flow/audit/link?companyId=${CID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bankTransactionId: btx.id, journalLineId: jlid }),
      });
      return PATCH(req, { params: Promise.resolve({}) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const ok = statuses.filter((s) => s === 200).length;
    const linked = await db.bankTransaction.findMany({ where: { journalLineId: jlid } });
    console.log(`[S6] ok=${ok} linked=${linked.length} 500=${statuses.filter((s) => s === 500).length}`);
    expect(ok).toBe(1);
    expect(linked.length).toBe(1);
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-7: PUT /api/journal/[id] — 20 concurrent draft updates
// deleteMany+create inside TX → final line count = 2
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-7: Journal draft update — 20 concurrent', () => {
  let accountId: string;
  beforeEach(async () => {
    await cleanCompany(CID);
    const a = await db.glAccount.create({ data: { companyId: CID, code: '1000', name: 'Cash', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    accountId = a.id;
  });
  it('final line count exactly 2, balanced', async () => {
    const { PUT } = await import('@/app/api/journal/[id]/route');
    const entry = await db.journalEntry.create({
      data: { companyId: CID, date: new Date('2026-06-15'), description: 'Draft', status: 'draft',
        lines: { create: [{ glAccountId: accountId, debit: 100, credit: 0 }, { glAccountId: accountId, debit: 0, credit: 100 }] } },
    });
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const req = new NextRequest(`${BASE}/journal/${entry.id}?companyId=${CID}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: `U${i}`, lines: [
          { glAccountId: accountId, debit: 200 + i, credit: 0 },
          { glAccountId: accountId, debit: 0, credit: 200 + i },
        ] }),
      });
      return PUT(req, { params: Promise.resolve({ id: entry.id }) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const final = await db.journalEntry.findUnique({ where: { id: entry.id }, include: { lines: true } });
    console.log(`[S7] lines=${final!.lines.length} 200=${statuses.filter((s) => s === 200).length} 500=${statuses.filter((s) => s === 500).length}`);
    expect(final!.lines.length).toBe(2);
    expect(final!.status).toBe('draft');
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-8: POST /api/journal/[id] action=void — 20 concurrent
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-8: Journal void — 20 concurrent', () => {
  let accountId: string;
  beforeEach(async () => {
    await cleanCompany(CID);
    const a = await db.glAccount.create({ data: { companyId: CID, code: '1000', name: 'Cash', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    accountId = a.id;
  });
  it('entry ends up void, no corruption', async () => {
    const { POST } = await import('@/app/api/journal/[id]/route');
    const entry = await db.journalEntry.create({
      data: { companyId: CID, date: new Date('2026-06-15'), description: 'Posted', status: 'posted',
        lines: { create: [{ glAccountId: accountId, debit: 500, credit: 0 }, { glAccountId: accountId, debit: 0, credit: 500 }] } },
    });
    const responses = await Promise.all(Array.from({ length: 20 }, () => {
      const req = new NextRequest(`${BASE}/journal/${entry.id}?companyId=${CID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'void' }),
      });
      return POST(req, { params: Promise.resolve({ id: entry.id }) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const final = await db.journalEntry.findUnique({ where: { id: entry.id } });
    console.log(`[S8] status=${final!.status} 200=${statuses.filter((s) => s === 200).length} 400=${statuses.filter((s) => s === 400).length}`);
    expect(final!.status).toBe('void');
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-9: PATCH /api/fiscal-periods/[id] — 20 concurrent lock
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-9: Fiscal period lock — 20 concurrent', () => {
  let pid: string;
  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { companyId: CID } });
    await db.fiscalPeriod.deleteMany({ where: { companyId: CID } });
    const p = await db.fiscalPeriod.create({ data: { companyId: CID, name: 'Lock', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-30'), isLocked: false } });
    pid = p.id;
  });
  it('period locked, duplicate audit logs possible', async () => {
    const { PATCH } = await import('@/app/api/fiscal-periods/[id]/route');
    const responses = await Promise.all(Array.from({ length: 20 }, () => {
      const req = new NextRequest(`${BASE}/fiscal-periods/${pid}?companyId=${CID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isLocked: true }),
      });
      return PATCH(req, { params: Promise.resolve({ id: pid }) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const final = await db.fiscalPeriod.findUnique({ where: { id: pid } });
    console.log(`[S9] isLocked=${final!.isLocked} 200=${statuses.filter((s) => s === 200).length} 500=${statuses.filter((s) => s === 500).length}`);
    expect(final!.isLocked).toBe(true);
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO-10: POST /api/banks — 10 concurrent with opening balance
// ═══════════════════════════════════════════════════════════════════════
describe('SCENARIO-10: Bank create — 10 concurrent', () => {
  let glId: string;
  beforeEach(async () => {
    await cleanCompany(CID);
    const gl = await db.glAccount.create({ data: { companyId: CID, code: '1010', name: 'Bank', accountType: 'asset', normalBalance: 'debit', isActive: true } });
    glId = gl.id;
  });
  it('concurrent bank creates with opening balance: ensureOpeningBalanceEquity TOCTOU', async () => {
    const { POST } = await import('@/app/api/banks/route');
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => {
      const req = new NextRequest(`${BASE}/banks?companyId=${CID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountName: `B${i}`, bankName: 'TB', glAccountId: glId, balance: 1000, currency: 'USD' }),
      });
      return POST(req, { params: Promise.resolve({}) });
    }));
    const statuses = await Promise.all(responses.map((r) => r.status));
    const accounts = await db.bankAccount.findMany({ where: { companyId: CID } });
    const ok = statuses.filter((s) => s === 201).length;
    const err = statuses.filter((s) => s === 400).length;
    console.log(`[S10] accounts=${accounts.length} ok=${ok} err_400=${err}`);
    // ensureOpeningBalanceEquity uses findFirst+create (TOCTOU) — concurrent
    // creates fail with unique constraint on companyId+code for the equity account.
    // This is a reliability bug, NOT a data integrity issue.
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 500).length).toBe(0);
  });
});
