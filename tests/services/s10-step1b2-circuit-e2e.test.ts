// S10 Step 1B.2 — E2E causal circuit (TEST ONLY — product code frozen).
//
// One causal chain against the REAL database:
//   ImportService.importFile (real CSV import)
//     → PendingApproval{action:'ai_classification_proposal'} PRODUCED BY THE
//       IMPORT (this test never seeds it with db.pendingApproval.create)
//     → GET /api/import/ai-proposals (real handler)
//     → POST {approvalId, decision:'ACCEPT'} (real handler)
//     → decideAiProposal CAS → reclassifyTransaction (same tx) → atomic
//       accounting + journal commit → once-guarded post-commit KE learning.
//
// Stub boundary (§7): ONLY the AI provider response surface —
// runRuleEngineV2 / runRuleEngineV2Shadow in @/lib/services/rule-engine-adapter.
// Engine mode v2 is product configuration via the product's own env switch
// (vi.stubEnv), not a stub. Everything else — ImportService, PendingApproval
// persistence, the route handlers, decideAiProposal, reclassifyTransaction,
// accounting, journal and the KE learning mechanism — runs product code
// unmodified. resolveEntity is observed through a passthrough spy whose
// implementation still invokes the real function (certified observation
// technique from ai-proposal-approval.service.test.ts) so the test can prove
// the committed state AT the moment KE runs.
//
// Out of scope (by order): UI, tenant matrices, CORRECT/REJECT, concurrency,
// reuse semantics, browser runs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { GET, POST } from '../../src/app/api/import/ai-proposals/route';
import { ImportService } from '@/lib/services/import.service';
import { resolveEntity } from '@/memory/entity-resolution';
import { createSession } from '@/lib/sessions';
import {
  createAdapter,
  lookupTreatment,
  getClassificationObservations,
} from '@/memory/classification-knowledge';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  clearDatabase,
} from '../helpers/factories';

// ─── §7 — the ONLY stub: AI provider response boundary ─────────────────────

const mockRunRuleEngineV2 = vi.hoisted(() => ({ fn: vi.fn() }));
const mockRunRuleEngineV2Shadow = vi.hoisted(() => ({ fn: vi.fn() }));
const realResolveEntity = vi.hoisted(() => ({ fn: undefined as unknown }));

vi.mock('@/lib/services/rule-engine-adapter', () => ({
  runRuleEngineV2: mockRunRuleEngineV2.fn,
  runRuleEngineV2Shadow: mockRunRuleEngineV2Shadow.fn,
}));

// Observe-only passthrough (same certified technique as
// ai-proposal-approval.service.test.ts): every call still executes the REAL
// resolveEntity; the wrapper only captures the committed DB state at the
// moment KE runs so the test can prove post-commit ordering.
vi.mock('@/memory/entity-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/memory/entity-resolution')>();
  realResolveEntity.fn = actual.resolveEntity;
  return { ...actual, resolveEntity: vi.fn(actual.resolveEntity) };
});
const resolveEntitySpy = vi.mocked(resolveEntity);

// ─── Fixtures ──────────────────────────────────────────────────────────────

// One CSV row: one import → exactly one PendingApproval from the product.
const CSV = 'date,description,amount\n2026-01-15,WALMART MEXICO,-250.00';

async function setupCompany(tag: string) {
  const user = await createTestUser(`${tag}@example.com`);
  const company = await createTestCompany(`${tag} Co`);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  // Bank GL linked to the bank account → journal entries are created.
  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Bank',
  });
  // Target GL the AI proposes.
  const aiGl = await createTestGlAccount({
    companyId: company.id,
    code: '6100',
    name: 'AI proposed expense',
    accountType: 'expense',
  });
  const bankAccount = await createTestBankAccount(company.id, bankGl.id);

  // Pre-existing company knowledge: the company already knows this merchant.
  // This is an entity-identity FIXTURE, not a learning artifact of the
  // decision under test — the treatment/observation rows asserted below are.
  const entity = await db.companyKnowledge.create({
    data: {
      companyId: company.id,
      type: 'COMPANY',
      canonicalName: 'WALMART MEXICO',
      aliases: [],
      metadata: {},
      source: 'test',
      status: 'active',
    },
  });

  // Deterministic AI provider response at the ONLY stubbed boundary.
  mockRunRuleEngineV2.fn.mockResolvedValue({
    outcome: 'pending',
    deterministicResult: 'no_match',
    aiProposal: {
      role: 'expense',
      glAccountCode: '6100',
      glAccountId: aiGl.id,
      suggestSubAccount: false,
      subAccountName: null,
      conditions: [],
    },
  });

  return { user, company, token, bankGl, aiGl, bankAccount, entity };
}

type Setup = Awaited<ReturnType<typeof setupCompany>>;

function getReq(s: Setup) {
  return new NextRequest(
    `http://localhost/api/import/ai-proposals?companyId=${s.company.id}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${s.token}` },
    },
  );
}

