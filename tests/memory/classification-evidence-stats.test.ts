// Knowledge Engine — Cumulative Evidence Stats Tests (ROADMAP GAP3-2)
// Tests for getClassificationEvidenceStats: canonical, deterministic,
// tenant-scoped statistics derived from persisted observations.
// READ-ONLY: stats never write state; accumulation is the observation
// collection itself (no duplicated counters).

import { describe, it, expect, vi } from 'vitest';
import {
  recordClassificationObservation,
  getClassificationEvidenceStats,
} from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client (harness pattern from classification-observation.test.ts) ─

function createMockPrisma() {
  const store = new Map<string, { id: string; content: string; type: string; status: string; confidence: string; companyId: string; sourceAuthor: string; sourceName: string }>();
  let nextId = 1;

  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    memoryItem: {
      create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; sourceAuthor: string; sourceName: string; [key: string]: unknown } }) => {
        const id = `mem_${nextId++}`;
        const item = {
          id,
          content: args.data.content,
          type: args.data.type,
          status: 'active',
          confidence: 'tentative',
          companyId: args.data.companyId,
          sourceAuthor: args.data.sourceAuthor,
          sourceName: args.data.sourceName,
        };
        store.set(id, item);
        return item;
      }),
      findFirst: vi.fn(async (args?: { where?: { id?: string; companyId?: string; content?: string; status?: string } }) => {
        for (const item of store.values()) {
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
        let results = Array.from(store.values());
        if (args?.where?.companyId) {
          results = results.filter((item) => item.companyId === args.where!.companyId);
        }
        if (args?.where?.type) {
          results = results.filter((item) => item.type === args.where!.type);
        }
        return results;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const item = store.get(args.where.id);
        if (item) {
          Object.assign(item, args.data);
          return item;
        }
        throw new Error('Not found');
      }),
    },
    memoryVersion: {
      create: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    relationship: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    contradiction: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    traceabilityLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    confidenceLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    _store: store,
  };
}

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);
  return { adapter, prisma: mockPrisma, store: mockPrisma._store };
}

async function record(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
  direction: 'debit' | 'credit' | 'any',
  transactionId: string
) {
  const result = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `OBS ${transactionId} FOR ${entityId}`,
    glAccountId,
    direction,
    source: 'user_correction',
    transactionId,
  });
  expect(result.ok).toBe(true);
  return result;
}

const stats = getClassificationEvidenceStats;

// ─── Tests ──────────────────────────────────────────────────────

