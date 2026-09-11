// KE-EVOL-001 — PATCH /api/transactions/[id] Integration Tests (T13–T15)
// T13: accounting failure → NO observation, NO conflict detection, request fails
// T14: accounting success + divergence → observation recorded BEFORE detection,
//      conflict detection RECORDED and REALLY persisted, accounting response 200
// T15: accounting success + detection ERROR → logger.warn stage=conflict_detection,
//      accounting response still 200, ERROR never converted into NO_CONFLICT

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
  let nextId = 1;
  let blockBankTransactionUpdate = false;

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
    update: vi.fn(async (args: { where: { id: string }; data: { glAccountId: string } }) => {
      if (blockBankTransactionUpdate) {
        throw new Error('ACCOUNTING_FAILURE_FORCED');
      }
      return {
        id: args.where.id,
        date: new Date('2025-06-15'),
        amount: 500,
        description: 'ABC 777 ENTITY-1',
        glAccountId: args.data.glAccountId,
        journalEntryId: null,
      };
    }),
  };

  const glAccount = {
    // Endpoint's GL account belongs to the company and is active
    findFirst: vi.fn(async () => ({ id: 'gl-b', companyId: 'company-a', isActive: true })),
  };

  const self = {
    memoryItem,
    memoryVersion: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    relationship: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    contradiction: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    traceabilityLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    bankTransaction,
    glAccount,
    $transaction: async <T>(fn: (tx: typeof self) => Promise<T>): Promise<T> => fn(self),
    setBlockBankTransactionUpdate: (value: boolean) => {
      blockBankTransactionUpdate = value;
    },
    reset: () => {
      memStore.clear();
      nextId = 1;
      blockBankTransactionUpdate = false;
    },
    store: memStore,
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

// Partial KE mock: REAL operations behind spies so call order and real
// persistence are both demonstrable without touching production code.
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
  recordClassificationObservation,
  detectConflictingPattern,
  getPendingConflicts,
  evolveClassificationConfidence,
  degradeKnowledgeOnConflict,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
  discoverStructuralCandidateForGroup,
} from '@/memory/classification-knowledge';
import type { StructuralGroupKey } from '@/memory/classification-knowledge';
import { resolveEntity } from '@/memory/entity-resolution';

const COMPANY = 'company-a';
const ENTITY = 'entity-1';
const TX_ID = 'tx-1';

function makeAdapter() {
  const runTx: TransactionRunner = async (fn) => db.$transaction(fn as never);
  return createAdapter(db as unknown as MemoryPrismaClient, runTx);
}

/**
 * Seed an authorized structural pattern whose shape is
 * [stable 'abc', variable, stable 'entity-1'] → GL-A
 * using the REAL observation/discovery/authorization pipeline
 * against the mocked db, so every id is real.
 */
async function seedAuthorizedPattern(): Promise<void> {
  const adapter = makeAdapter();

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

  const groupKey: StructuralGroupKey = { companyId: COMPANY, entityId: ENTITY, glAccountId: 'gl-a', direction: 'any' };
  const disc = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (disc.kind !== 'candidate') throw new Error(`seed discovery failed: ${disc.reason}`);
  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  if (!rec.ok) throw new Error('seed candidate failed');
  const auth = await authorizeStructuralCandidate(adapter, COMPANY, rec.candidateId, 'admin');
  if (auth.status !== 'AUTHORIZED' && auth.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`seed authorize failed: ${auth.status}`);
  }
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

