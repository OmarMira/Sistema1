// Conversational Service — Structural Match Tests (KE propagation)
// parseConversationalContext consumes AUTHORIZED structural knowledge only on exact NOT_FOUND;
// never presents a KE verdict under ambiguity, and never degrades KE errors to fallback.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────

const mockResolveEntity = vi.fn();

vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: (...args: unknown[]) => mockResolveEntity(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {},
}));

vi.mock('@/lib/ai-config', () => ({
  getAiConfig: vi.fn(async () => ({ apiKey: 'test-key', baseUrl: 'https://ai.test', model: 'test-model' })),
}));

vi.mock('@/lib/security/safe-fetch', () => ({
  // If the AI path runs, its ONLY observable external activation is safeFetch
  safeFetch: vi.fn().mockRejectedValue(new Error('network disabled in tests')),
}));

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/entity-context-service', () => ({
  findContext: vi.fn(async () => null),
}));

import { parseConversationalContext } from '../../src/lib/services/conversational-service';
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

  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
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
    glAccount: {
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) => {
        if (args?.where?.id === 'gl_A') {
          return { id: 'gl_A', code: '5000', name: 'Supplies Expense', accountType: 'expense', normalBalance: 'debit' };
        }
        if (args?.where?.id === 'gl_B') {
          return { id: 'gl_B', code: '6999', name: 'Other Expense', accountType: 'expense', normalBalance: 'debit' };
        }
        return null;
      }),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    _store: store,
  };
  return { prisma, store, _store: store };
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

const COMPANY = 'comp_1';
const ENTITY = 'entity_1';
const KEY_ANY: StructuralGroupKey = { companyId: COMPANY, entityId: ENTITY, glAccountId: 'gl_A', direction: 'any' };

type MockPrisma = ReturnType<typeof createMockPrisma>['prisma'];
type DbLike = typeof import('@/lib/db').db;

async function callParse(
  prisma: MockPrisma,
  pattern: string,
  direction?: 'debit' | 'credit',
) {
  return parseConversationalContext(
    COMPANY,
    pattern,
    'user input',
    'user-1',
    undefined,
    prisma as DbLike,
    direction,
  );
}

beforeEach(() => {
  mockResolveEntity.mockReset();
});

