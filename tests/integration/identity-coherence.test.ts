// G8-2 §10 — Causal Tests T1–T7: Identity Coherence
//
// Certifies the G8-2 identity-serialization contract on a REAL isolated
// database (no DB mocks, no $transaction mocks, no fake repositories):
// the per-Company FOR UPDATE lock plus the in-transaction identity
// prechecks must make every identity mutation serialized, conflict-safe
// and atomic.
//
// Coverage (§11 of the controlled-build order):
//   T1  duplicate canonical → second confirm rejects ConflictError,
//       exactly one active entity remains
//   T2  concurrency serialization → two real operations race the same
//       identity key: real concurrency observed, serialization by the
//       Company lock, second operation observes the first one's result,
//       never two active equivalents
//   T3  double confirm → one winner consumes the PendingApproval exactly
//       once; the loser fails contractually; one CK, one create audit
//   T4  real rollback → appendAuditEntry fails AFTER the real
//       companyKnowledge.create (missing request-context) → CK not
//       persisted, pending still pending, audit count unchanged
//   T5  restore collision → archived A cannot reactivate over active B
//       sharing the identity key (ConflictError, both states preserved)
//   T6  confirmUpdate collision → B cannot take A's active identity;
//       B remains unchanged
//   T7  merge/archive stale-state → archive never overwrites an
//       already-merged source; source remains merged
//
// T8 (confirmEntityIdentity alias collision) lives in the two adapted
// mock-based suites per the contract:
//   tests/services/company-knowledge/entity-service.test.ts
//   tests/memory/entity-identity-confirmation.test.ts
//
// No production database is used. No production code is modified here.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { requestContext } from '../../src/lib/context-storage';
import { AppError, ConflictError } from '../../src/lib/api-error';
import {
  proposeCreate,
  proposeUpdate,
  confirmCreate,
  confirmUpdate,
  archive,
  restore,
  merge,
  confirmEntityIdentity,
} from '../../src/internal/company-knowledge/entity/service';
import { createTestCompany, clearDatabase } from '../helpers/factories';

vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });

// Independent real PrismaClient for fresh reads (and a second one is
// created per race as the lock-wait observer — T2 requires multiple real
// PrismaClient instances contending/observing on the same PostgreSQL).
const prisma = new PrismaClient();

const HUMAN = 'g8-2-causal-tester';

// ─── Fixture ownership (test isolation) ─────────────────────────
//
// Same self-contained pattern as entity-merge-ke-consolidation.test.ts:
// every company/pending this file creates is registered here and removed
// in afterEach, in FK order, without relying on clearDatabase() (which
// only cleans @example.com-owned companies and never touches
// KnowledgeAudit / PendingApproval / CompanyKnowledge).

const fixtureCompanyIds = new Set<string>();
const fixturePendingIds = new Set<string>();

async function createFixtureCompany(name: string) {
  const company = await createTestCompany(name);
  fixtureCompanyIds.add(company.id);
  return company;
}

function trackPending(pendingId: string) {
  fixturePendingIds.add(pendingId);
}

/**
 * Deletes, in FK order, exactly the data this file created:
 * KnowledgeAudit → PendingApproval → CompanyKnowledge → AuditLog →
 * Company. Idempotent; runs even when a test fails.
 */
async function cleanupOwnFixtures(): Promise<void> {
  const companyIds = [...fixtureCompanyIds];
  const pendingIds = [...fixturePendingIds];
  if (companyIds.length === 0 && pendingIds.length === 0) return;

  const knowledgeRows = companyIds.length
    ? await prisma.companyKnowledge.findMany({
        where: { companyId: { in: companyIds } },
        select: { id: true },
      })
    : [];
  const knowledgeIds = knowledgeRows.map((row) => row.id);

  if (knowledgeIds.length > 0) {
    await prisma.knowledgeAudit.deleteMany({
      where: { knowledgeId: { in: knowledgeIds } },
    });
    await prisma.pendingApproval.deleteMany({
      where: { knowledgeId: { in: knowledgeIds } },
    });
    await prisma.companyKnowledge.deleteMany({
      where: { id: { in: knowledgeIds } },
    });
  }
  if (pendingIds.length > 0) {
    await prisma.pendingApproval.deleteMany({
      where: { id: { in: pendingIds } },
    });
  }
  if (companyIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { companyId: { in: companyIds } },
    });
    await prisma.company.deleteMany({
      where: { id: { in: companyIds } },
    });
  }

  fixtureCompanyIds.clear();
  fixturePendingIds.clear();
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await cleanupOwnFixtures();
  await clearDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Helpers ─────────────────────────────────────────────────────

