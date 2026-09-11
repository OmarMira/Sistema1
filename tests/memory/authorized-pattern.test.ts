// Knowledge Engine — Authorized Pattern Tests (GENERALIZACIÓN-004)
// Explicit human authorization of persisted structural candidates.
// The authorized pattern is persisted authority, NOT consumed authority.

import { describe, it, expect, vi } from 'vitest';
import {
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
  getAuthorizedPatterns,
  getStructuralCandidates,
  recordClassificationObservation,
  getClassificationObservationRecords,
  lookupClassification,
  learnEntityTreatment,
  STRUCTURAL_CANDIDATE_TYPE,
  AUTHORIZED_PATTERN_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey, StructuralCandidateContent } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client ──────────────────────────────────────────

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
      create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; sourceAuthor: string; sourceName: string; [key: string]: unknown } }) => {
        const id = `mem_${nextId++}`;
        const item: StoredItem = {
          id,
          content: args.data.content,
          type: args.data.type,
          status: 'active',
          confidence: (args.data.confidence as string) ?? 'tentative',
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

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);
  return { adapter, prisma: mockPrisma, store: mockPrisma._store };
}

// ─── Helpers ─────────────────────────────────────────────────────

async function seedObservations(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
  direction: 'debit' | 'credit' | 'any',
  descriptions: string[],
): Promise<void> {
  let i = 1;
  for (const originalDescription of descriptions) {
    const result = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription,
      glAccountId,
      direction,
      source: 'user_correction',
      transactionId: `tx_${companyId}_${glAccountId}_${direction}_${i++}`,
    });
    if (!result.ok) throw new Error(`seed observation failed: ${result.error}`);
  }
}

/** Full chain: observations → discovered candidate → persisted candidate. */
async function buildPersistedCandidate(
  adapter: MemoryAdapter,
  key: StructuralGroupKey,
  descriptions: string[],
): Promise<{ candidateId: string; candidate: StructuralCandidateContent }> {
  await seedObservations(adapter, key.companyId, key.entityId, key.glAccountId, key.direction, descriptions);
  const disc = await discoverStructuralCandidateForGroup(adapter, key);
  if (disc.kind !== 'candidate') throw new Error(`expected candidate, got: ${disc.reason}`);
  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  if (!rec.ok) throw new Error(`candidate recording failed: ${rec.error}`);
  return { candidateId: rec.candidateId, candidate: disc.candidate };
}

const KEY: StructuralGroupKey = {
  companyId: 'comp_1',
  entityId: 'entity_1',
  glAccountId: 'gl_5001',
  direction: 'any',
};

const AUTHORIZED_BY = 'user-42';

// ─── Tests ───────────────────────────────────────────────────────

