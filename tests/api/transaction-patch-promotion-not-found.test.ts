// KE-WRITE-001 — Promotion NOT_FOUND observability tests
//
// Contract: when evolveClassificationConfidence returns NOT_FOUND inside
// promoteConfirmedTreatment (an internal anomaly: itemId comes from a
// successful learnEntityTreatment in the same request and no delete path
// exists), the anomaly must be EXPLICITLY OBSERVABLE at error severity:
//   - log identifies stage='confidence_promotion', error='item_not_found'
//   - no throw, no retry, no rollback; accounting transaction stands
//   - HTTP response contract unchanged (200 with the corrected transaction)
//   - NO ConfidenceLog and NO TraceabilityLog created (no fabricated evidence)
//   - confidence not mutated
// UNCHANGED remains a legitimate silent no-op; ERROR keeps its existing
// warn behavior; KE-EVOL-005 pending-conflict promotion gate is untouched.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Single mock db shared by the route and the real KE module ────

type StoredItem = {
  id: string;
  content: string;
  type: string;
  status: string;
  confidence: string;
  companyId: string;
  sourceAuthor: string;
  sourceName: string;
};

function createMockDb() {
  const memStore = new Map<string, StoredItem>();
  const confidenceLogs: Record<string, unknown>[] = [];
  const traceabilityLogs: Record<string, unknown>[] = [];
  let nextId = 1;

  const memoryItem = {
    create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; sourceAuthor: string; sourceName: string; confidence?: string } }) => {
      const id = `mem_${nextId++}`;
      const item: StoredItem = {
        id,
        content: args.data.content,
        type: args.data.type,
        status: 'active',
        confidence: typeof args.data.confidence === 'string' ? args.data.confidence : 'tentative',
        companyId: args.data.companyId,
        sourceAuthor: args.data.sourceAuthor,
        sourceName: args.data.sourceName,
      };
      memStore.set(id, item);
      return item;
    }),
    findFirst: vi.fn(async (args?: { where?: { id?: string; companyId?: string; content?: string; status?: string } }) => {
      for (const item of memStore.values()) {
        let match = true;
        if (args?.where?.id && item.id !== args.where.id) match = false;
        if (args?.where?.companyId && item.companyId !== args.where.companyId) match = false;
        if (args?.where?.content && item.content !== args.where.content) match = false;
        if (args?.where?.status && item.status !== args.where.status) match = false;
        if (match) return item;
      }
      return null;
    }),
    findMany: vi.fn(async (args?: { where?: { companyId?: string; type?: string; [key: string]: unknown } }) => {
      let results = Array.from(memStore.values());
      if (args?.where?.companyId) {
        results = results.filter((item) => item.companyId === args.where!.companyId);
      }
      if (args?.where?.type) {
        results = results.filter((item) => item.type === args.where!.type);
      }
      return results;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const item = memStore.get(args.where.id);
      if (item) {
        Object.assign(item, args.data);
        return item;
      }
      throw new Error('Not found');
    }),
  };

  const bankTransaction = {
    findFirst: vi.fn(),
    update: vi.fn(async (args: { where: { id: string }; data: { glAccountId?: string; journalEntryId?: string | null } }) => ({
      id: args.where.id,
      date: new Date('2025-06-15'),
      amount: 500,
      description: 'ABC 777 ENTITY-1',
      glAccountId: args.data.glAccountId ?? null,
      journalEntryId: args.data.journalEntryId ?? null,
    })),
  };

  const glAccount = {
    findFirst: vi.fn(async () => ({ id: 'gl-b', companyId: 'company-a', isActive: true })),
  };

  const self = {
    memoryItem,
    memoryVersion: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    relationship: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    contradiction: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    traceabilityLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        traceabilityLogs.push(args.data);
        return {};
      }),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        confidenceLogs.push(args.data);
        return {};
      }),
      findMany: vi.fn(async () => []),
    },
    bankTransaction,
    glAccount,
    $transaction: async <T>(fn: (tx: typeof self) => Promise<T>): Promise<T> => fn(self),
    reset: () => {
      memStore.clear();
      confidenceLogs.length = 0;
      traceabilityLogs.length = 0;
      nextId = 1;
    },
    store: memStore,
    confidenceLogs,
    traceabilityLogs,
  };
  return self;
}