/** Runs a service call with the real request-context (audit identity). */
function runAs<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ userId: HUMAN, companyId }, fn);
}

/** proposeCreate + confirmCreate through the real service. */
async function proposeAndConfirm(companyId: string, canonicalName: string) {
  const pending = await proposeCreate({
    companyId,
    type: 'person',
    canonicalName,
    metadata: {},
    requestedBy: HUMAN,
  });
  trackPending(pending.id);
  return runAs(companyId, () =>
    confirmCreate({ pendingApprovalId: pending.id, companyId }),
  );
}

/**
 * Holds the Company FOR UPDATE lock from an independent real PrismaClient
 * until released, so both racing service operations are deterministically
 * parked on the lock at the same time (real, observable contention).
 */
async function startCompanyLockBlocker(companyId: string) {
  const blocker = new PrismaClient();

  let markHeld!: () => void;
  let failHeld!: (error: unknown) => void;
  const held = new Promise<void>((resolve, reject) => {
    markHeld = resolve;
    failHeld = reject;
  });

  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const tx = blocker.$transaction(
    async (bt) => {
      await bt.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
      markHeld();
      await gate;
    },
    { timeout: 30000 },
  );
  tx.catch((error) => failHeld(error));
  await held;

  return {
    release: () => openGate(),
    done: async () => {
      openGate();
      await Promise.allSettled([tx]);
      await blocker.$disconnect();
    },
  };
}

/**
 * Polls pg_stat_activity from an independent real PrismaClient until at
 * least `min` distinct backends are Lock-waiting on the Company
 * FOR UPDATE statement (i.e., real concurrent operations serialized by
 * the G8-2 company lock). Returns the observed pids (possibly fewer than
 * `min` on timeout so the caller can fail loudly).
 */