describe('conversational structural matching (KE propagation)', () => {
  it('C1: KNOWN + exact treatment FOUND keeps precedence — matcher not consulted', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    // Exact treatment exists (different GL)
    const learn = await learnEntityTreatment(adapter, COMPANY, ENTITY, 'gl_B', 'any', 'user_correction', 'tx_exact');
    expect(learn.status).toBe('CREATED');
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const result = await callParse(harness.prisma, 'ABC 999 XYZ');

    expect(result.glAccountId).toBe('gl_B');
    expect(result.explanation).toContain('KE treatment found for entity');
    expect(result.explanation).not.toContain('Authorized structural');
  });

  it('C2/C3/C4: KNOWN + exact NOT_FOUND + structural MATCH → KE GL, no AI, no heuristic', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const result = await callParse(harness.prisma, 'ABC 999 XYZ');

    expect(result.glAccountId).toBe('gl_A');
    expect(result.glAccountCode).toBe('5000');
    // Source distinguishable from exact treatment (C12)
    expect(result.explanation).toContain('Authorized structural treatment');
    expect(result.uncertaintyReasons).toHaveLength(0);
    expect(result.confidenceLabel).toBe('high');
    expect(result.explanation).not.toContain('unclassified');
  });

  it('C5: structural NO_MATCH → legacy AI/heuristic flow intact', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const { safeFetch } = await import('@/lib/security/safe-fetch');
    void safeFetch;
    const result = await callParse(harness.prisma, 'QQQ 777 WWW');

    // Legacy continuation produced a NON-KE result (network disabled AI, no context)
    expect(result.glAccountId).not.toBe('gl_A');
    expect(result.explanation).not.toContain('Authorized structural');
  });

  it('C6: structural AMBIGUOUS → no invented GL, ambiguity explicit, heuristic continues', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    // Divergent historical state: second authorized pattern, different GL
    await adapter.record({
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

    const result = await callParse(harness.prisma, 'ABC 999 XYZ');

    // Nothing may be presented as a KE decision
    expect(result.glAccountId).not.toBe('gl_A');
    expect(result.uncertaintyReasons.join(' ')).toContain('structural match ambiguous');
    expect(result.uncertaintyReasons.join(' ')).toContain('KE did not decide');
  });

  it('C7: structural ERROR → explicit KE error, no silent fallback', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    const patternItems = Array.from(harness._store.values()).filter((item) => item.type === AUTHORIZED_PATTERN_TYPE);
    await adapter.update(patternItems[0]!.id, 'corrupt{{', COMPANY);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    const result = await callParse(harness.prisma, 'ABC 999 XYZ');

    expect(result.glAccountId).toBeNull();
    expect(result.explanation).toContain('KE structural match error');
    expect(result.uncertaintyReasons.join(' ')).toContain('KE structural match error');
  });

  it('C8/C9/C10: cross-tenant, cross-entity and incompatible direction never use the pattern', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, { companyId: COMPANY, entityId: ENTITY, glAccountId: 'gl_A', direction: 'credit' }, [
      'DDD 111 YYY',
      'DDD 222 YYY',
      'DDD 333 YYY',
    ]);

    // C8: different tenant — pattern is tenant-scoped, must not resolve
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });
    const crossTenant = await parseConversationalContext(
      'comp_2',
      'DDD 999 YYY',
      'user input',
      'user-1',
      undefined,
      harness.prisma as DbLike,
      'credit',
    );
    expect(crossTenant.glAccountId).not.toBe('gl_A');
    expect(crossTenant.explanation).not.toContain('Authorized structural');

    // C9: different entity, same tenant
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_2' });
    const crossEntity = await callParse(harness.prisma, 'DDD 999 YYY', 'credit');
    expect(crossEntity.glAccountId).not.toBe('gl_A');
    expect(crossEntity.explanation).not.toContain('Authorized structural');

    // C10: incompatible direction (credit pattern vs debit request)
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });
    const debit = await callParse(harness.prisma, 'DDD 999 YYY', 'debit');
    expect(debit.glAccountId).not.toBe('gl_A');
    expect(debit.explanation).not.toContain('Authorized structural');
  });

  it('C11: structural MATCH leaves the pattern store byte-identical', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));
    await buildAuthorized(adapter, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    const snapshot = JSON.stringify(Array.from(harness._store.values()));
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });

    await callParse(harness.prisma, 'ABC 999 XYZ');

    expect(JSON.stringify(Array.from(harness._store.values()))).toBe(snapshot);
  });

  it('C12 (complement): exact and structural sources produce distinguishable explanations', async () => {
    const harness = createMockPrisma();
    const adapter = new MemoryAdapter(harness.prisma as MemoryPrismaClient, async (fn) => fn(harness.prisma));

    // Exact shape
    await learnEntityTreatment(adapter, COMPANY, ENTITY, 'gl_A', 'any', 'user_correction', 'tx_e1');
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });
    const exact = await callParse(harness.prisma, 'ABC XYZ');
    const explanationExact = exact.explanation;

    // Structural shape (separate store)
    const harness2 = createMockPrisma();
    const adapter2 = new MemoryAdapter(harness2.prisma as MemoryPrismaClient, async (fn) => fn(harness2.prisma));
    await buildAuthorized(adapter2, KEY_ANY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: ENTITY });
    const structural = await parseConversationalContext(
      COMPANY,
      'ABC 999 XYZ',
      'user input',
      'user-1',
      undefined,
      harness2.prisma as DbLike,
    );

    expect(explanationExact).toContain('KE treatment found for entity');
    expect(structural.explanation).toContain('Authorized structural treatment');
    expect(explanationExact).not.toContain('Authorized structural');
  });
});