vi.mock('@/lib/db', () => ({ db: createMockDb() }));
vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
}));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(() => ({ userId: 'user-1', companyId: 'company-a' })),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: vi.fn() }));
vi.mock('@/lib/fiscal-period-guard', () => ({ assertActiveFiscalPeriod: vi.fn() }));
vi.mock('@/lib/services/journal-entry.service', () => ({ JournalEntryService: class {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: vi.fn(),
}));
vi.mock('@/internal/company-knowledge/entity/service', () => ({
  confirmEntityIdentity: vi.fn(),
}));

// Partial KE mock: REAL operations behind call-through spies (repo precedent
// from transaction-patch-ke-conflict.test.ts) so persistence behavior is real.
vi.mock('@/memory/classification-knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/memory/classification-knowledge')>();
  return {
    ...actual,
    learnEntityTreatment: vi.fn(actual.learnEntityTreatment),
    recordClassificationObservation: vi.fn(actual.recordClassificationObservation),
    detectConflictingPattern: vi.fn(actual.detectConflictingPattern),
    evolveClassificationConfidence: vi.fn(actual.evolveClassificationConfidence),
    degradeKnowledgeOnConflict: vi.fn(actual.degradeKnowledgeOnConflict),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { MemoryPrismaClient, TransactionRunner } from '@/memory/prisma-types';
import {
  createAdapter,
  learnEntityTreatment,
  evolveClassificationConfidence,
} from '@/memory/classification-knowledge';
import { resolveEntity } from '@/memory/entity-resolution';

const COMPANY = 'company-a';
const ENTITY = 'entity-1';
const TX_ID = 'tx-1';

function makeAdapter() {
  const runTx: TransactionRunner = async (fn) => db.$transaction(fn as never);
  return createAdapter(db as unknown as MemoryPrismaClient, runTx);
}

// ─── PATCH harness ────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/transactions/${TX_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ glAccountId: 'gl-b' }),
  });
}

function patchContext() {
  return { params: Promise.resolve({ id: TX_ID }) };
}

async function runPatch(): Promise<Response> {
  const { PATCH } = await import('@/app/api/transactions/[id]/route');
  return PATCH(makeRequest(), patchContext());
}