async function waitForCompanyLockWaiters(
  observer: PrismaClient,
  min: number,
  timeoutMs = 10000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let pids: Array<{ pid: number }> = [];
  while (Date.now() < deadline) {
    pids = await observer.$queryRaw<Array<{ pid: number }>>`
      SELECT DISTINCT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%FROM "Company"%'
        AND query ILIKE '%FOR UPDATE%'`;
    if (pids.length >= min) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pids.map((row) => Number(row.pid));
}

function settledSummary(settled: PromiseSettledResult<unknown>[]): string[] {
  return settled.map((r) =>
    r.status === 'fulfilled'
      ? 'fulfilled'
      : `rejected: ${(r.reason as Error)?.message}`,
  );
}

// ─── Tests ───────────────────────────────────────────────────────

describe('G8-2 §10 identity coherence (real DB)', () => {
  // ── T1 — duplicate canonical ────────────────────────────────────
  it('T1: duplicate canonical — second create is rejected, one active remains', async () => {
    const company = await createFixtureCompany('G8-2 T1');
    const KEY = 'G82 T1 Duplicate';

    const first = await proposeAndConfirm(company.id, KEY);
    expect(first.status).toBe('active');

    // Second, equivalent create through the full propose+confirm flow.
    const pendingTwo = await proposeCreate({
      companyId: company.id,
      type: 'person',
      canonicalName: KEY,
      metadata: {},
      requestedBy: HUMAN,
    });
    trackPending(pendingTwo.id);

    await expect(
      runAs(company.id, () =>
        confirmCreate({
          pendingApprovalId: pendingTwo.id,
          companyId: company.id,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Fresh read: exactly one active entity owns the identity.
    const actives = await prisma.companyKnowledge.findMany({
      where: {
        companyId: company.id,
        canonicalName: KEY,
        status: 'active',
      },
    });
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(first.id);
  });

  // ── T2 — concurrency serialization ──────────────────────────────
  it('T2: concurrency serialization — same identity key races are serialized by the Company lock', async () => {
    const company = await createFixtureCompany('G8-2 T2');
    const KEY = 'G82 T2 Entity';
    const ALIAS = 'G82-T2-ALIAS';

    // Three real PrismaClient instances participate: the service's own
    // `db` client (both operations, real pool), the blocker, and the
    // observer below.
    const observer = new PrismaClient();
    const blocker = await startCompanyLockBlocker(company.id);
    let ops: Array<Promise<unknown>> = [];

    try {
      // Two concurrent operations introducing the SAME identity key.
      ops = [
        runAs(company.id, () =>
          confirmEntityIdentity({
            companyId: company.id,
            canonicalName: KEY,
            observedAlias: ALIAS,
            entityType: 'person',
          }),
        ),
        runAs(company.id, () =>
          confirmEntityIdentity({
            companyId: company.id,
            canonicalName: KEY,
            observedAlias: ALIAS,
            entityType: 'person',
          }),
        ),
      ];

      // Real concurrency + serialization: BOTH operations are parked on
      // the Company FOR UPDATE lock at the same time, observed from an
      // independent real client.
      const waiters = await waitForCompanyLockWaiters(observer, 2);
      expect(waiters.length).toBeGreaterThanOrEqual(2);

      blocker.release();
      const settled = await Promise.allSettled(ops);

      // Both operations succeed; the second one observes the first one's
      // committed result (idempotent reuse of the same entity).
      expect(settledSummary(settled)).toEqual(['fulfilled', 'fulfilled']);
      const ids = settled.map((r) =>
        r.status === 'fulfilled'
          ? (r.value as { id: string }).id
          : 'rejected',
      );
      expect(ids[0]).toBe(ids[1]);

      // No two active equivalents.
      const actives = await prisma.companyKnowledge.findMany({
        where: {
          companyId: company.id,
          canonicalName: KEY,
          status: 'active',
        },
      });
      expect(actives).toHaveLength(1);
      expect(actives[0].aliases).toEqual([ALIAS]);
    } finally {
      blocker.release();
      await blocker.done();
      await Promise.allSettled(ops);
      await observer.$disconnect();
    }
  });

  // ── T3 — double confirm ─────────────────────────────────────────
  it('T3: double confirm — one winner consumes the pending exactly once', async () => {
    const company = await createFixtureCompany('G8-2 T3');
    const KEY = 'G82 T3 Pending';

    const pending = await proposeCreate({
      companyId: company.id,
      type: 'person',
      canonicalName: KEY,
      metadata: {},
      requestedBy: HUMAN,
    });
    trackPending(pending.id);

    const observer = new PrismaClient();
    const blocker = await startCompanyLockBlocker(company.id);
    let ops: Array<Promise<unknown>> = [];

    try {
      // Two concurrent confirmCreate calls over the SAME PendingApproval.
      ops = [
        runAs(company.id, () =>
          confirmCreate({
            pendingApprovalId: pending.id,
            companyId: company.id,
          }),
        ),
        runAs(company.id, () =>
          confirmCreate({
            pendingApprovalId: pending.id,
            companyId: company.id,
          }),
        ),
      ];

      // Both confirmers are really in flight on the Company lock.
      const waiters = await waitForCompanyLockWaiters(observer, 2);
      expect(waiters.length).toBeGreaterThanOrEqual(2);

      blocker.release();
      const settled = await Promise.allSettled(ops);

      const winners = settled.filter((r) => r.status === 'fulfilled');
      const losers = settled.filter((r) => r.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      // The loser observes the consumption. Under Company-lock
      // serialization the winner deletes the approval in-tx, so the loser
      // reads "not found"; when the row is still present but already
      // claimed, the CAS guard reports NOT_PENDING. Both are the
      // contractual consumed-pending failures.
      const loserMessage = (
        (losers[0] as PromiseRejectedResult).reason as Error
      ).message;
      expect(loserMessage).toMatch(/not found|NOT_PENDING/);

      const winner = (
        winners[0] as PromiseFulfilledResult<{ id: string; status: string }>
      ).value;
      expect(winner.status).toBe('active');

      // One CK.
      const rows = await prisma.companyKnowledge.findMany({
        where: { companyId: company.id, canonicalName: KEY },
      });
      expect(rows).toHaveLength(1);

      // One create-audit effect.
      const createAudits = await prisma.knowledgeAudit.count({
        where: { knowledgeId: winner.id, action: 'create' },
      });
      expect(createAudits).toBe(1);

      // Pending consumed exactly once (row gone).
      const pendingLeft = await prisma.pendingApproval.findMany({
        where: { id: pending.id },
      });
      expect(pendingLeft).toHaveLength(0);
    } finally {
      blocker.release();
      await blocker.done();
      await Promise.allSettled(ops);
      await observer.$disconnect();
    }
  });

  // ── T4 — real rollback ──────────────────────────────────────────
  it('T4: real rollback — audit failure after the real create rolls everything back', async () => {
    const company = await createFixtureCompany('G8-2 T4');
    const KEY = 'G82 T4 Rollback';

    const pending = await proposeCreate({
      companyId: company.id,
      type: 'person',
      canonicalName: KEY,
      metadata: {},
      requestedBy: HUMAN,
    });
    trackPending(pending.id);

    const auditsBefore = await prisma.knowledgeAudit.count();

    // No request-context: appendAuditEntry (step AFTER the real
    // companyKnowledge.create) throws AppError 401 AUTH_REQUIRED.
    let failure: unknown = null;
    try {
      await confirmCreate({
        pendingApprovalId: pending.id,
        companyId: company.id,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).statusCode).toBe(401);
    expect((failure as Error).message).toBe('Authentication required');

    // Fresh reads:
    // - CK does not persist (the create happened BEFORE the failing audit,
    //   so a surviving CK would prove the audit was outside the tx).
    const rows = await prisma.companyKnowledge.findMany({
      where: { companyId: company.id, canonicalName: KEY },
    });
    expect(rows).toHaveLength(0);

    // - pending is still pending (the in-tx CAS claim rolled back too).
    const pendingRow = await prisma.pendingApproval.findUnique({
      where: { id: pending.id },
    });
    expect(pendingRow).not.toBeNull();
    expect(pendingRow!.status).toBe('pending');

    // - audit count did not increase.
    const auditsAfter = await prisma.knowledgeAudit.count();
    expect(auditsAfter).toBe(auditsBefore);
  });

  // ── T5 — restore collision ──────────────────────────────────────
  it('T5: restore collision — archived A cannot reactivate over active B with the same key', async () => {
    const company = await createFixtureCompany('G8-2 T5');
    const KEY = 'G82 T5 Key';

    const entityA = await proposeAndConfirm(company.id, KEY);
    await runAs(company.id, () =>
      archive({ knowledgeId: entityA.id, companyId: company.id }),
    );

    // An archived entity no longer reserves the identity, so B takes it.
    const entityB = await proposeAndConfirm(company.id, KEY);
    expect(entityB.status).toBe('active');

    await expect(
      runAs(company.id, () =>
        restore({ knowledgeId: entityA.id, companyId: company.id }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Fresh reads: A stays archived (version unchanged by the failed
    // restore), B stays active.
    const aFresh = await prisma.companyKnowledge.findUnique({
      where: { id: entityA.id },
    });
    expect(aFresh?.status).toBe('archived');
    expect(aFresh?.version).toBe(2); // created (1) → archived (2)

    const bFresh = await prisma.companyKnowledge.findUnique({
      where: { id: entityB.id },
    });
    expect(bFresh?.status).toBe('active');
  });

  // ── T6 — confirmUpdate collision ────────────────────────────────
  it('T6: confirmUpdate collision — B cannot take A active identity; B unchanged', async () => {
    const company = await createFixtureCompany('G8-2 T6');
    const TARGET_KEY = 'G82 T6 Target';

    const entityA = await proposeAndConfirm(company.id, TARGET_KEY);
    const entityB = await proposeAndConfirm(company.id, 'G82 T6 B');

    const pendingUpdate = await proposeUpdate({
      knowledgeId: entityB.id,
      companyId: company.id,
      updates: { canonicalName: TARGET_KEY },
      requestedBy: HUMAN,
    });
    trackPending(pendingUpdate.id);

    await expect(
      runAs(company.id, () =>
        confirmUpdate({
          pendingApprovalId: pendingUpdate.id,
          companyId: company.id,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Fresh reads: B did not change at all; A untouched.
    const bFresh = await prisma.companyKnowledge.findUnique({
      where: { id: entityB.id },
    });
    expect(bFresh?.canonicalName).toBe('G82 T6 B');
    expect(bFresh?.version).toBe(entityB.version);

    const aFresh = await prisma.companyKnowledge.findUnique({
      where: { id: entityA.id },
    });
    expect(aFresh?.canonicalName).toBe(TARGET_KEY);
    expect(aFresh?.status).toBe('active');
  });

  // ── T7 — merge/archive stale-state ──────────────────────────────
  it('T7: stale-state guard — archive never overwrites an already-merged source', async () => {
    const company = await createFixtureCompany('G8-2 T7');

    const source = await proposeAndConfirm(company.id, 'G82 T7 Source');
    const target = await proposeAndConfirm(company.id, 'G82 T7 Target');

    await runAs(company.id, () =>
      merge({
        sourceKnowledgeId: source.id,
        targetKnowledgeId: target.id,
        companyId: company.id,
        fieldResolutions: {},
        reason: 'G8-2 T7 stale-state',
      }),
    );

    await expect(
      runAs(company.id, () =>
        archive({ knowledgeId: source.id, companyId: company.id }),
      ),
    ).rejects.toThrow(
      /Cannot archive: entity .* is not active \(current status: merged\)/,
    );

    // Fresh read: the source remains merged.
    const sourceFresh = await prisma.companyKnowledge.findUnique({
      where: { id: source.id },
    });
    expect(sourceFresh?.status).toBe('merged');
    expect(sourceFresh?.mergedIntoId).toBe(target.id);
  });
});