describe('Classification Evidence Stats (GAP3-2)', () => {
  // T1: 0 observations → 0 / 0 / 0 / 0
  it('T1: zero observations returns all-zero stats', async () => {
    const { adapter } = createMockAdapter();

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');

    expect(result).toEqual({
      totalObservations: 0,
      matchingTreatmentObservations: 0,
      conflictingTreatmentObservations: 0,
      supportRatio: 0,
    });
  });

  // T2: first compatible observation → 1 / 1 / 0 / 1
  it('T2: first compatible observation yields 1/1/0/1', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');

    expect(result.totalObservations).toBe(1);
    expect(result.matchingTreatmentObservations).toBe(1);
    expect(result.conflictingTreatmentObservations).toBe(0);
    expect(result.supportRatio).toBe(1);
  });

  // T3: second and third compatible observations → evolves 1 → 2 → 3,
  // accumulating without replacing previous observations.
  it('T3: compatible observations accumulate 1 → 2 → 3', async () => {
    const { adapter, store } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    let result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(1);
    expect(result.matchingTreatmentObservations).toBe(1);
    expect(result.supportRatio).toBe(1);

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_2');
    result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(2);
    expect(result.matchingTreatmentObservations).toBe(2);
    expect(result.supportRatio).toBe(1);

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_3');
    result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(3);
    expect(result.matchingTreatmentObservations).toBe(3);
    expect(result.conflictingTreatmentObservations).toBe(0);
    expect(result.supportRatio).toBe(1);

    // Previous observations were not replaced: 3 stored observation rows.
    const observationRows = Array.from(store.values()).filter(
      (item) => item.type === 'classification_observation' && item.companyId === 'comp_1'
    );
    expect(observationRows.length).toBe(3);
  });

  // T4: contradictory observation → total grows, matching unchanged,
  // conflicting grows, supportRatio decreases.
  it('T4: contradictory observation 2+1 → 3/2/1/0.666... and 1+2 → 3/1/2/0.333...', async () => {
    const { adapter } = createMockAdapter();

    // 2 compatible + 1 different → 3 / 2 / 1 / 2÷3
    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_2');
    let result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(2);
    expect(result.matchingTreatmentObservations).toBe(2);
    expect(result.supportRatio).toBe(1);

    await record(adapter, 'comp_1', 'entity_1', 'gl_5002', 'any', 'tx_3');
    result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(3); // total grew
    expect(result.matchingTreatmentObservations).toBe(2); // matching unchanged
    expect(result.conflictingTreatmentObservations).toBe(1); // conflicting grew
    expect(result.supportRatio).toBe(2 / 3); // ratio decreased, not rounded
  });

  it('T4b: one compatible + two different → 3/1/2/0.333...', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    await record(adapter, 'comp_1', 'entity_1', 'gl_5002', 'any', 'tx_2');
    await record(adapter, 'comp_1', 'entity_1', 'gl_5003', 'any', 'tx_3');

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(3);
    expect(result.matchingTreatmentObservations).toBe(1);
    expect(result.conflictingTreatmentObservations).toBe(2);
    expect(result.supportRatio).toBe(1 / 3);
  });

  // T5: another glAccountId → conflict
  it('T5: another glAccountId counts as conflict', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    await record(adapter, 'comp_1', 'entity_1', 'gl_5009', 'any', 'tx_2');

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(2);
    expect(result.matchingTreatmentObservations).toBe(1);
    expect(result.conflictingTreatmentObservations).toBe(1);
    expect(result.supportRatio).toBe(0.5);
  });

  // T6: another direction → conflict (exact match required)
  it('T6: another direction counts as conflict', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'debit', 'tx_1');

    const asDebit = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'debit');
    expect(asDebit.totalObservations).toBe(1);
    expect(asDebit.matchingTreatmentObservations).toBe(1);
    expect(asDebit.conflictingTreatmentObservations).toBe(0);
    expect(asDebit.supportRatio).toBe(1);

    const asCredit = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'credit');
    expect(asCredit.totalObservations).toBe(1);
    expect(asCredit.matchingTreatmentObservations).toBe(0);
    expect(asCredit.conflictingTreatmentObservations).toBe(1);
    expect(asCredit.supportRatio).toBe(0);

    const asAny = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(asAny.matchingTreatmentObservations).toBe(0);
    expect(asAny.conflictingTreatmentObservations).toBe(1);
  });

  // T7: another entityId does not participate
  it('T7: observations of another entityId do not participate', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    await record(adapter, 'comp_1', 'entity_2', 'gl_5002', 'debit', 'tx_2');

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(1);
    expect(result.matchingTreatmentObservations).toBe(1);
    expect(result.conflictingTreatmentObservations).toBe(0);
    expect(result.supportRatio).toBe(1);
  });

  // T8: another companyId does not participate
  it('T8: observations of another companyId do not participate', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    await record(adapter, 'comp_2', 'entity_1', 'gl_5001', 'any', 'tx_2');

    const comp1 = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(comp1.totalObservations).toBe(1);
    expect(comp1.matchingTreatmentObservations).toBe(1);

    const comp2 = await stats(adapter, 'comp_2', 'entity_1', 'gl_5001', 'any');
    expect(comp2.totalObservations).toBe(1);
    expect(comp2.matchingTreatmentObservations).toBe(1);
  });

  // T9: same transactionId recorded twice does not duplicate evidence
  it('T9: repeated transactionId does not duplicate evidence', async () => {
    const { adapter, store } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_dup');
    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_dup');

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(result.totalObservations).toBe(1);
    expect(result.matchingTreatmentObservations).toBe(1);

    const observationRows = Array.from(store.values()).filter(
      (item) => item.type === 'classification_observation'
    );
    expect(observationRows.length).toBe(1);
  });

  // T10: the stats function writes no MemoryItem (read-only proof via
  // BEFORE vs AFTER call counts — record() ran before stats and may have
  // legitimately written memoryVersion/confidenceLog/traceabilityLog, so
  // global "never called" assertions would be wrong).
  it('T10: stats is read-only — no additional MemoryItem is written', async () => {
    const { adapter, prisma, store } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');

    const memoryItemCallsBefore = prisma.memoryItem.create.mock.calls.length;
    const memoryVersionCallsBefore = prisma.memoryVersion.create.mock.calls.length;
    const confidenceLogCallsBefore = prisma.confidenceLog.create.mock.calls.length;
    const traceabilityCallsBefore = prisma.traceabilityLog.create.mock.calls.length;
    const storeSizeBefore = store.size;

    const result = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');

    expect(result.totalObservations).toBe(1);
    expect(prisma.memoryItem.create.mock.calls.length).toBe(memoryItemCallsBefore);
    expect(prisma.memoryVersion.create.mock.calls.length).toBe(memoryVersionCallsBefore);
    expect(prisma.confidenceLog.create.mock.calls.length).toBe(confidenceLogCallsBefore);
    expect(prisma.traceabilityLog.create.mock.calls.length).toBe(traceabilityCallsBefore);
    expect(store.size).toBe(storeSizeBefore);
  });

  // T11: separate calls demonstrate cumulative persistence: record → query →
  // record new observation → query again → result N+1
  it('T11: cumulative persistence across separate calls gives result N+1', async () => {
    const { adapter } = createMockAdapter();

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_1');
    const after1 = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(after1.totalObservations).toBe(1);
    expect(after1.matchingTreatmentObservations).toBe(1);
    expect(after1.supportRatio).toBe(1);

    await record(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', 'tx_2');
    const after2 = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(after2.totalObservations).toBe(2);
    expect(after2.matchingTreatmentObservations).toBe(2);
    expect(after2.supportRatio).toBe(1);

    await record(adapter, 'comp_1', 'entity_1', 'gl_5002', 'any', 'tx_3');
    const after3 = await stats(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any');
    expect(after3.totalObservations).toBe(3);
    expect(after3.matchingTreatmentObservations).toBe(2);
    expect(after3.conflictingTreatmentObservations).toBe(1);
    expect(after3.supportRatio).toBe(2 / 3);
  });
});