describe('KE-WRITE-001 — promotion NOT_FOUND observability', () => {
  beforeEach(() => {
    db.reset();
    vi.clearAllMocks();

    // Accounting-success DB state by default
    vi.mocked(db.bankTransaction.findFirst).mockResolvedValue({
      id: TX_ID,
      statement: { bankAccount: { glAccountId: null } },
      journalEntryId: null,
      description: 'ABC 777 ENTITY-1',
      date: new Date('2025-06-15'),
      amount: 500,
    });
    vi.mocked(resolveEntity).mockResolvedValue({
      status: 'KNOWN',
      entityId: ENTITY,
    } as never);
  });

  // T1+T2+T3: NOT_FOUND → observable error-level log with stage=confidence_promotion,
  // error=item_not_found, unambiguous identifiers.
  it('NOT_FOUND → logger.error stage=confidence_promotion error=item_not_found', async () => {
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'NOT_FOUND',
    });

    const res = await runPatch();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Confidence promotion failed — accounting correction stands'),
      expect.objectContaining({
        stage: 'confidence_promotion',
        error: 'item_not_found',
        companyId: COMPANY,
        entityId: ENTITY,
        transactionId: TX_ID,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Confidence promotion failed'),
      expect.anything(),
    );
  });

  // T4+T5+T6+T7+T8: NOT_FOUND → accounting PATCH succeeds, response contract
  // unchanged (200 + corrected transaction), no throw, no retry
  // (evolve called exactly once).
  it('NOT_FOUND → HTTP 200, accounting committed, no throw, no retry', async () => {
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'NOT_FOUND',
    });

    const res = await runPatch();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction.glaccountId ?? body.transaction.glAccountId).toBe('gl-b');
    // T5: accounting mutation really persisted through the mock db pipeline
    expect(db.bankTransaction.update).toHaveBeenCalled();
    // T7: exactly one promotion attempt — no retry
    expect(evolveClassificationConfidence).toHaveBeenCalledTimes(1);
    // No fabricated HTTP error / contract change
    expect(body.error).toBeUndefined();
  });

  // T9+T10: NOT_FOUND → NO ConfidenceLog and NO confidence-related
  // TraceabilityLog row (no fabricated C11 evidence for a mutation that
  // never happened). Observation evidence traceability rows from the
  // separate observation stage are legitimate and expected.
  it('NOT_FOUND → no ConfidenceLog, no confidence_changed TraceabilityLog', async () => {
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'NOT_FOUND',
    });

    await runPatch();

    expect(db.confidenceLog.create).not.toHaveBeenCalled();
    expect(db.confidenceLogs).toHaveLength(0);
    const confidenceChanged = db.traceabilityLogs.filter(
      (row) => (row.action as string | undefined) === 'confidence_changed',
    );
    expect(confidenceChanged).toHaveLength(0);
  });

  // T11: NOT_FOUND → confidence not mutated (nothing to mutate; the item
  // cannot be found — no update call happened for any knowledge item).
  it('NOT_FOUND → no knowledge item mutation', async () => {
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'NOT_FOUND',
    });

    await runPatch();

    // The mock db update is only hit by the bankTransaction accounting path;
    // no memoryItem mutation occurred.
    expect(db.memoryItem.update).not.toHaveBeenCalled();
  });

  // T12: UNCHANGED remains a legitimate silent no-op (no error log).
  it('UNCHANGED → silent no-op, no error-level log', async () => {
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'UNCHANGED',
      itemId: 'mem-1',
      confidence: 'tentative',
    });

    const res = await runPatch();

    expect(res.status).toBe(200);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Confidence promotion failed'),
      expect.anything(),
    );
    expect(db.confidenceLog.create).not.toHaveBeenCalled();
  });

  // T13: existing ERROR behavior unchanged — still warn (not error).
  it('ERROR → still logger.warn, not logger.error', async () => {
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'ERROR',
      error: 'PROMOTION_DOWN_FORCED',
    });

    const res = await runPatch();

    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Confidence promotion failed — accounting correction stands'),
      expect.objectContaining({
        stage: 'confidence_promotion',
        error: 'PROMOTION_DOWN_FORCED',
        companyId: COMPANY,
        entityId: ENTITY,
        transactionId: TX_ID,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  // T14: KE-EVOL-005 pending-conflict gate unchanged — when the learned item
  // is implicated by a pending conflict, promotion is skipped entirely
  // (evolve never called; gate log preserved).
  it('pending conflict implicated → promotion skipped, evolve NOT called', async () => {
    await seedPendingConflictImplication();

    const res = await runPatch();

    expect(res.status).toBe(200);
    expect(evolveClassificationConfidence).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Promotion skipped — exact treatment implicated by pending conflict'),
      expect.objectContaining({
        stage: 'confidence_promotion',
        companyId: COMPANY,
        entityId: ENTITY,
        transactionId: TX_ID,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  // T15-adjacent: foreign files untouched is verified by git reconciliation,
  // not by a test. This test proves the real (non-mocked gate) path still
  // reaches evolve when NOT implicated — i.e., the gate wiring is intact
  // end-to-end with the REAL isKnowledgeImplicatedByPendingConflict.
  it('real gate not implicated → evolve called exactly once with promotion args', async () => {
    await runPatch();

    expect(evolveClassificationConfidence).toHaveBeenCalledTimes(1);
    const call = (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toBe('certain');
    expect(call[4]).toBe('human_confirmation');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

/**
 * Seed a persisted pending conflict implicating the exact treatment, using
 * the REAL KE pipeline (observation + authorization + detection) so the
 * KE-EVOL-005 gate genuinely fires through production logic.
 */
async function seedPendingConflictImplication(): Promise<void> {
  const {
    createAdapter,
    recordClassificationObservation,
    discoverStructuralCandidateForGroup,
    recordStructuralCandidate,
    authorizeStructuralCandidate,
    detectConflictingPattern,
  } = await import('@/memory/classification-knowledge');
  const adapter = createAdapter(db as unknown as MemoryPrismaClient, async (fn) => db.$transaction(fn as never));

  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, COMPANY, {
      entityId: ENTITY,
      originalDescription: `ABC ${i * 111} ${ENTITY}`,
      glAccountId: 'gl-a',
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-seed-${i}`,
    });
    if (!obs.ok) throw new Error('seed observation failed');
  }

  const groupKey = { companyId: COMPANY, entityId: ENTITY, glAccountId: 'gl-a', direction: 'any' };
  const disc = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (disc.kind !== 'candidate') throw new Error(`seed discovery failed: ${disc.reason}`);
  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  if (!rec.ok) throw new Error('seed candidate failed');
  const auth = await authorizeStructuralCandidate(adapter, COMPANY, rec.candidateId, 'admin');
  if (auth.status !== 'AUTHORIZED' && auth.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`seed authorize failed: ${auth.status}`);
  }

  // Real detection persists an AUTHORIZED_VS_EXACT conflict implicating the
  // exact treatment (learned gl-b vs authorized gl-a).
  const learn = await learnEntityTreatment(adapter, COMPANY, ENTITY, 'gl-b', 'any', 'user_correction', 'tx-seed-3');
  if (learn.status === 'ERROR') throw new Error(`seed learn failed: ${learn.reason}`);
  const exactItemId = learn.itemId;
  const det = await detectConflictingPattern(adapter, COMPANY, ENTITY, 'any');
  if (det.status !== 'RECORDED' && det.status !== 'ALREADY_RECORDED') {
    throw new Error(`seed detection failed: ${det.status}`);
  }

  // The gate must genuinely implicate the learned exact treatment now.
  const { isKnowledgeImplicatedByPendingConflict } = await import('@/memory/classification-knowledge');
  const implicated = await isKnowledgeImplicatedByPendingConflict(adapter, COMPANY, exactItemId);
  if (!implicated.implicated) {
    throw new Error('seed failed: pending conflict does not implicate the learned exact treatment');
  }
}
