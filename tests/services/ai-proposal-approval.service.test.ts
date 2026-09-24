// S10 1B.2B.2 — AI proposal approval consumer (server-side authority).
// Demonstrates the full closed loop:
//   AI proposal → human decision → CAS → reclassifyTransaction (same tx)
//   → atomic approval + accounting commit → KE strictly post-commit.
// Tenant chain, importHash→id resolution, and once-only consumption are
// proven against the REAL database (no behavioral mocks of the CAS or
// transactional rollback semantics).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { GET, POST } from '../../src/app/api/import/ai-proposals/route';
import {
  decideAiProposal,
  listPendingAiProposals,
} from '../../src/lib/services/ai-proposal-approval.service';
import { reclassifyTransaction } from '../../src/lib/services/transaction-reclassification.service';
import { resolveEntity } from '@/memory/entity-resolution';
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
import { createSession } from '@/lib/sessions';

// Spy-with-passthrough: observe calls WITHOUT altering certified behavior.
vi.mock('../../src/lib/services/transaction-reclassification.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/services/transaction-reclassification.service')>();
  return {
    ...actual,
    reclassifyTransaction: vi.fn(actual.reclassifyTransaction),
  };
});
const reclassifySpy = vi.mocked(reclassifyTransaction);

vi.mock('@/memory/entity-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/memory/entity-resolution')>();
  return { ...actual, resolveEntity: vi.fn(actual.resolveEntity) };
});
const resolveEntitySpy = vi.mocked(resolveEntity);

// ─── Fixtures ──────────────────────────────────────────────────────────────

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
  // GL the human picks in CORRECT.
  const humanGl = await createTestGlAccount({
    companyId: company.id,
    code: '6200',
    name: 'Human corrected expense',
    accountType: 'expense',
  });

  const bankAccount = await createTestBankAccount(company.id, bankGl.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const tx = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-05-15',
    amount: 100.0,
    description: `AI proposal test ${tag}`,
  });
  const importHash = `import-hash-${tag}`;
  await db.bankTransaction.update({
    where: { id: tx.id },
    data: { importHash },
  });

  return { user, company, token, bankGl, aiGl, humanGl, bankAccount, statement, tx, importHash };
}

type Setup = Awaited<ReturnType<typeof setupCompany>>;

function basePayload(s: Setup, overrides: Record<string, unknown> = {}) {
  return {
    companyId: s.company.id,
    transactionId: s.importHash,
    bankAccountId: s.bankAccount.id,
    deterministicResult: 'ambiguous',
    aiProposal: {
      role: 'expense',
      glAccountCode: '6100',
      glAccountId: s.aiGl.id,
      suggestSubAccount: false,
      subAccountName: null,
      conditions: [],
    },
    proposedEntity: { canonicalName: 'AI Suggested SA', entityType: 'company' },
    ...overrides,
  };
}

async function createProposal(
  s: Setup,
  overrides: {
    payload?: Record<string, unknown>;
    action?: string;
    status?: string;
  } = {},
) {
  return db.pendingApproval.create({
    data: {
      action: overrides.action ?? 'ai_classification_proposal',
      payload: basePayload(s, overrides.payload ?? {}),
      requestedBy: s.user.id,
      status: overrides.status ?? 'pending',
    },
  });
}

async function getApproval(id: string) {
  return db.pendingApproval.findUnique({ where: { id } });
}

async function getBankTx(id: string) {
  return db.bankTransaction.findUnique({ where: { id } });
}

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

