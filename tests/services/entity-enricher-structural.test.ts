// Entity Enricher — Structural Suggestion Tests (KE propagation)
// suggestGlAccount consumes AUTHORIZED structural knowledge only on exact NOT_FOUND.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveEntity = vi.fn();

vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: (...args: unknown[]) => mockResolveEntity(...args),
}));

import { suggestGlAccount } from '../../src/lib/services/entity-enricher';
import {
  recordClassificationObservation,
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
  learnEntityTreatment,
  AUTHORIZED_PATTERN_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

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

function createMockPrisma() {
  const store = new Map<string, StoredItem>();
  let nextId = 1;

  return {
    memoryItem: {
      create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; sourceAuthor: string; sourceName: string; confidence?: string; [key: string]: unknown } }) => {
        const id = `mem_${nextId++}`;
        const item: StoredItem = {
          id,
          content: args.data.content,
          type: args.data.type,
          status: 'active',
          confidence: args.data.confidence ?? 'tentative',
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
    memoryVersion: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    relationship: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    contradiction: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    traceabilityLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    _store: store,
  };
}

type ClientCtor = Parameters<typeof suggestGlAccount>[5];

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);
  return { adapter, prisma: mockPrisma, store: mockPrisma._store };
}

async function buildAuthorized(
  adapter: MemoryAdapter,
  key: StructuralGroupKey,
  descriptions: string[],
): Promise<string> {
  let i = 1;
  for (const description of descriptions) {
    const obs = await recordClassificationObservation(adapter, key.companyId, {
      entityId: key.entityId,
      originalDescription: description,
      glAccountId: key.glAccountId,
      direction: key.direction,
      source: 'user_correction',
      transactionId: `tx_${key.companyId}_${key.entityId}_${i++}`,
    });
    if (!obs.ok) throw new Error(`seed failed: ${obs.error}`);
  }
  const disc = await discoverStructuralCandidateForGroup(adapter, key);
  if (disc.kind !== 'candidate') throw new Error(`expected candidate: ${disc.reason}`);
  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  if (!rec.ok) throw new Error(`record failed: ${rec.error}`);
  const auth = await authorizeStructuralCandidate(adapter, key.companyId, rec.candidateId, 'user-42');
  if (auth.status !== 'AUTHORIZED') throw new Error(`auth failed: ${auth.status}`);
  return auth.authorizedPatternId;
}

const GL_ACCOUNTS = [
  { id: 'gl_A', name: 'Supplies Expense', code: '5000', accountType: 'expense' },
  { id: 'gl_B', name: 'Other Expense', code: '6999', accountType: 'expense' },
];

const COMPANY = 'comp_1';
const ENTITY = 'entity_1';
const KEY_ANY: StructuralGroupKey = { companyId: COMPANY, entityId: ENTITY, glAccountId: 'gl_A', direction: 'any' };

beforeEach(() => {
  mockResolveEntity.mockReset();
});