function postReq(s: Setup, body: unknown) {
  return new NextRequest(
    `http://localhost/api/import/ai-proposals?companyId=${s.company.id}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

const emptyParams = { params: Promise.resolve({}) };

// This file's fixture rows must be removed BEFORE clearDatabase(): the shared
// helper does not delete companyKnowledge (its restrict FK blocks the company
// cascade) and never discovers companies whose membership is already gone.
// Only rows of this file's company (legalName 's10-e2e Co') are touched.
async function purgeOwnFixtures() {
  const companies = await db.company.findMany({
    where: { legalName: 's10-e2e Co' },
    select: { id: true },
  });
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return;
  const companyFilter = { companyId: { in: ids } };
  const statements = await db.bankStatement.findMany({
    where: companyFilter,
    select: { id: true },
  });
  const entries = await db.journalEntry.findMany({
    where: companyFilter,
    select: { id: true },
  });
  await db.bankTransaction
    .deleteMany({ where: { statementId: { in: statements.map((x) => x.id) } } })
    .catch(() => {});
  await db.journalLine
    .deleteMany({ where: { entryId: { in: entries.map((x) => x.id) } } })
    .catch(() => {});
  await db.journalEntry.deleteMany({ where: companyFilter }).catch(() => {});
  await db.bankStatement.deleteMany({ where: companyFilter }).catch(() => {});
  await db.bankAccount.deleteMany({ where: companyFilter }).catch(() => {});
  await db.glAccount.deleteMany({ where: companyFilter }).catch(() => {});
  await db.auditLog.deleteMany({ where: companyFilter }).catch(() => {});
  await db.entityContext.deleteMany({ where: companyFilter }).catch(() => {});
  await db.fiscalPeriod.deleteMany({ where: companyFilter }).catch(() => {});
  await db.companyMember.deleteMany({ where: companyFilter }).catch(() => {});
  // Restrict FK — must go before the company row itself.
  await db.companyKnowledge.deleteMany({ where: companyFilter }).catch(() => {});
  await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

describe('S10 Step 1B.2 — E2E causal circuit: import → human ACCEPT → accounting → KE learning', () => {
  beforeEach(async () => {
    await purgeOwnFixtures();
    await clearDatabase();
    vi.unstubAllEnvs();
    resolveEntitySpy.mockClear();
  });

  afterEach(async () => {
    await purgeOwnFixtures();
    await clearDatabase();
    vi.unstubAllEnvs();
  });

  it(
    'A→H: the import produces the pending proposal; human ACCEPT applies the proposed GL through the sole authority and records post-commit KE learning',
    async () => {
      // Product configuration (not a stub): the productive v2 engine mode —
      // the switch production uses to enable the AI proposal chain.
      vi.stubEnv('BANK_RULE_ENGINE', 'v2');

      const s = await setupCompany('s10-e2e');

      // ─── A. Real import over the real DB ───────────────────────────────
      await ImportService.importFile({
        companyId: s.company.id,
        bankAccountId: s.bankAccount.id,
        fileName: 'walmart.csv',
        extension: 'csv',
        buffer: Buffer.from(CSV),
        content: CSV,
        userId: s.user.id,
      });

      // ─── B. The proposal exists BECAUSE of the import (never seeded).
      // requestedBy scopes to THIS run's user — the shared test DB may hold
      // pending approvals from other files/runs (clearDatabase never deletes
      // pendingApproval, which has no company FK to discover it by).
      const approval = await db.pendingApproval.findFirst({
        where: { action: 'ai_classification_proposal', requestedBy: s.user.id },
      });
      expect(approval).not.toBeNull();
      expect(approval!.status).toBe('pending');
      expect(approval!.requestedBy).toBe(s.user.id);

      const payload = approval!.payload as unknown as {
        companyId: string;
        transactionId: string;
        bankAccountId: string;
        deterministicResult: string;
        aiProposal: { role: string; glAccountCode: string; glAccountId: string };
      };
      expect(payload.companyId).toBe(s.company.id);
      expect(payload.bankAccountId).toBe(s.bankAccount.id);
      expect(payload.transactionId).toMatch(/^[0-9a-f]{64}$/);
      expect(payload.deterministicResult).toBe('no_match');
      expect(payload.aiProposal).toMatchObject({
        role: 'expense',
        glAccountCode: '6100',
        glAccountId: s.aiGl.id,
      });

      // The import created the real BankTransaction, still unclassified.
      // importHash is @unique → this lookup is unambiguous across the DB.
      const importHash = payload.transactionId;
      const bankTx = await db.bankTransaction.findFirst({
        where: { importHash },
      });
      expect(bankTx).not.toBeNull();
      expect(bankTx!.description).toBe('WALMART MEXICO');
      expect(bankTx!.glAccountId).toBeNull();
      expect(bankTx!.matchedRuleId).toBeNull();
      expect(bankTx!.journalEntryId).toBeNull();

      // ─── C. Pre-decision: no accounting, no learning ───────────────────
      expect(
        await db.journalEntry.count({ where: { companyId: s.company.id } }),
      ).toBe(0);
      const adapter = createAdapter(db, (fn) => db.$transaction(fn));
      expect(
        (await lookupTreatment(adapter, s.company.id, s.entity.id)).status,
      ).toBe('NOT_FOUND');
      expect(
        await getClassificationObservations(adapter, s.company.id, s.entity.id),
      ).toHaveLength(0);

      // ─── D. GET listing (real handler, real data) ──────────────────────
      const getRes = await GET(getReq(s), emptyParams);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.proposals).toHaveLength(1);
      const item = getBody.proposals[0];
      expect(item.approvalId).toBe(approval!.id);
      expect(item.transaction.id).toBe(bankTx!.id);
      expect(item.transaction.description).toBe('WALMART MEXICO');
      expect(item.proposedGlAccount).toMatchObject({
        code: '6100',
        name: 'AI proposed expense',
      });
      expect(item.deterministicResult).toBe('no_match');
      expect(item.aiProposal).toMatchObject({ role: 'expense' });
      expect(item.bankAccountId).toBe(s.bankAccount.id);

      // ─── E. POST human ACCEPT (real handler → real authority chain) ────
      // Observe ONLY the decision phase: capture the committed state at the
      // exact moment KE executes, still running the real resolveEntity.
      resolveEntitySpy.mockClear();
      const keProbe: {
        approvalStatusAtKe: string | null;
        txGlAtKe: string | null;
        resolution: Awaited<ReturnType<typeof resolveEntity>> | null;
      } = { approvalStatusAtKe: null, txGlAtKe: null, resolution: null };
      resolveEntitySpy.mockImplementation(async (companyIdArg, description) => {
        keProbe.approvalStatusAtKe =
          (
            await db.pendingApproval.findUnique({
              where: { id: approval!.id },
              select: { status: true },
            })
          )?.status ?? null;
        keProbe.txGlAtKe =
          (
            await db.bankTransaction.findUnique({
              where: { id: bankTx!.id },
              select: { glAccountId: true },
            })
          )?.glAccountId ?? null;
        const resolution = await (
          realResolveEntity.fn as typeof resolveEntity
        )(companyIdArg, description);
        keProbe.resolution = resolution;
        return resolution;
      });

      const postRes = await POST(
        postReq(s, { approvalId: approval!.id, decision: 'ACCEPT' }),
        emptyParams,
      );
      expect(postRes.status).toBe(200);
      const postBody = await postRes.json();
      expect(postBody).toMatchObject({
        decision: 'ACCEPT',
        approval: { id: approval!.id, status: 'accepted' },
      });

      // ─── F. CAS consumed ───────────────────────────────────────────────
      expect(
        (await db.pendingApproval.findUnique({ where: { id: approval!.id } }))!
          .status,
      ).toBe('accepted');

      // ─── G1. Accounting: the sole authority applied the proposed GL and
      //         produced the journal effect ──────────────────────────────
      const decidedTx = await db.bankTransaction.findUnique({
        where: { id: bankTx!.id },
      });
      expect(decidedTx!.glAccountId).toBe(s.aiGl.id);
      expect(decidedTx!.journalEntryId).not.toBeNull();

      const journal = await db.journalEntry.findUnique({
        where: { id: decidedTx!.journalEntryId! },
        include: { lines: true },
      });
      expect(journal).not.toBeNull();
      expect(journal!.companyId).toBe(s.company.id);
      expect(journal!.status).toBe('posted');
      expect(journal!.lines).toHaveLength(2);
      expect(journal!.lines.map((l) => l.glAccountId).sort()).toEqual(
        [s.aiGl.id, s.bankGl.id].sort(),
      );
      const totalDebit = journal!.lines.reduce(
        (sum, l) => sum + Number(l.debit),
        0,
      );
      expect(totalDebit).toBe(250);

      // ─── G2. KE ran exactly once, strictly post-commit ─────────────────
      expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
      expect(keProbe.approvalStatusAtKe).toBe('accepted');
      expect(keProbe.txGlAtKe).toBe(s.aiGl.id);
      expect(keProbe.resolution?.status).toBe('KNOWN');

      // ─── G3. Learning persisted by the productive KE (never written
      //         directly by this test) ───────────────────────────────────
      const treatment = await lookupTreatment(
        adapter,
        s.company.id,
        s.entity.id,
      );
      expect(treatment).toMatchObject({
        status: 'FOUND',
        glAccountId: s.aiGl.id,
        direction: 'any',
        confidence: 'certain',
      });

      const observations = await getClassificationObservations(
        adapter,
        s.company.id,
        s.entity.id,
      );
      expect(observations).toHaveLength(1);
      expect(observations[0]!).toMatchObject({
        entityId: s.entity.id,
        originalDescription: 'WALMART MEXICO',
        glAccountId: s.aiGl.id,
        direction: 'any',
        source: 'user_correction',
        transactionId: bankTx!.id,
      });

      // ─── H. No internal HTTP hop: GET/POST were invoked as in-process
      //         handlers above; no decision/accounting/KE logic is
      //         re-implemented anywhere in this file (code fact — audit
      //         this file; no assertion needed).
    },
    30_000,
  );
});