describe('S10 1B.2B.2 — AI proposal approval consumer', () => {
  beforeEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  // ─── A. GET listing ─────────────────────────────────────────────────────
  it('A: GET returns only the active company pending ai_classification_proposals', async () => {
    const a = await setupCompany('ai-list-a');
    const b = await setupCompany('ai-list-b');
    const proposalA = await createProposal(a);
    await createProposal(b);

    const res = await GET(getReq(a), emptyParams);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.proposals).toHaveLength(1);
    const item = body.proposals[0];
    expect(item.approvalId).toBe(proposalA.id);
    expect(item.transaction.id).toBe(a.tx.id);
    expect(item.transaction.description).toBe('AI proposal test ai-list-a');
    expect(item.transaction.amount).toBe(100);
    expect(item.proposedGlAccount).toMatchObject({ code: '6100', name: 'AI proposed expense' });
    expect(item.proposedEntity).toMatchObject({ canonicalName: 'AI Suggested SA' });
    expect(item.deterministicResult).toBe('ambiguous');
    expect(item.aiProposal).toMatchObject({ role: 'expense' });
    expect(item.bankAccountId).toBe(a.bankAccount.id);
  });

  // ─── B. Tenant isolation (route level) ──────────────────────────────────
  it('B: company B can neither read nor decide company A proposals', async () => {
    const a = await setupCompany('ai-iso-a');
    const b = await setupCompany('ai-iso-b');
    const proposalA = await createProposal(a);

    // Read: A's proposal is invisible to B.
    const readRes = await GET(getReq(b), emptyParams);
    expect(readRes.status).toBe(200);
    const readBody = await readRes.json();
    expect(readBody.proposals).toHaveLength(0);

    // Decide: B attempting ACCEPT on A's proposal → 404, zero mutation.
    const decideRes = await POST(
      postReq(b, { approvalId: proposalA.id, decision: 'ACCEPT' }),
      emptyParams,
    );
    expect(decideRes.status).toBe(404);

    expect((await getApproval(proposalA.id))!.status).toBe('pending');
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBeNull();
    expect(tx!.journalEntryId).toBeNull();
    expect(reclassifySpy).not.toHaveBeenCalled();
  });

  // ─── C. Manipulated payload.companyId ───────────────────────────────────
  it('C: payload.companyId inconsistent with the session tenant is rejected without mutation', async () => {
    const a = await setupCompany('ai-payload-a');
    const proposal = await createProposal(a, {
      payload: { companyId: 'some-other-company-id' },
    });

    const listed = await listPendingAiProposals(a.company.id);
    expect(listed).toHaveLength(0);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toEqual({ status: 'TENANT_MISMATCH' });

    expect((await getApproval(proposal.id))!.status).toBe('pending');
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBeNull();
    expect(tx!.journalEntryId).toBeNull();
    expect(reclassifySpy).not.toHaveBeenCalled();
  });

  // ─── D. importHash → BankTransaction.id ─────────────────────────────────
  it('D: payload.transactionId resolves importHash to the real BankTransaction.id; ghost hash is rejected', async () => {
    const a = await setupCompany('ai-hash-a');
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toMatchObject({ status: 'OK', decision: 'ACCEPT' });

    // The authority received the REAL id, never the importHash.
    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    expect(reclassifySpy).toHaveBeenCalledWith(
      {
        companyId: a.company.id,
        transactionId: a.tx.id,
        glAccountId: a.aiGl.id,
        confirmedEntity: undefined,
      },
      { tx: expect.anything() },
    );

    // A payload whose importHash matches no transaction: tenant chain fails.
    const ghost = await db.pendingApproval.create({
      data: {
        action: 'ai_classification_proposal',
        payload: basePayload(a, { transactionId: 'ghost-hash-no-such-row' }),
        requestedBy: a.user.id,
        status: 'pending',
      },
    });
    const ghostResult = await decideAiProposal({
      companyId: a.company.id,
      approvalId: ghost.id,
      decision: 'ACCEPT',
    });
    expect(ghostResult).toEqual({ status: 'TENANT_MISMATCH' });
    expect((await getApproval(ghost.id))!.status).toBe('pending');
  });

  // ─── E. ACCEPT ──────────────────────────────────────────────────────────
  it('E: ACCEPT consumes the proposal GL, commits accounting + journal atomically, KE runs post-commit exactly once', async () => {
    const a = await setupCompany('ai-accept-a');
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toMatchObject({
      status: 'OK',
      decision: 'ACCEPT',
      approvalStatus: 'accepted',
    });

    // CAS transition.
    expect((await getApproval(proposal.id))!.status).toBe('accepted');

    // Accounting: the transaction now points at the AI-proposed GL and
    // carries a journal entry (reclassifyTransaction is the sole author).
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBe(a.aiGl.id);
    expect(tx!.journalEntryId).not.toBeNull();

    // Same-transaction accounting: the authority joined OUR open tx.
    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    expect(reclassifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: a.company.id, transactionId: a.tx.id }),
      { tx: expect.anything() },
    );

    // KE executed AFTER commit, exactly once (once-guard).
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
  });

  // ─── F. ACCEPT never confirms AI identity ───────────────────────────────
  it('F: ACCEPT does not auto-confirm the AI-proposed entity', async () => {
    const a = await setupCompany('ai-entity-a');
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result.status).toBe('OK');

    // The AI-suggested proposedEntity was NOT forwarded as human confirmation.
    expect(reclassifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedEntity: undefined }),
      expect.anything(),
    );

    // Trying to smuggle a confirmedEntity through ACCEPT is refused
    // outright, without consuming the approval.
    const second = await createProposal(a, {
      payload: { transactionId: `${a.importHash}-second` },
    });
    await db.bankTransaction.update({
      where: { id: a.tx.id },
      data: { importHash: `${a.importHash}-second` },
    });
    const refused = await decideAiProposal({
      companyId: a.company.id,
      approvalId: second.id,
      decision: 'ACCEPT',
      confirmedEntity: { canonicalName: 'Smuggled SA', entityType: 'company' },
    });
    expect(refused).toEqual({ status: 'INVALID_INPUT' });
    expect((await getApproval(second.id))!.status).toBe('pending');
  });

  // ─── G. CORRECT ─────────────────────────────────────────────────────────
  it('G: CORRECT uses the human GL, supports explicit confirmedEntity, and learns the human value', async () => {
    const a = await setupCompany('ai-correct-a');
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'CORRECT',
      glAccountId: a.humanGl.id,
      confirmedEntity: { canonicalName: 'ACME SRL', entityType: 'company' },
    });
    expect(result).toMatchObject({
      status: 'OK',
      decision: 'CORRECT',
      approvalStatus: 'corrected',
    });

    expect((await getApproval(proposal.id))!.status).toBe('corrected');

    // Accounting uses the HUMAN GL — the AI proposal never overwrites it.
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBe(a.humanGl.id);
    expect(tx!.glAccountId).not.toBe(a.aiGl.id);
    expect(tx!.journalEntryId).not.toBeNull();

    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    expect(reclassifySpy).toHaveBeenCalledWith(
      {
        companyId: a.company.id,
        transactionId: a.tx.id,
        glAccountId: a.humanGl.id,
        confirmedEntity: { canonicalName: 'ACME SRL', entityType: 'company' },
      },
      { tx: expect.anything() },
    );

    // KE post-commit, exactly once.
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
  });

  // ─── H. REJECT ──────────────────────────────────────────────────────────
  it('H: REJECT transitions pending→rejected with NO reclassification, journal, or KE', async () => {
    const a = await setupCompany('ai-reject-a');
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'REJECT',
    });
    expect(result).toMatchObject({
      status: 'OK',
      decision: 'REJECT',
      approvalStatus: 'rejected',
    });

    expect((await getApproval(proposal.id))!.status).toBe('rejected');

    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBeNull();
    expect(tx!.journalEntryId).toBeNull();

    expect(reclassifySpy).not.toHaveBeenCalled();
    expect(resolveEntitySpy).not.toHaveBeenCalled();
  });

  // ─── I. CAS: sequential second decision ─────────────────────────────────
  it('I: a second decision on a consumed approval never executes accounting again', async () => {
    const a = await setupCompany('ai-cas-a');
    const proposal = await createProposal(a);

    const first = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(first.status).toBe('OK');

    const second = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'REJECT',
    });
    expect(second).toEqual({ status: 'NOT_PENDING' });

    // Original decision stands; accounting ran exactly once.
    expect((await getApproval(proposal.id))!.status).toBe('accepted');
    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBe(a.aiGl.id);
    expect(tx!.journalEntryId).not.toBeNull();
  });

  // ─── J. CAS: concurrent decisions ───────────────────────────────────────
  it('J: two concurrent decisions never produce double accounting/journal', async () => {
    const a = await setupCompany('ai-race-a');
    const proposal = await createProposal(a);

    const [r1, r2] = await Promise.all([
      decideAiProposal({
        companyId: a.company.id,
        approvalId: proposal.id,
        decision: 'ACCEPT',
      }),
      decideAiProposal({
        companyId: a.company.id,
        approvalId: proposal.id,
        decision: 'CORRECT',
        glAccountId: a.humanGl.id,
      }),
    ]);

    const results = [r1, r2];
    const winners = results.filter((r) => r.status === 'OK');
    const losers = results.filter((r) => r.status === 'NOT_PENDING');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Exactly one accounting execution.
    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    const tx = await getBankTx(a.tx.id);
    expect(tx!.journalEntryId).not.toBeNull();

    // Approval status matches the single winner's decision.
    const winner = winners[0];
    const approval = await getApproval(proposal.id);
    expect(approval!.status).toBe(
      winner.status === 'OK' && winner.decision === 'ACCEPT'
        ? 'accepted'
        : 'corrected',
    );
    expect(tx!.glAccountId).toBe(
      winner.status === 'OK' && winner.decision === 'ACCEPT'
        ? a.aiGl.id
        : a.humanGl.id,
    );
  });

  // ─── K. Accounting failure rolls the CAS back ───────────────────────────
  it('K: accounting failure (locked fiscal period) rolls back the approval; no KE runs', async () => {
    const a = await setupCompany('ai-rollback-a');
    await db.fiscalPeriod.create({
      data: {
        companyId: a.company.id,
        name: 'Locked May 2025',
        startDate: new Date('2025-05-01T00:00:00.000Z'),
        endDate: new Date('2025-05-31T23:59:59.999Z'),
        isLocked: true,
      },
    });
    const proposal = await createProposal(a);

    await expect(
      decideAiProposal({
        companyId: a.company.id,
        approvalId: proposal.id,
        decision: 'ACCEPT',
      }),
    ).rejects.toThrow();

    // CAS was rolled back with the accounting failure.
    expect((await getApproval(proposal.id))!.status).toBe('pending');
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBeNull();
    expect(tx!.journalEntryId).toBeNull();
    // KE never ran for a failed transaction.
    expect(resolveEntitySpy).not.toHaveBeenCalled();
  });

  // ─── L. KE failure never reverts accounting ─────────────────────────────
  it('L: post-commit KE failure leaves the accepted decision + accounting persisted', async () => {
    const a = await setupCompany('ai-ke-a');
    resolveEntitySpy.mockRejectedValueOnce(new Error('KE exploded'));
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });

    // The decision survived: KE failure is logged, never propagated.
    expect(result).toMatchObject({ status: 'OK', approvalStatus: 'accepted' });
    expect((await getApproval(proposal.id))!.status).toBe('accepted');
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBe(a.aiGl.id);
    expect(tx!.journalEntryId).not.toBeNull();
  });

  // ─── M. Invalid GLs ─────────────────────────────────────────────────────
  it('M1: ACCEPT with a proposal GL that fails authority validation leaves the approval pending', async () => {
    const a = await setupCompany('ai-badgl-a');
    const proposal = await createProposal(a, {
      payload: {
        aiProposal: {
          role: 'expense',
          glAccountCode: '9999',
          glAccountId: 'gl-does-not-exist',
          suggestSubAccount: false,
          subAccountName: null,
          conditions: [],
        },
      },
    });

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toEqual({
      status: 'RECLASSIFY_REJECTED',
      detail: 'GL_ACCOUNT_NOT_FOUND',
    });

    // No transition, no persisted accounting.
    expect((await getApproval(proposal.id))!.status).toBe('pending');
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBeNull();
    expect(tx!.journalEntryId).toBeNull();
  });

  it('M2: CORRECT with a nonexistent human GL leaves the approval pending', async () => {
    const a = await setupCompany('ai-badgl-b');
    const proposal = await createProposal(a);

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'CORRECT',
      glAccountId: 'human-gl-nope',
    });
    expect(result).toEqual({
      status: 'RECLASSIFY_REJECTED',
      detail: 'GL_ACCOUNT_NOT_FOUND',
    });

    expect((await getApproval(proposal.id))!.status).toBe('pending');
    const tx = await getBankTx(a.tx.id);
    expect(tx!.glAccountId).toBeNull();
    expect(tx!.journalEntryId).toBeNull();
  });

  // ─── N. Different action ────────────────────────────────────────────────
  it('N: approvals with a different action are not consumable nor listed', async () => {
    const a = await setupCompany('ai-action-a');
    const proposal = await createProposal(a, { action: 'some_other_action' });

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toEqual({ status: 'INVALID_ACTION' });
    expect((await getApproval(proposal.id))!.status).toBe('pending');

    const listed = await listPendingAiProposals(a.company.id);
    expect(listed).toHaveLength(0);
    expect(reclassifySpy).not.toHaveBeenCalled();
  });

  // ─── O. Non-pending status ──────────────────────────────────────────────
  it('O: approvals not in pending status are not consumable nor listed', async () => {
    const a = await setupCompany('ai-status-a');
    const proposal = await createProposal(a, { status: 'accepted' });

    const result = await decideAiProposal({
      companyId: a.company.id,
      approvalId: proposal.id,
      decision: 'ACCEPT',
    });
    expect(result).toEqual({ status: 'NOT_PENDING' });

    const listed = await listPendingAiProposals(a.company.id);
    expect(listed).toHaveLength(0);
    expect(reclassifySpy).not.toHaveBeenCalled();
  });
});