describe('entity-enricher structural suggestions (KE propagation)', () => {
  it('E1: exact treatment found keeps precedence over structural matching', async () => {
    const harness = createMockAdapter();
    await buildAuthorized(harness.adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    // Exact knowledge exists: a DIFFERENT GL for the same entity
    const learn = await learnEntityTreatment(harness.adapter, COMPANY, ENTITY, 'gl_B', 'any', 'user_correction', 'tx_exact');
    expect(learn.status).toBe('CREATED');
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const suggestion = await suggestGlAccount(COMPANY, 'ABC 999 XYZ', null, null, GL_ACCOUNTS, harness.prisma as ClientCtor);
    expect(suggestion).toEqual({ name: 'Other Expense', code: '6999', id: 'gl_B' });
  });

  it('E2: exact NOT_FOUND + structural MATCH → suggestedAccountId = authorized GL', async () => {
    const harness = createMockAdapter();
    await buildAuthorized(harness.adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const suggestion = await suggestGlAccount(COMPANY, 'ABC 999 XYZ', null, null, GL_ACCOUNTS, harness.prisma as ClientCtor);
    expect(suggestion).toEqual({ name: 'Supplies Expense', code: '5000', id: 'gl_A' });
  });

  it('E3: structural NO_MATCH → null', async () => {
    const harness = createMockAdapter();
    await buildAuthorized(harness.adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const suggestion = await suggestGlAccount(COMPANY, 'QQQ 777 WWW', null, null, GL_ACCOUNTS, harness.prisma as ClientCtor);
    expect(suggestion).toBeNull();
  });

  it('E4: structural AMBIGUOUS → null (no invented suggestion)', async () => {
    const harness = createMockAdapter();
    await buildAuthorized(harness.adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    // Divergent historical state: second authorized pattern, different GL, same entity+direction
    await harness.adapter.record({
      content: JSON.stringify({
        companyId: COMPANY,
        entityId: ENTITY,
        glAccountId: 'gl_B',
        direction: 'any',
        segments: [
          { kind: 'stable', value: 'abc' },
          { kind: 'variable', evidence: [] },
          { kind: 'stable', value: 'xyz' },
        ],
        sourceCandidateId: 'legacy-candidate',
        observationIds: ['o1', 'o2'],
        authorizedBy: 'legacy-user',
        authorizedAt: new Date().toISOString(),
      }),
      type: AUTHORIZED_PATTERN_TYPE,
      companyId: COMPANY,
      sourceAuthor: 'legacy-user',
      sourceName: 'pattern_authorization',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const suggestion = await suggestGlAccount(COMPANY, 'ABC 999 XYZ', null, null, GL_ACCOUNTS, harness.prisma as ClientCtor);
    expect(suggestion).toBeNull();
  });

  it('E5: structural ERROR → throw (never silent null)', async () => {
    const harness = createMockAdapter();
    // Authorized pattern for this entity, then corrupt it
    await buildAuthorized(harness.adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    const patternItems = Array.from(harness.store.values()).filter((item) => item.type === AUTHORIZED_PATTERN_TYPE);
    expect(patternItems).toHaveLength(1);
    await harness.adapter.update(patternItems[0]!.id, 'corrupt{{', COMPANY);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    await expect(
      suggestGlAccount(COMPANY, 'ABC 999 XYZ', null, null, GL_ACCOUNTS, harness.prisma as ClientCtor),
    ).rejects.toThrow(/KE structural match error/i);
  });

  it('E6/E7/E8: cross-tenant, cross-entity and incompatible direction ignore the pattern', async () => {
    const harness = createMockAdapter();
    await buildAuthorized(harness.adapter, { companyId: COMPANY, entityId: ENTITY, glAccountId: 'gl_A', direction: 'credit' }, [
      'DDD 111 YYY',
      'DDD 222 YYY',
      'DDD 333 YYY',
    ]);

    // E6: different tenant
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });
    await expect(suggestGlAccount('comp_2', 'DDD 999 YYY', null, 'credit', GL_ACCOUNTS, harness.prisma as ClientCtor)).resolves.toBeNull();

    // E7: different entity, same tenant
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_2' });
    await expect(suggestGlAccount(COMPANY, 'DDD 999 YYY', null, 'credit', GL_ACCOUNTS, harness.prisma as ClientCtor)).resolves.toBeNull();

    // E8: incompatible direction (credit pattern vs debit request)
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });
    await expect(suggestGlAccount(COMPANY, 'DDD 999 YYY', null, 'debit', GL_ACCOUNTS, harness.prisma as ClientCtor)).resolves.toBeNull();
  });

  it('E9/E10: structural MATCH creates and mutates nothing; no BankRule surface exists', async () => {
    const harness = createMockAdapter();
    await buildAuthorized(harness.adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    const snapshot = JSON.stringify(Array.from(harness.store.values()));
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const suggestion = await suggestGlAccount(COMPANY, 'ABC 999 XYZ', null, null, GL_ACCOUNTS, harness.prisma as ClientCtor);
    expect(suggestion).toEqual({ name: 'Supplies Expense', code: '5000', id: 'gl_A' });

    // Store is byte-identical: no knowledge created or mutated
    expect(JSON.stringify(Array.from(harness.store.values()))).toBe(snapshot);
    // suggestGlAccount never touches BankRule (no bankRule accessor in the client contract used)
    expect(harness.prisma.bankRule).toBeUndefined();
  });
});
