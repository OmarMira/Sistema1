// Knowledge Engine — Classification Observation Tests (GENERALIZACIÓN-002)
// Tests for observation storage: accumulating evidence independently of treatment.

import { describe, it, expect, vi } from 'vitest';
import {
  recordClassificationObservation,
  getClassificationObservations,
  OBSERVATION_TYPE,
} from '../../src/memory/classification-knowledge';
import type { ClassificationObservation } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client ─────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────

describe('Classification Observations (GENERALIZACIÓN-002)', () => {
  // T1: First confirmation → 1 treatment, 1 observation
  it('T1: first confirmation creates observation', async () => {
    const { adapter } = createMockAdapter();

    const result = await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observationId).toBeTruthy();
    }

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(1);
    expect(observations[0].originalDescription).toBe('PAGO PROVEEDOR ABC S.A.');
    expect(observations[0].glAccountId).toBe('gl_5001');
  });

  // T2: Second transaction, same entity, same GL → treatment UNCHANGED, observations = 2
  it('T2: second observation with same treatment persists', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A. CONTRATO 123',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A. CONTRATO 456',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_2',
    });

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(2);
    expect(observations[0].glAccountId).toBe('gl_5001');
    expect(observations[1].glAccountId).toBe('gl_5001');
  });

  // T3: Three transactions with identical descriptions → observations = 3 (different txIds)
  it('T3: identical descriptions with different txIds produce 3 observations', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_2',
    });

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_3',
    });

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(3);
  });

  // T4: Different treatments for same entity → both observations preserved
  it('T4: conflicting treatments preserve both observations', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A. TRANSFERENCIA',
      glAccountId: 'gl_6001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_2',
    });

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(2);
    expect(observations[0].glAccountId).toBe('gl_5001');
    expect(observations[1].glAccountId).toBe('gl_6001');
  });

  // T5: Tenant isolation
  it('T5: company A observations != company B observations', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    await recordClassificationObservation(adapter, 'comp_2', {
      entityId: 'entity_2',
      originalDescription: 'PAGO PROVEEDOR XYZ',
      glAccountId: 'gl_7001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_2',
    });

    const obs1 = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    const obs2 = await getClassificationObservations(adapter, 'comp_2', 'entity_2');

    expect(obs1).toHaveLength(1);
    expect(obs1[0].glAccountId).toBe('gl_5001');
    expect(obs2).toHaveLength(1);
    expect(obs2[0].glAccountId).toBe('gl_7001');
  });

  // T6: Entity isolation within same company
  it('T6: different entities in same company have separate observations', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_2',
      originalDescription: 'COBRO CLIENTE XYZ',
      glAccountId: 'gl_4001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_2',
    });

    const obs1 = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    const obs2 = await getClassificationObservations(adapter, 'comp_1', 'entity_2');

    expect(obs1).toHaveLength(1);
    expect(obs1[0].glAccountId).toBe('gl_5001');
    expect(obs2).toHaveLength(1);
    expect(obs2[0].glAccountId).toBe('gl_4001');
  });

  // T7: Original description is preserved, not normalized
  it('T7: original description preserved without normalization', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: '  Pago   Proveedor   ABC  S.A.  ',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(1);
    expect(observations[0].originalDescription).toBe('  Pago   Proveedor   ABC  S.A.  ');
  });

  // T8: No tokenization/generalization
  it('T8: no tokenization or pattern extraction occurs', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(1);
    // Verify the stored content is the original description, not a tokenized version
    expect(observations[0].originalDescription).toBe('PAGO PROVEEDOR ABC S.A.');
    expect(observations[0].originalDescription).not.toContain('*');
    expect(observations[0].originalDescription).not.toContain('_');
    expect(observations[0].originalDescription).not.toContain('VARIABLE');
  });

  // T12: Evidence persists through real infrastructure
  it('T12: observations persist and are retrievable through MemoryAdapter', async () => {
    const { adapter, store } = createMockAdapter();

    const result = await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify it's in the store (real infrastructure)
    const storedItem = store.get(result.observationId);
    expect(storedItem).toBeTruthy();
    expect(storedItem!.type).toBe(OBSERVATION_TYPE);
    expect(storedItem!.companyId).toBe('comp_1');

    // Verify it can be retrieved
    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(1);
    expect(observations[0].entityId).toBe('entity_1');
  });

  // Idempotency: same transactionId returns existing
  it('idempotency: same transactionId returns existing observation', async () => {
    const { adapter } = createMockAdapter();

    const result1 = await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    const result2 = await recordClassificationObservation(adapter, 'comp_1', {
      entityId: 'entity_1',
      originalDescription: 'PAGO PROVEEDOR ABC S.A.',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx_1',
    });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.observationId).toBe(result2.observationId);
    }

    const observations = await getClassificationObservations(adapter, 'comp_1', 'entity_1');
    expect(observations).toHaveLength(1);
  });

  // Empty companyId returns error
  it('returns error for empty companyId', async () => {
    const { adapter } = createMockAdapter();

    const result = await recordClassificationObservation(adapter, '', {
      entityId: 'entity_1',
      originalDescription: 'TEST',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
    });

    expect(result.ok).toBe(false);
  });

  // Empty entityId returns error
  it('returns error for empty entityId', async () => {
    const { adapter } = createMockAdapter();

    const result = await recordClassificationObservation(adapter, 'comp_1', {
      entityId: '',
      originalDescription: 'TEST',
      glAccountId: 'gl_5001',
      direction: 'any',
      source: 'user_correction',
    });

    expect(result.ok).toBe(false);
  });

  // getClassificationObservations returns empty for unknown entity
  it('returns empty for unknown entity', async () => {
    const { adapter } = createMockAdapter();

    const observations = await getClassificationObservations(adapter, 'comp_1', 'nonexistent');
    expect(observations).toHaveLength(0);
  });
});
