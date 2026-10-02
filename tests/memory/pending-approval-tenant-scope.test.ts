// §GAP8-2D — PendingApproval explicit tenant scope (T1–T12).
//
// PendingApproval.companyId is the ONLY tenant authority. payload.companyId
// is advisory JSON, never the scope. Every productive operation (create,
// list, read, decide, reject, delete, guard exclusion, import producer)
// must be provable per-tenant against the REAL database.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  proposeCreate,
  confirmCreate,
} from '@/internal/company-knowledge/entity/service';
import {
  decideAiProposal,
  listPendingAiProposals,
} from '@/lib/services/ai-proposal-approval.service';
import { excludePendingHumanDecisions } from '@/lib/services/single-rule-apply.service';
import { matchTransactions, executeApplyAll } from '@/lib/services/apply-all-engine';
import { revalidateAutoMatchCandidate } from '@/app/api/reconciliation/auto/route';
import { ImportService } from '@/lib/services/import.service';
import { runRuleEngineV2 } from '@/lib/services/rule-engine-adapter';
import { resolveEntity } from '@/memory/entity-resolution';
import {
  createAdapter,
  lookupTreatment,
  getClassificationObservations,
} from '@/memory/classification-knowledge';
import { DELETE as deleteCompanyRoute } from '@/app/api/admin/companies/[id]/route';
import { createSession } from '@/lib/sessions';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  clearDatabase,
} from '../helpers/factories';

// Spy-with-passthrough: real behavior preserved, calls observable.
vi.mock('@/memory/entity-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/memory/entity-resolution')>();
  return { ...actual, resolveEntity: vi.fn(actual.resolveEntity) };
});
const resolveEntitySpy = vi.mocked(resolveEntity);

// Productive V2 boundary mock (passthrough by default; T10 overrides once).
vi.mock('@/lib/services/rule-engine-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/rule-engine-adapter')>();
  return { ...actual, runRuleEngineV2: vi.fn(actual.runRuleEngineV2) };
});

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const RULE_MARKER = 'T2D merchant';

// ─── Fixtures ──────────────────────────────────────────────────────────────

type Tenant = Awaited<ReturnType<typeof createTenant>>;
const fixtureCompanyIds = new Set<string>();

async function createTenant(tag: string) {
  const user = await createTestUser(`${tag}-${RUN}@example.com`);
  const company = await createTestCompany(`T2D ${tag}`);
  await createTestCompanyMember(user.id, company.id);
  fixtureCompanyIds.add(company.id);

  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Bank',
  });
  const aiGl = await createTestGlAccount({
    companyId: company.id,
    code: '6100',
    name: 'AI proposed expense',
    accountType: 'expense',
  });
  const humanGl = await createTestGlAccount({
    companyId: company.id,
    code: '6200',
    name: 'Human corrected expense',
    accountType: 'expense',
  });

  const bankAccount = await createTestBankAccount(company.id, bankGl.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const description = `${RULE_MARKER} ${tag}`;
  const tx = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-06-15',
    amount: 100,
    description,
  });
  const importHash = `t2d-${tag}-${RUN}`;
  await db.bankTransaction.update({
    where: { id: tx.id },
    data: { importHash },
  });

  return {
    user,
    company,
    bankGl,
    aiGl,
    humanGl,
    bankAccount,
    statement,
    tx,
    importHash,
    description,
  };
}

function proposalPayload(t: Tenant, overrides: Record<string, unknown> = {}) {
  return {
    companyId: t.company.id,
    transactionId: t.importHash,
    bankAccountId: t.bankAccount.id,
    deterministicResult: 'ambiguous',
    aiProposal: {
      role: 'expense',
      glAccountCode: '6100',
      glAccountId: t.aiGl.id,
      conditions: [],
      suggestSubAccount: false,
      subAccountName: null,
    },
    proposedEntity: { canonicalName: 'T2D Suggested', entityType: 'company' },
    ...overrides,
  };
}

async function createAiProposal(
  t: Tenant,
  overrides: Record<string, unknown> = {},
) {
  return db.pendingApproval.create({
    data: {
      companyId: t.company.id,
      action: 'ai_classification_proposal',
      payload: proposalPayload(t, overrides),
      requestedBy: t.user.id,
      status: 'pending',
    },
  });
}