describe('KE-EVOL-001 — PATCH /api/transactions/[id] conflict integration', () => {
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
    // Entity resolution resolves the route have available to KNOWN entity
    vi.mocked(resolveEntity).mockResolvedValue({
      status: 'KNOWN',
      entityId: ENTITY,
    } as never);
  });

  // T15: accounting correction FAILS at the $transaction level →
  // NO learning, NO promotion, NO observation, NO conflict, NO degradation
  it('T15: accounting failure → no learn, no promote, no observation, no detection, no degradation; request fails', async () => {
    db.setBlockBankTransactionUpdate(true);

    const { PATCH } = await import('@/app/api/transactions/[id]/route');

    await expect(PATCH(makeRequest(), patchContext())).rejects.toThrow('ACCOUNTING_FAILURE_FORCED');

    expect(learnEntityTreatment).not.toHaveBeenCalled();
    expect(evolveClassificationConfidence).not.toHaveBeenCalled();
    expect(recordClassificationObservation).not.toHaveBeenCalled();
    expect(detectConflictingPattern).not.toHaveBeenCalled();
    expect(degradeKnowledgeOnConflict).not.toHaveBeenCalled();

    // Nothing was learned at all
    expect(db.store.size).toBe(0);
  });

  // T16: accounting success + divergence → ORDER learn → promote →
  // observation → detect → degrade; conflict RECORDED, REAL degradation, 200
  it('T16: success → learn → promote → observation → detect → degrade (order) → conflict persisted → 200', async () => {
    await seedAuthorizedPattern();

    // Seeding also ran through the call-through spies —reset counters so the
    // PATCH-specific calls are what we assert on.
    (learnEntityTreatment as ReturnType<typeof vi.fn>).mockClear();
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockClear();
    (recordClassificationObservation as ReturnType<typeof vi.fn>).mockClear();
    (detectConflictingPattern as ReturnType<typeof vi.fn>).mockClear();
    (degradeKnowledgeOnConflict as ReturnType<typeof vi.fn>).mockClear();

    const learnMock = learnEntityTreatment as ReturnType<typeof vi.fn>;
    const promoteMock = evolveClassificationConfidence as ReturnType<typeof vi.fn>;
    const recordMock = recordClassificationObservation as ReturnType<typeof vi.fn>;
    const detectMock = detectConflictingPattern as ReturnType<typeof vi.fn>;
    const degradeMock = degradeKnowledgeOnConflict as ReturnType<typeof vi.fn>;

    const { PATCH } = await import('@/app/api/transactions/[id]/route');

    const res = await PATCH(makeRequest(), patchContext());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction.glaccountId ?? body.transaction.glAccountId).toBe('gl-b');

    // Each stage ran exactly once
    expect(learnMock).toHaveBeenCalledTimes(1);
    expect(promoteMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(degradeMock).toHaveBeenCalledTimes(1);

    // ORDER: learn < promote < observation < detect < degrade
    const order = [
      learnMock.mock.invocationCallOrder[0],
      promoteMock.mock.invocationCallOrder[0],
      recordMock.mock.invocationCallOrder[0],
      detectMock.mock.invocationCallOrder[0],
      degradeMock.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    expect(order[3]).toBeLessThan(order[4]);

    // Promotion arguments: human_confirmation → certain on the learned item
    // (the call-through learn spy returns a Promise, so the linked id is
    // verified against the real store item created by the PATCH)
    expect(promoteMock.mock.calls[0][0]).toBeTruthy(); // adapter
    const learnedItem = Array.from(db.store.values()).find((i) => i.type === 'classification');
    expect(learnedItem).toBeTruthy();
    expect(promoteMock.mock.calls[0][2]).toBe(learnedItem!.id);
    expect(promoteMock.mock.calls[0][3]).toBe('certain');
    expect(promoteMock.mock.calls[0][4]).toBe('human_confirmation');

    // REAL persistence: conflict readable through the read contract
    const conflicts = await getPendingConflicts(makeAdapter(), COMPANY, ENTITY);
    expect(conflicts.status).toBe('FOUND');
    if (conflicts.status !== 'FOUND') return;
    expect(conflicts.conflicts.length).toBe(1);
    expect(conflicts.conflicts[0].content.kind).toBe('OBSERVATION_VS_AUTHORIZED');
    expect(conflicts.conflicts[0].content.conflictingGlAccountId).toBe('gl-b');
  });

  // T17: accounting success + promotion ERROR → secondary, logged, response 200
  it('T17: success + promotion ERROR → logger.warn stage=confidence_promotion; response 200', async () => {
    await seedAuthorizedPattern();

    (learnEntityTreatment as ReturnType<typeof vi.fn>).mockClear();
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockClear();
    (recordClassificationObservation as ReturnType<typeof vi.fn>).mockClear();
    (detectConflictingPattern as ReturnType<typeof vi.fn>).mockClear();
    (degradeKnowledgeOnConflict as ReturnType<typeof vi.fn>).mockClear();

    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'ERROR',
      error: 'PROMOTION_DOWN_FORCED',
    });

    const { PATCH } = await import('@/app/api/transactions/[id]/route');

    const res = await PATCH(makeRequest(), patchContext());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction.glaccountId ?? body.transaction.glAccountId).toBe('gl-b');

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

    // The pipeline continued: observation + conflict detection still ran.
    // Detection was NOT the forced error source: it ran REAL (call-through)
    // and persisted a conflict — readable through the read contract.
    expect(recordClassificationObservation).toHaveBeenCalledTimes(1);
    expect(detectConflictingPattern).toHaveBeenCalledTimes(1);
    const conflicts = await getPendingConflicts(makeAdapter(), COMPANY, ENTITY);
    expect(conflicts.status).toBe('FOUND');
  });

  // T18: accounting success + degradation ERROR → secondary, logged, response 200
  it('T18: success + degradation ERROR → logger.warn stage=confidence_degradation; response 200', async () => {
    await seedAuthorizedPattern();

    (learnEntityTreatment as ReturnType<typeof vi.fn>).mockClear();
    (evolveClassificationConfidence as ReturnType<typeof vi.fn>).mockClear();
    (recordClassificationObservation as ReturnType<typeof vi.fn>).mockClear();
    (detectConflictingPattern as ReturnType<typeof vi.fn>).mockClear();
    (degradeKnowledgeOnConflict as ReturnType<typeof vi.fn>).mockClear();

    (degradeKnowledgeOnConflict as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'ERROR',
      error: 'DEGRADE_DOWN_FORCED',
    });

    const { PATCH } = await import('@/app/api/transactions/[id]/route');

    const res = await PATCH(makeRequest(), patchContext());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction.glaccountId ?? body.transaction.glAccountId).toBe('gl-b');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Confidence degradation failed — accounting correction stands'),
      expect.objectContaining({
        stage: 'confidence_degradation',
        error: 'DEGRADE_DOWN_FORCED',
        companyId: COMPANY,
        entityId: ENTITY,
        transactionId: TX_ID,
      }),
    );

    // The conflict REALLY existed before degradation was attempted:
    // real detection (call-through) persisted it — degradation failed AFTER.
    const conflicts = await getPendingConflicts(makeAdapter(), COMPANY, ENTITY);
    expect(conflicts.status).toBe('FOUND');
    if (conflicts.status !== 'FOUND') return;
    expect(conflicts.conflicts.length).toBe(1);
    expect(conflicts.conflicts[0].content.kind).toBe('OBSERVATION_VS_AUTHORIZED');
  });

  // DET-ERR: detection ERROR keeps prior behavior (EVOL-001 contract intact)
  it('DET-ERR: success + detection ERROR → logger.warn stage=conflict_detection; response 200', async () => {
    await seedAuthorizedPattern();

    (detectConflictingPattern as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'ERROR',
      error: 'ADAPTER_DOWN_FORCED',
    });

    const { PATCH } = await import('@/app/api/transactions/[id]/route');

    const res = await PATCH(makeRequest(), patchContext());

    expect(res.status).toBe(200);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Conflict detection failed — observation stands'),
      expect.objectContaining({
        stage: 'conflict_detection',
        error: 'ADAPTER_DOWN_FORCED',
        companyId: COMPANY,
        entityId: ENTITY,
        transactionId: TX_ID,
      }),
    );

    // No conflict persisted and no degradation was asked for
    const conflicts = await getPendingConflicts(makeAdapter(), COMPANY, ENTITY);
    expect(conflicts.status).toBe('EMPTY');
    expect(degradeKnowledgeOnConflict as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