describe('Authorized patterns (GENERALIZACIÓN-004)', () => {
  // T1: persisted valid candidate + explicit confirmation → AUTHORIZED
  it('T1: explicit confirmation authorizes a persisted candidate', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId, candidate } = await buildPersistedCandidate(
      adapter,
      KEY,
      ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ'],
    );
    void candidate;

    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(result.status).toBe('AUTHORIZED');
    expect(result.status === 'AUTHORIZED' && result.authorizedPatternId).toBeTruthy();
  });

  // T2: authorized pattern conserves the complete identity
  it('T2: authorized pattern conserves candidate, treatment and authorization metadata', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId, candidate } = await buildPersistedCandidate(
      adapter,
      KEY,
      ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ'],
    );

    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(result.status).toBe('AUTHORIZED');
    if (result.status !== 'AUTHORIZED') return;

    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(1);
    const pattern = patterns[0];

    expect(pattern.companyId).toBe(KEY.companyId);
    expect(pattern.entityId).toBe(KEY.entityId);
    expect(pattern.glAccountId).toBe(KEY.glAccountId);
    expect(pattern.direction).toBe(KEY.direction);
    expect(pattern.segments).toEqual(candidate.segments);
    expect(pattern.observationIds).toEqual(candidate.observationIds);
    expect(pattern.sourceCandidateId).toBe(candidateId);
    expect(pattern.authorizedBy).toBe(AUTHORIZED_BY);
    expect(pattern.authorizedAt).toBeTruthy();
    expect(isNaN(Date.parse(pattern.authorizedAt))).toBe(false);
  });

  // T3: missing candidate → NOT_FOUND
  it('T3: authorizing a missing candidate → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, 'mem_does_not_exist', AUTHORIZED_BY);
    expect(result.status).toBe('NOT_FOUND');
  });

  // T4: cross-tenant candidate → NOT_FOUND without revealing existence
  it('T4: candidate of another company → NOT_FOUND, no existence leak', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(
      adapter,
      { companyId: 'comp_2', entityId: 'entity_1', glAccountId: 'gl_5001', direction: 'any' },
      ['ABC 111 XYZ', 'ABC 222 XYZ'],
    );

    const fromCompanyA = await authorizeStructuralCandidate(adapter, 'comp_1', candidateId, AUTHORIZED_BY);
    expect(fromCompanyA.status).toBe('NOT_FOUND');

    const fromCompanyB = await authorizeStructuralCandidate(adapter, 'comp_2', candidateId, AUTHORIZED_BY);
    expect(fromCompanyB.status).toBe('AUTHORIZED');
  });

  // T5: malformed candidate → ERROR
  it('T5: malformed candidate content (unparsable) → ERROR', async () => {
    const { adapter, store } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);

    const item = store.get(candidateId)!;
    item.content = 'not-valid-json{{';

    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(result.status).toBe('ERROR');
  });

  it('T5b: structurally invalid candidate content (right type, broken fields) → ERROR', async () => {
    const { adapter, store } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);

    const item = store.get(candidateId)!;
    item.content = JSON.stringify({ glAccountId: KEY.glAccountId, direction: 'any' });

    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(result.status).toBe('ERROR');
  });

  // T6: empty/invalid authorizedBy → ERROR, nothing persisted
  it('T6: anonymous authorization rejected → ERROR, no pattern persisted', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);

    expect((await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, '')).status).toBe('ERROR');
    expect((await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, '   ')).status).toBe('ERROR');

    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(0);
  });

  // T7: idempotency — same candidate twice → existing pattern id
  it('T7: authorizing the same candidate twice returns the existing pattern', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);

    const first = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(first.status).toBe('AUTHORIZED');
    if (first.status !== 'AUTHORIZED') return;

    const second = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(second.status).toBe('ALREADY_AUTHORIZED');

    const third = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, 'user-99');
    expect(third.status).toBe('ALREADY_AUTHORIZED');
    if (second.status === 'ALREADY_AUTHORIZED') {
      expect(second.authorizedPatternId).toBe(first.authorizedPatternId);
    }

    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].authorizedBy).toBe(AUTHORIZED_BY);
  });

  // T8: tenant isolation of reads
  it('T8: authorized patterns are tenant isolated on read', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId: comp1CandidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    expect(
      (await authorizeStructuralCandidate(adapter, 'comp_1', comp1CandidateId, AUTHORIZED_BY)).status,
    ).toBe('AUTHORIZED');
    const { candidateId: comp2CandidateId } = await buildPersistedCandidate(
      adapter,
      { companyId: 'comp_2', entityId: 'entity_1', glAccountId: 'gl_5001', direction: 'any' },
      ['ABC 111 XYZ', 'ABC 222 XYZ'],
    );
    expect(
      (await authorizeStructuralCandidate(adapter, 'comp_2', comp2CandidateId, AUTHORIZED_BY)).status,
    ).toBe('AUTHORIZED');

    expect(await getAuthorizedPatterns(adapter, 'comp_1', KEY.entityId)).toHaveLength(1);
    const comp2Patterns = await getAuthorizedPatterns(adapter, 'comp_2', KEY.entityId);
    expect(comp2Patterns).toHaveLength(1);
    expect(comp2Patterns[0].companyId).toBe('comp_2');
    expect(comp2Patterns[0].sourceCandidateId).toBe(comp2CandidateId);
    expect(comp2Patterns[0].sourceCandidateId).not.toBe(
      (await getAuthorizedPatterns(adapter, 'comp_1', KEY.entityId))[0].sourceCandidateId,
    );
  });

  // T9: entity isolation of reads
  it('T9: authorized patterns are entity isolated on read', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId: candidate1 } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    expect((await authorizeStructuralCandidate(adapter, KEY.companyId, candidate1, AUTHORIZED_BY)).status).toBe('AUTHORIZED');
    const { candidateId: candidate2 } = await buildPersistedCandidate(
      adapter,
      { ...KEY, entityId: 'entity_2' },
      ['DEF 777', 'DEF 888'],
    );
    expect((await authorizeStructuralCandidate(adapter, KEY.companyId, candidate2, AUTHORIZED_BY)).status).toBe('AUTHORIZED');

    const entity1 = await getAuthorizedPatterns(adapter, KEY.companyId, 'entity_1');
    const entity2 = await getAuthorizedPatterns(adapter, KEY.companyId, 'entity_2');
    expect(entity1).toHaveLength(1);
    expect(entity2).toHaveLength(1);
    expect(entity1[0].entityId).toBe('entity_1');
    expect(entity2[0].entityId).toBe('entity_2');
  });

  // T10: complete traceability authorized → candidate → observations
  it('T10: authorized pattern navigates to candidate and original observations', async () => {
    const { adapter } = createMockAdapter();
    const descriptions = ['ABC 111 XYZ', 'ABC 222 XYZ'];
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, descriptions);

    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(result.status).toBe('AUTHORIZED');
    if (result.status !== 'AUTHORIZED') return;

    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(1);
    const pattern = patterns[0];

    // authorized pattern → sourceCandidateId → persisted candidate (tenant-safe)
    const candidateItem = await adapter.getById(pattern.sourceCandidateId, KEY.companyId);
    expect(candidateItem).toBeTruthy();
    expect(candidateItem!.type).toBe(STRUCTURAL_CANDIDATE_TYPE);

    // candidate → observationIds → original descriptions + confirmed treatment
    const candidateContent: StructuralCandidateContent = JSON.parse(candidateItem!.content);
    expect(candidateContent.observationIds).toEqual(pattern.observationIds);

    const observationRecords = await getClassificationObservationRecords(
      adapter,
      KEY.companyId,
      KEY.entityId,
    );
    const observationById = new Map(observationRecords.map((r) => [r.id, r.observation]));
    for (const id of pattern.observationIds) {
      const observation = observationById.get(id);
      expect(observation).toBeTruthy();
      expect(descriptions).toContain(observation!.originalDescription);
      expect(observation!.glAccountId).toBe(KEY.glAccountId);
      expect(observation!.direction).toBe(KEY.direction);
    }

    expect(pattern.authorizedBy).toBe(AUTHORIZED_BY);
    expect(pattern.authorizedAt).toBeTruthy();
  });

  // T11: compatible existing authorization → no artificial conflict
  it('T11: same entity + same treatment from another candidate authorizes cleanly', async () => {
    const { adapter } = createMockAdapter();

    const { candidateId: candidateA } = await buildPersistedCandidate(
      adapter,
      KEY,
      ['ABC 111 XYZ', 'ABC 222 XYZ'],
    );
    const authA = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateA, AUTHORIZED_BY);
    expect(authA.status).toBe('AUTHORIZED');

    // New observations (same "ABC NNN XYZ" family) for the SAME entity + SAME
    // treatment → a second candidate with extended evidence, compatible treatment.
    await seedObservations(adapter, KEY.companyId, KEY.entityId, KEY.glAccountId, 'any', [
      'ABC 555 XYZ',
      'ABC 666 XYZ',
    ]);
    const discB = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(discB.kind).toBe('candidate');
    if (discB.kind !== 'candidate') return;
    const recB = await recordStructuralCandidate(adapter, discB.candidate);
    expect(recB.ok).toBe(true);
    if (!recB.ok) return;
    const authB = await authorizeStructuralCandidate(
      adapter,
      KEY.companyId,
      recB.candidateId,
      AUTHORIZED_BY,
    );
    expect(authB.status).toBe('AUTHORIZED');

    // Both authorized patterns coexist with the same compatible treatment —
    // no winner is declared and no conflict is fabricated
    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(2);
    for (const pattern of patterns) {
      expect(pattern.glAccountId).toBe(KEY.glAccountId);
    }
  });

  // T12: incompatible treatment (different GL, same entity+direction) → CONFLICT
  it('T12: different GL for same entity+direction → CONFLICT, nothing revoked or persisted', async () => {
    const { adapter, store } = createMockAdapter();

    const { candidateId: candidateA } = await buildPersistedCandidate(
      adapter,
      KEY,
      ['ABC 111 XYZ', 'ABC 222 XYZ'],
    );
    const authA = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateA, AUTHORIZED_BY);
    expect(authA.status).toBe('AUTHORIZED');
    if (authA.status !== 'AUTHORIZED') return;
    const patternAId = authA.authorizedPatternId;
    const patternABefore = JSON.stringify(store.get(patternAId));

    // Candidate B: same entity + direction, different glAccountId
    const keyB: StructuralGroupKey = { ...KEY, glAccountId: 'gl_B' };
    const { candidateId: candidateB } = await buildPersistedCandidate(
      adapter,
      keyB,
      ['ABC 333 XYZ', 'ABC 444 XYZ'],
    );
    const authB = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateB, AUTHORIZED_BY);

    expect(authB.status).toBe('CONFLICT');
    if (authB.status === 'CONFLICT') {
      expect(authB.conflictingPatternIds).toEqual([patternAId]);
    }

    // Existing pattern A preserved unmodified — no winner, no revocation
    const patternAAfter = JSON.stringify(store.get(patternAId));
    expect(patternAAfter).toBe(patternABefore);

    // Only pattern A exists for the entity; nothing new was persisted by B
    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].glAccountId).toBe('gl_5001');

    // Candidate B still exists as evidence — conflict does not destroy it
    const candidates = await getStructuralCandidates(adapter, KEY.companyId, KEY.entityId);
    expect(candidates).toHaveLength(2);
    expect(candidates.some((c) => c.glAccountId === 'gl_B')).toBe(true);
  });

  // T13: authorized pattern does NOT affect productive lookup
  it('T13: lookupClassification stays miss after authorization', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    expect(
      (await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY)).status,
    ).toBe('AUTHORIZED');

    const lookup = await lookupClassification(adapter, KEY.companyId, 'ABC 111 XYZ');
    expect(lookup.kind).toBe('miss');
  });

  // T14: authorized pattern creates NO classification items
  it('T14: no classification MemoryItem is created by authorization', async () => {
    const { adapter, prisma } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    expect(
      (await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY)).status,
    ).toBe('AUTHORIZED');

    const classificationItems = Array.from(prisma._store.values()).filter(
      (item) => item.type === 'classification',
    );
    expect(classificationItems).toHaveLength(0);
  });

  // T15: authorized pattern does NOT modify treatment learning
  it('T15: learnEntityTreatment behaves exactly as before the authorization', async () => {
    const { adapter } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    expect(
      (await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY)).status,
    ).toBe('AUTHORIZED');

    const learn = await learnEntityTreatment(
      adapter,
      KEY.companyId,
      KEY.entityId,
      KEY.glAccountId,
      'any',
      'user_correction',
      'tx_after_authorization',
    );
    expect(learn.status).toBe('CREATED');

    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(1);
  });

  // T16: persistence error → ERROR, no ghost pattern
  it('T16: persistence failure returns ERROR and persists no pattern', async () => {
    const { adapter, prisma } = createMockAdapter();
    const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);

    (prisma.memoryItem.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));
    const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
    expect(result.status).toBe('ERROR');

    const patterns = await getAuthorizedPatterns(adapter, KEY.companyId, KEY.entityId);
    expect(patterns).toHaveLength(0);
  });
});

// Distinct memory type: authorization is NOT candidate or observation data
it('authorized pattern type is classification_authorized_pattern', async () => {
  const { adapter, store } = createMockAdapter();
  const { candidateId } = await buildPersistedCandidate(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
  const result = await authorizeStructuralCandidate(adapter, KEY.companyId, candidateId, AUTHORIZED_BY);
  expect(result.status).toBe('AUTHORIZED');
  if (result.status !== 'AUTHORIZED') return;
  const item = store.get(result.authorizedPatternId)!;
  expect(item.type).toBe(AUTHORIZED_PATTERN_TYPE);
  expect(item.type).not.toBe(STRUCTURAL_CANDIDATE_TYPE);
  expect(item.confidence).toBe('certain');
  expect(item.sourceAuthor).toBe(AUTHORIZED_BY);
});