async function seedKnowledge(t: Tenant) {
  return db.companyKnowledge.create({
    data: {
      companyId: t.company.id,
      type: 'PERSON',
      canonicalName: t.description,
      aliases: [],
      metadata: {},
      source: 'company_knowledge',
      status: 'active',
    },
  });
}

async function seedRule(t: Tenant) {
  return db.bankRule.create({
    data: {
      companyId: t.company.id,
      name: `T2D Rule ${t.company.id.slice(-6)}`,
      conditionType: 'contains',
      conditionValue: RULE_MARKER,
      transactionDirection: 'any',
      glAccountId: t.humanGl.id,
      priority: 10,
      isActive: true,
    },
  });
}

const adapter = () => createAdapter(db, (fn) => db.$transaction(fn));

// ─── Suite ─────────────────────────────────────────────────────────────────

describe('§GAP8-2D — PendingApproval tenant scope (T1–T12)', () => {
  beforeEach(async () => {
    await clearDatabase();
    resolveEntitySpy.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resolveEntitySpy.mockClear();
    const ids = [...fixtureCompanyIds];
    fixtureCompanyIds.clear();
    if (ids.length > 0) {
      await db.ruleApplyRecord
        .deleteMany({ where: { companyId: { in: ids } } })
        .catch(() => {});
      await db.bankRule
        .deleteMany({ where: { companyId: { in: ids } } })
        .catch(() => {});
      await db.ruleExecutionAudit
        .deleteMany({ where: { companyId: { in: ids } } })
        .catch(() => {});
      await db.knowledgeAudit
        .deleteMany({ where: { companyKnowledge: { companyId: { in: ids } } } })
        .catch(() => {});
      await db.pendingApproval
        .deleteMany({ where: { companyId: { in: ids } } })
        .catch(() => {});
      await db.companyKnowledge
        .deleteMany({ where: { companyId: { in: ids } } })
        .catch(() => {});
      await db.memoryItem
        .deleteMany({ where: { companyId: { in: ids } } })
        .catch(() => {});
    }
    await clearDatabase();
  });

  // ── T1: create stores companyId ──────────────────────────────────────────
  it('T1: proposeCreate persists PendingApproval.companyId as tenant identity', async () => {
    const a = await createTenant(`t1-${RUN}`);

    const pending = await proposeCreate({
      companyId: a.company.id,
      type: 'person',
      canonicalName: `T1 person ${RUN}`,
      metadata: {},
      requestedBy: a.user.id,
    });

    expect(pending.companyId).toBe(a.company.id);
    const row = await db.pendingApproval.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(row.companyId).toBe(a.company.id);
    expect(row.knowledgeId).toBeNull();
    expect(row.status).toBe('pending');
  });

  // ── T2: list is tenant-scoped (row AND payload) ──────────────────────────
  it('T2: listPendingAiProposals returns only the calling tenant rows', async () => {
    const a = await createTenant(`t2a-${RUN}`);
    const b = await createTenant(`t2b-${RUN}`);

    const a1 = await createAiProposal(a);
    const a2 = await createAiProposal(a);
    const b1 = await createAiProposal(b);
    // Hostile row: owned by A, payload claims B — must NOT leak into B
    // and must NOT appear in A (payload.companyId mismatch).
    const poisoned = await db.pendingApproval.create({
      data: {
        companyId: a.company.id,
        action: 'ai_classification_proposal',
        payload: proposalPayload(b),
        requestedBy: a.user.id,
        status: 'pending',
      },
    });

    const listA = await listPendingAiProposals(a.company.id);
    const idsA = listA.map((i) => i.approvalId);
    expect(idsA).toHaveLength(2);
    expect(idsA).toContain(a1.id);
    expect(idsA).toContain(a2.id);
    expect(idsA).not.toContain(b1.id);
    expect(idsA).not.toContain(poisoned.id);

    const listB = await listPendingAiProposals(b.company.id);
    expect(listB.map((i) => i.approvalId)).toEqual([b1.id]);
  });

  // ── T3: confirmCreate cross-tenant read ──────────────────────────────────
  it('T3: confirmCreate with a foreign approvalId rejects as not-found', async () => {
    const a = await createTenant(`t3a-${RUN}`);
    const b = await createTenant(`t3b-${RUN}`);

    const pending = await proposeCreate({
      companyId: a.company.id,
      type: 'person',
      canonicalName: `T3 person ${RUN}`,
      metadata: {},
      requestedBy: a.user.id,
    });

    await expect(
      confirmCreate({ pendingApprovalId: pending.id, companyId: b.company.id }),
    ).rejects.toThrow(/not found/);

    const row = await db.pendingApproval.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(row.status).toBe('pending');
    expect(row.companyId).toBe(a.company.id);
  });

  // ── T4–T6: decide cross-tenant (ACCEPT / CORRECT / REJECT) ───────────────
  async function crossTenantDecisionSetup(tag: string) {
    const a = await createTenant(`${tag}a-${RUN}`);
    const b = await createTenant(`${tag}b-${RUN}`);
    const approval = await createAiProposal(a);
    return { a, b, approval };
  }

  it('T4: company B cannot ACCEPT A\u2019s proposal (APPROVAL_NOT_FOUND)', async () => {
    const { a, b, approval } = await crossTenantDecisionSetup('t4-');

    const res = await decideAiProposal({
      companyId: b.company.id,
      approvalId: approval.id,
      decision: 'ACCEPT',
    });
    expect(res.status).toBe('APPROVAL_NOT_FOUND');

    const row = await db.pendingApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(row.status).toBe('pending');
    const tx = await db.bankTransaction.findUniqueOrThrow({
      where: { id: a.tx.id },
    });
    expect(tx.glAccountId).toBeNull();
    expect(tx.journalEntryId).toBeNull();
  });

  it('T5: company B cannot CORRECT A\u2019s proposal (APPROVAL_NOT_FOUND)', async () => {
    const { a, b, approval } = await crossTenantDecisionSetup('t5-');

    const res = await decideAiProposal({
      companyId: b.company.id,
      approvalId: approval.id,
      decision: 'CORRECT',
      glAccountId: b.humanGl.id,
    });
    expect(res.status).toBe('APPROVAL_NOT_FOUND');

    const row = await db.pendingApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(row.status).toBe('pending');
    const tx = await db.bankTransaction.findUniqueOrThrow({
      where: { id: a.tx.id },
    });
    expect(tx.glAccountId).toBeNull();
    expect(tx.journalEntryId).toBeNull();
  });

  it('T6: company B cannot REJECT A\u2019s proposal (APPROVAL_NOT_FOUND)', async () => {
    const { a, b, approval } = await crossTenantDecisionSetup('t6-');

    const res = await decideAiProposal({
      companyId: b.company.id,
      approvalId: approval.id,
      decision: 'REJECT',
    });
    expect(res.status).toBe('APPROVAL_NOT_FOUND');

    const row = await db.pendingApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(row.status).toBe('pending');
    const tx = await db.bankTransaction.findUniqueOrThrow({
      where: { id: a.tx.id },
    });
    expect(tx.glAccountId).toBeNull();
    expect(tx.journalEntryId).toBeNull();
  });

  // ── T7: owner accepts normally ───────────────────────────────────────────
  it('T7: company A ACCEPT succeeds — accounting committed under A', async () => {
    const a = await createTenant(`t7-${RUN}`);
    const approval = await createAiProposal(a);

    const res = await decideAiProposal({
      companyId: a.company.id,
      approvalId: approval.id,
      decision: 'ACCEPT',
    });
    expect(res.status).toBe('OK');

    const row = await db.bankTransaction.findUniqueOrThrow({
      where: { id: a.tx.id },
    });
    expect(row.glAccountId).toBe(a.aiGl.id);
    expect(row.journalEntryId).not.toBeNull();

    const appr = await db.pendingApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(appr.status).toBe('accepted');
    expect(await db.journalEntry.count({ where: { companyId: a.company.id } })).toBe(1);
  });

  // ── T8: post-commit learning stays under company A ───────────────────────
  it('T8: learning after ACCEPT lands exclusively under company A', async () => {
    const a = await createTenant(`t8a-${RUN}`);
    const b = await createTenant(`t8b-${RUN}`);
    const knowledge = await seedKnowledge(a);
    const approval = await createAiProposal(a);

    resolveEntitySpy.mockClear();
    const res = await decideAiProposal({
      companyId: a.company.id,
      approvalId: approval.id,
      decision: 'ACCEPT',
    });
    expect(res.status).toBe('OK');

    // resolveEntity is NEVER called with B's tenant.
    expect(resolveEntitySpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of resolveEntitySpy.mock.calls) {
      expect(call[0]).toBe(a.company.id);
    }

    // Treatment learned under A with the accepted GL.
    const treatment = await lookupTreatment(
      adapter(),
      a.company.id,
      knowledge.id,
    );
    expect(treatment.status).toBe('FOUND');
    if (treatment.status === 'FOUND') {
      expect(treatment.glAccountId).toBe(a.aiGl.id);
    }

    // Observation recorded under A for that entity.
    const observations = await getClassificationObservations(
      adapter(),
      a.company.id,
      knowledge.id,
    );
    expect(observations.length).toBeGreaterThan(0);

    // No memory row of THIS run belongs to B — learning stayed under A.
    const scopedMemory = await db.memoryItem.findMany({
      where: { companyId: { in: [a.company.id, b.company.id] } },
      select: { companyId: true },
    });
    expect(scopedMemory.length).toBeGreaterThan(0);
    for (const item of scopedMemory) {
      expect(item.companyId).toBe(a.company.id);
    }
    expect(b.company.id).not.toBe(a.company.id);
  });

  // ── T9: guard exclusion is tenant-scoped ─────────────────────────────────
  it('T9: A\u2019s pending decision never blocks B\u2019s transactions', async () => {
    const a = await createTenant(`t9a-${RUN}`);
    const b = await createTenant(`t9b-${RUN}`);
    await seedRule(a);
    await seedRule(b);

    // Adversarial row: owned by A, payload.transactionId = B's importHash.
    await db.pendingApproval.create({
      data: {
        companyId: a.company.id,
        action: 'ai_classification_proposal',
        payload: proposalPayload(a, { transactionId: b.importHash }),
        requestedBy: a.user.id,
        status: 'pending',
      },
    });

    // Exclusion computed for B sees NO pending decision.
    const exclB = await excludePendingHumanDecisions(db, b.company.id);
    expect(exclB).toEqual({});
    // Exclusion computed for A contains A's own pending (B's hash under A).
    const exclA = await excludePendingHumanDecisions(db, a.company.id);
    expect(JSON.stringify(exclA)).toContain(b.importHash);

    // B's transaction still matches despite A's pending referencing it.
    const matchB = await matchTransactions(b.company.id);
    expect(matchB.totalCount).toBe(1);
    expect(matchB.matchedRules[0]!.txIds).toContain(b.tx.id);

    // A's own transaction (different hash) still matches under A.
    const matchA = await matchTransactions(a.company.id);
    expect(matchA.totalCount).toBe(1);
    expect(matchA.matchedRules[0]!.txIds).toContain(a.tx.id);

    // Write-time revalidation: true under B's scope, false under A's scope
    // (A's pending targets that hash — scoping decides, not ownership leak).
    expect(await revalidateAutoMatchCandidate(db, b.tx.id, b.company.id)).toBe(true);
    expect(await revalidateAutoMatchCandidate(db, b.tx.id, a.company.id)).toBe(false);
  });

  // ── T10: import producer writes companyId ────────────────────────────────
  it('T10: ImportService.importFile persists the AI proposal with companyId', async () => {
    const a = await createTenant(`t10-${RUN}`);
    vi.stubEnv('BANK_RULE_ENGINE', 'v2');
    vi.mocked(runRuleEngineV2).mockResolvedValueOnce({
      outcome: 'pending',
      deterministicResult: 'no_match',
      aiProposal: {
        role: 'expense',
        glAccountCode: '6100',
        glAccountId: a.aiGl.id,
        conditions: [],
        suggestSubAccount: false,
        subAccountName: null,
      },
    });

    const csv = `Date,Description,Amount\n2025-06-16,T10 import merchant ${RUN},-100.00`;
    const result = await ImportService.importFile({
      companyId: a.company.id,
      bankAccountId: a.bankAccount.id,
      fileName: `t10-${RUN}.csv`,
      extension: 'csv',
      buffer: Buffer.from(csv),
      content: csv,
      userId: a.user.id,
    });
    expect(result.transactionCount).toBe(1);

    const rows = await db.pendingApproval.findMany({
      where: { companyId: a.company.id, action: 'ai_classification_proposal' },
    });
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as { companyId?: unknown };
    expect(payload.companyId).toBe(a.company.id);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.requestedBy).toBe(a.user.id);
  });

  // ── T11: admin DELETE removes ALL pendings of the company ────────────────
  it('T11: admin company DELETE purges knowledgeId-NULL pendings of A only', async () => {
    const a = await createTenant(`t11a-${RUN}`);
    const b = await createTenant(`t11b-${RUN}`);
    const admin = await db.user.create({
      data: {
        email: `t11-admin-${RUN}@example.com`,
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Super',
        lastName: 'Admin',
        platformRole: 'super_admin',
      },
    });
    await createTestCompanyMember(admin.id, a.company.id);
    const token = await createSession(admin.id);

    // A: create-approval (knowledgeId NULL) + AI approval (knowledgeId NULL).
    await proposeCreate({
      companyId: a.company.id,
      type: 'person',
      canonicalName: `T11 person ${RUN}`,
      metadata: {},
      requestedBy: a.user.id,
    });
    const pAiA = await createAiProposal(a);
    // B: unrelated pending that must survive.
    const pB = await createAiProposal(b);

    const req = new NextRequest(
      `http://localhost/api/admin/companies/${a.company.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    const res = await deleteCompanyRoute(req, {
      params: Promise.resolve({ id: a.company.id }),
    });
    expect(res.status).toBe(200);

    expect(
      await db.pendingApproval.count({ where: { companyId: a.company.id } }),
    ).toBe(0);
    expect(await db.company.findUnique({ where: { id: a.company.id } })).toBeNull();

    const bRows = await db.pendingApproval.findMany({
      where: { companyId: b.company.id },
      select: { id: true },
    });
    expect(bRows.map((r) => r.id)).toEqual([pB.id]);
    expect(bRows.map((r) => r.id)).not.toContain(pAiA.id);
    expect(await db.company.findUnique({ where: { id: b.company.id } })).not.toBeNull();
  });

  // ── T12: human gate intact — pending means NOTHING happens ───────────────
  it('T12: a pending proposal blocks matching/apply with zero learning', async () => {
    const a = await createTenant(`t12-${RUN}`);
    const knowledge = await seedKnowledge(a);
    await seedRule(a);
    const approval = await createAiProposal(a);

    resolveEntitySpy.mockClear();

    // Match-time: the governed transaction is not even a candidate.
    const matchResult = await matchTransactions(a.company.id);
    expect(matchResult.totalCount).toBe(0);

    // Write-time with the (empty) result: nothing applied, nothing posted.
    const applied = await db.$transaction((tx) =>
      executeApplyAll(a.company.id, tx, matchResult, {
        userId: a.user.id,
        origin: 'batch',
      }),
    );
    expect(applied.appliedCount).toBe(0);
    expect(applied.journalEntryCount).toBe(0);

    // Row untouched, approval pending, books empty.
    const row = await db.bankTransaction.findUniqueOrThrow({
      where: { id: a.tx.id },
    });
    expect(row.glAccountId).toBeNull();
    expect(row.matchedRuleId).toBeNull();
    expect(row.journalEntryId).toBeNull();
    const appr = await db.pendingApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(appr.status).toBe('pending');
    expect(
      await db.journalEntry.count({ where: { companyId: a.company.id } }),
    ).toBe(0);

    // No KE learning before human approval.
    const treatment = await lookupTreatment(
      adapter(),
      a.company.id,
      knowledge.id,
    );
    expect(treatment.status).toBe('NOT_FOUND');
    expect(
      await getClassificationObservations(adapter(), a.company.id, knowledge.id),
    ).toHaveLength(0);
    expect(resolveEntitySpy).not.toHaveBeenCalled();
  });
});
