// Knowledge Engine — Structural Candidate Tests (GENERALIZACIÓN-003)
// Pure structural discovery from accumulated classification observations.
// NO business semantics, NO fuzzy matching, NO pattern authority.

import { describe, it, expect, vi } from 'vitest';
import {
  discoverStructuralCandidate,
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  getStructuralCandidates,
  getClassificationObservationRecords,
  recordClassificationObservation,
  lookupClassification,
  learnEntityTreatment,
  STRUCTURAL_CANDIDATE_TYPE,
  OBSERVATION_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralCandidateContent } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client (same pattern as classification-observation) ──

function createMockPrisma() {
  const store = new Map<string, { id: string; content: string; type: string; status: string; confidence: string; companyId: string; sourceAuthor: string; sourceName: string }>();
  let nextId = 1;

  return {
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

// ─── Observation helpers ─────────────────────────────────────────

async function seedObservations(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
  direction: 'debit' | 'credit' | 'any',
  descriptions: string[],
): Promise<string[]> {
  const ids: string[] = [];
  let i = 1;
  for (const originalDescription of descriptions) {
    const result = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription,
      glAccountId,
      direction,
      source: 'user_correction',
      transactionId: `tx_${companyId}_${entityId}_${glAccountId}_${direction}_${i++}`,
    });
    if (!result.ok) throw new Error(`seed observation failed: ${result.error}`);
    ids.push(result.observationId);
  }
  return ids;
}

const KEY = {
  companyId: 'comp_1',
  entityId: 'entity_1',
  glAccountId: 'gl_5001',
  direction: 'any' as const,
};

// ─── Pure discovery (no DB) ──────────────────────────────────────

describe('Pure structural discovery (GENERALIZACIÓN-003)', () => {
  // T1: simple structure — stable prefix, variable middle, stable suffix
  it('T1: three compatible observations produce stable/variable/stable segments', () => {
    const result = discoverStructuralCandidate([
      { observationId: 'o1', originalDescription: 'ABC 111 XYZ' },
      { observationId: 'o2', originalDescription: 'ABC 222 XYZ' },
      { observationId: 'o3', originalDescription: 'ABC 333 XYZ' },
    ]);

    expect(result.kind).toBe('candidate');
    expect(result.kind === 'candidate' && result.segments).toEqual([
      { kind: 'stable', value: 'abc' },
      { kind: 'variable', evidence: ['111', '222', '333'] },
      { kind: 'stable', value: 'xyz' },
    ]);
    if (result.kind === 'candidate') {
      expect(result.observationIds).toEqual(['o1', 'o2', 'o3']);
    }
  });

  // T2: all stable — must NOT invent a variable segment
  it('T2: identical observations produce all-stable segments, no invented variable', () => {
    const result = discoverStructuralCandidate([
      { observationId: 'o1', originalDescription: 'ABC XYZ' },
      { observationId: 'o2', originalDescription: 'ABC XYZ' },
    ]);

    expect(result.kind).toBe('candidate');
    expect(result.kind === 'candidate' && result.segments).toEqual([
      { kind: 'stable', value: 'abc' },
      { kind: 'stable', value: 'xyz' },
    ]);
  });

  // T3: all variable — conservative explicit NO candidate
  it('T3: no stable position at all → conservative NO candidate', () => {
    const result = discoverStructuralCandidate([
      { observationId: 'o1', originalDescription: 'AAA' },
      { observationId: 'o2', originalDescription: 'BBB' },
      { observationId: 'o3', originalDescription: 'CCC' },
    ]);

    expect(result).toEqual({ kind: 'none', reason: 'no_stable_segments' });
  });

  // T4: different token counts — conservative NO candidate, no fuzzy alignment
  it('T4: different token lengths → conservative NO candidate', () => {
    const result = discoverStructuralCandidate([
      { observationId: 'o1', originalDescription: 'ABC 111 XYZ' },
      { observationId: 'o2', originalDescription: 'ABC XYZ' },
    ]);

    expect(result).toEqual({ kind: 'none', reason: 'inconsistent_token_length' });
  });

  it('no observations or single observation → NO candidate (nothing to compare)', () => {
    expect(discoverStructuralCandidate([])).toEqual({ kind: 'none', reason: 'no_observations' });
    expect(discoverStructuralCandidate([{ observationId: 'o1', originalDescription: 'AAA' }])).toEqual({
      kind: 'none',
      reason: 'single_observation',
    });
  });

  it('variable evidence keeps distinct values in first-appearance order', () => {
    const result = discoverStructuralCandidate([
      { observationId: 'o1', originalDescription: 'ABC 999 XYZ' },
      { observationId: 'o2', originalDescription: 'ABC 111 XYZ' },
      { observationId: 'o3', originalDescription: 'ABC 999 XYZ' },
    ]);
    expect(result.kind).toBe('candidate');
    expect(result.kind === 'candidate' && result.segments[1]).toEqual({
      kind: 'variable',
      evidence: ['999', '111'],
    });
  });

  // T13: no business semantics inferred — commercial-looking tokens are plain positions
  it('T13: generic words like "INVOICE"/"VENDOR" carry no special structural meaning', () => {
    const result = discoverStructuralCandidate([
      { observationId: 'o1', originalDescription: 'VENDOR INVOICE 1234' },
      { observationId: 'o2', originalDescription: 'VENDOR INVOICE 5678' },
    ]);
    expect(result.kind).toBe('candidate');
    expect(result.kind === 'candidate' && result.segments).toEqual([
      { kind: 'stable', value: 'vendor' },
      { kind: 'stable', value: 'invoice' },
      { kind: 'variable', evidence: ['1234', '5678'] },
    ]);
  });
});

// ─── Group discovery + persistence (MemoryAdapter) ───────────────

describe('Group discovery and candidate persistence (GENERALIZACIÓN-003)', () => {
  // T5: tenant isolation
  it('T5: observations of company A never participate in candidates of company B', async () => {
    const { adapter } = createMockAdapter();

    await seedObservations(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
    ]);
    await seedObservations(adapter, 'comp_2', 'entity_1', 'gl_5001', 'any', [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
      'ABC 333 XYZ',
    ]);

    const disc1 = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_5001',
      direction: 'any',
    });
    const disc2 = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_2',
      entityId: 'entity_1',
      glAccountId: 'gl_5001',
      direction: 'any',
    });

    expect(disc1.kind).toBe('candidate');
    expect(disc2.kind).toBe('candidate');
    if (disc1.kind === 'candidate' && disc2.kind === 'candidate') {
      // comp_1 candidate built ONLY from comp_1 observations (2), not comp_2's 3
      expect(disc1.candidate.observationIds).toHaveLength(2);
      expect(disc2.candidate.observationIds).toHaveLength(3);
      // no id overlap
      const overlap = disc1.candidate.observationIds.filter((id) =>
        disc2.candidate.observationIds.includes(id),
      );
      expect(overlap).toHaveLength(0);
      expect(disc1.candidate.companyId).toBe('comp_1');
      expect(disc2.candidate.companyId).toBe('comp_2');
    }
  });

  // T6: entity isolation within same company
  it('T6: different entities in same company produce separate candidates', async () => {
    const { adapter } = createMockAdapter();

    await seedObservations(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
    ]);
    await seedObservations(adapter, 'comp_1', 'entity_2', 'gl_5001', 'any', [
      'DEF 777',
      'DEF 888',
    ]);

    const disc1 = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_5001',
      direction: 'any',
    });
    const disc2 = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_2',
      glAccountId: 'gl_5001',
      direction: 'any',
    });

    expect(disc1.kind).toBe('candidate');
    expect(disc2.kind).toBe('candidate');
    if (disc1.kind === 'candidate' && disc2.kind === 'candidate') {
      expect(disc1.candidate.observationIds).toHaveLength(2);
      expect(disc2.candidate.observationIds).toHaveLength(2);
      const overlap = disc1.candidate.observationIds.filter((id) =>
        disc2.candidate.observationIds.includes(id),
      );
      expect(overlap).toHaveLength(0);
      expect(disc1.candidate.entityId).toBe('entity_1');
      expect(disc2.candidate.entityId).toBe('entity_2');
    }
  });

  // T7: treatment isolation — GL_A and GL_B never mix
  it('T7: incompatible treatments (GL_A vs GL_B) are compared in separate groups, never mixed', async () => {
    const { adapter } = createMockAdapter();

    await seedObservations(adapter, 'comp_1', 'entity_1', 'gl_A', 'any', [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
    ]);
    await seedObservations(adapter, 'comp_1', 'entity_1', 'gl_B', 'any', [
      'ABC 333 XYZ',
      'ABC 444 XYZ',
    ]);

    const discA = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_A',
      direction: 'any',
    });
    const discB = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_B',
      direction: 'any',
    });

    expect(discA.kind).toBe('candidate');
    expect(discB.kind).toBe('candidate');
    if (discA.kind === 'candidate' && discB.kind === 'candidate') {
      expect(discA.candidate.glAccountId).toBe('gl_A');
      expect(discB.candidate.glAccountId).toBe('gl_B');
      expect(discA.candidate.observationIds).toHaveLength(2);
      expect(discB.candidate.observationIds).toHaveLength(2);
      const overlap = discA.candidate.observationIds.filter((id) =>
        discB.candidate.observationIds.includes(id),
      );
      expect(overlap).toHaveLength(0);
      // Neither candidate's variable evidence contains tokens of the other group
      expect(discA.candidate.segments[1]).toEqual({ kind: 'variable', evidence: ['111', '222'] });
      expect(discB.candidate.segments[1]).toEqual({ kind: 'variable', evidence: ['333', '444'] });
    }
  });

  // T8: direction isolation
  it('T8: different directions produce separate observation groups', async () => {
    const { adapter } = createMockAdapter();

    await seedObservations(adapter, 'comp_1', 'entity_1', 'gl_5001', 'any', [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
    ]);
    await seedObservations(adapter, 'comp_1', 'entity_1', 'gl_5001', 'credit', [
      'ABC 333 XYZ',
      'ABC 444 XYZ',
    ]);

    const discAny = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_5001',
      direction: 'any',
    });
    const discCredit = await discoverStructuralCandidateForGroup(adapter, {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_5001',
      direction: 'credit',
    });

    expect(discAny.kind).toBe('candidate');
    expect(discCredit.kind).toBe('candidate');
    if (discAny.kind === 'candidate' && discCredit.kind === 'candidate') {
      expect(discAny.candidate.direction).toBe('any');
      expect(discCredit.candidate.direction).toBe('credit');
      expect(discAny.candidate.observationIds).toHaveLength(2);
      expect(discCredit.candidate.observationIds).toHaveLength(2);
      const overlap = discAny.candidate.observationIds.filter((id) =>
        discCredit.candidate.observationIds.includes(id),
      );
      expect(overlap).toHaveLength(0);
    }
  });

  // T9: provenance — observationIds are exactly the observations used
  it('T9: candidate observationIds contain exactly the observations of the group', async () => {
    const { adapter } = createMockAdapter();

    const seeded = await seedObservations(
      adapter,
      KEY.companyId,
      KEY.entityId,
      KEY.glAccountId,
      KEY.direction,
      ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ'],
    );

    const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(disc.kind).toBe('candidate');
    if (disc.kind === 'candidate') {
      expect([...disc.candidate.observationIds].sort()).toEqual([...seeded].sort());
      expect(disc.candidate.observationIds).toHaveLength(3);
    }
  });

  // T10: idempotency — same observation set + same structure → same candidate id
  it('T10: record same discovered candidate twice → one persistent candidate', async () => {
    const { adapter } = createMockAdapter();

    await seedObservations(adapter, KEY.companyId, KEY.entityId, KEY.glAccountId, KEY.direction, [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
    ]);

    const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(disc.kind).toBe('candidate');
    if (disc.kind !== 'candidate') return;

    const rec1 = await recordStructuralCandidate(adapter, disc.candidate);
    const rec2 = await recordStructuralCandidate(adapter, disc.candidate);
    expect(rec1.ok).toBe(true);
    expect(rec2.ok).toBe(true);
    if (rec1.ok && rec2.ok) {
      expect(rec1.candidateId).toBe(rec2.candidateId);
    }

    const candidates = await getStructuralCandidates(adapter, KEY.companyId, KEY.entityId);
    expect(candidates).toHaveLength(1);
  });

  // T11: persist/retrieve + provenance chain back to original descriptions
  it('T11: candidate persists and chains to original observations and descriptions', async () => {
    const { adapter } = createMockAdapter();

    const descriptions = ['ABC 111 XYZ', 'ABC 222 XYZ'];
    const seeded = await seedObservations(
      adapter,
      KEY.companyId,
      KEY.entityId,
      KEY.glAccountId,
      KEY.direction,
      descriptions,
    );

    const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(disc.kind).toBe('candidate');
    if (disc.kind !== 'candidate') return;

    const rec = await recordStructuralCandidate(adapter, disc.candidate);
    expect(rec.ok).toBe(true);

    const candidates = await getStructuralCandidates(adapter, KEY.companyId, KEY.entityId);
    expect(candidates).toHaveLength(1);
    const stored = candidates[0];
    expect(stored.companyId).toBe(KEY.companyId);
    expect(stored.entityId).toBe(KEY.entityId);
    expect(stored.glAccountId).toBe(KEY.glAccountId);
    expect(stored.direction).toBe(KEY.direction);
    expect(stored.observationIds).toEqual(disc.candidate.observationIds);
    expect([...stored.observationIds].sort()).toEqual([...seeded].sort());
    expect(stored.segments).toEqual([
      { kind: 'stable', value: 'abc' },
      { kind: 'variable', evidence: ['111', '222'] },
      { kind: 'stable', value: 'xyz' },
    ]);

    // Chain: candidate → observationIds → original descriptions + treatment
    const records = await getClassificationObservationRecords(
      adapter,
      KEY.companyId,
      KEY.entityId,
    );
    const byId = new Map(records.map((r) => [r.id, r.observation]));
    for (const id of stored.observationIds) {
      const observation = byId.get(id);
      expect(observation).toBeTruthy();
      expect(descriptions).toContain(observation!.originalDescription);
      expect(observation!.glAccountId).toBe(KEY.glAccountId);
      expect(observation!.direction).toBe(KEY.direction);
    }
  });

  // T12: candidate does NOT affect productive classification
  it('T12: recording a candidate creates NO classification knowledge and lookup stays miss', async () => {
    const { adapter, prisma } = createMockAdapter();

    const description = 'ABC 111 XYZ';
    await seedObservations(adapter, KEY.companyId, KEY.entityId, KEY.glAccountId, KEY.direction, [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
    ]);

    const before = await lookupClassification(adapter, KEY.companyId, description);
    expect(before.kind).toBe('miss');

    const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(disc.kind).toBe('candidate');
    if (disc.kind !== 'candidate') return;
    const rec = await recordStructuralCandidate(adapter, disc.candidate);
    expect(rec.ok).toBe(true);

    const after = await lookupClassification(adapter, KEY.companyId, description);
    expect(after.kind).toBe('miss');

    // No 'classification' item was created or modified by candidate recording
    const classificationItems = Array.from(prisma._store.values()).filter(
      (item) => item.type === 'classification',
    );
    expect(classificationItems).toHaveLength(0);

    // Treatment learning behaves exactly as before the candidate existed
    const learn = await learnEntityTreatment(
      adapter,
      KEY.companyId,
      KEY.entityId,
      KEY.glAccountId,
      'any',
      'user_correction',
      'tx_later',
    );
    expect(learn.status).toBe('CREATED');
  });
});

// Structural candidate type is distinct from treatment/observation types
it('candidate type constant is classification_structural_candidate', async () => {
  const { adapter, store } = createMockAdapter();

  await seedObservations(adapter, KEY.companyId, KEY.entityId, KEY.glAccountId, KEY.direction, [
    'ABC 111 XYZ',
    'ABC 222 XYZ',
  ]);
  const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
  expect(disc.kind).toBe('candidate');
  if (disc.kind !== 'candidate') return;

  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  expect(rec.ok).toBe(true);
  const stored = store.get(rec.ok ? rec.candidateId : '');
  expect(stored).toBeTruthy();
  expect(stored!.type).toBe(STRUCTURAL_CANDIDATE_TYPE);
  expect(stored!.type).not.toBe(OBSERVATION_TYPE);
  expect(stored!.type).not.toBe('classification');
});

// ─── Persistence failure semantics ───────────────────────────────

it('T14: persistence error does not produce a valid candidate', async () => {
  const { adapter, prisma } = createMockAdapter();

  const disc = {
    kind: 'candidate' as const,
    candidate: {
      companyId: 'comp_1',
      entityId: 'entity_1',
      glAccountId: 'gl_5001',
      direction: 'any' as const,
      segments: [
        { kind: 'stable' as const, value: 'abc' },
        { kind: 'variable' as const, evidence: ['111', '222'] },
      ],
      observationIds: ['o1', 'o2'],
    } satisfies StructuralCandidateContent,
  };

  (prisma.memoryItem.create as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('DB write failed'),
  );

  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  expect(rec.ok).toBe(false);

  const candidates = await getStructuralCandidates(adapter, 'comp_1', 'entity_1');
  expect(candidates).toHaveLength(0);
});

it('validation: candidate without segments or observationIds is rejected', async () => {
  const { adapter } = createMockAdapter();

  const emptySegments: StructuralCandidateContent = {
    companyId: 'comp_1',
    entityId: 'entity_1',
    glAccountId: 'gl_5001',
    direction: 'any',
    segments: [],
    observationIds: ['o1'],
  };
  const emptyIds: StructuralCandidateContent = {
    companyId: 'comp_1',
    entityId: 'entity_1',
    glAccountId: 'gl_5001',
    direction: 'any',
    segments: [{ kind: 'stable', value: 'abc' }],
    observationIds: [],
  };

  expect((await recordStructuralCandidate(adapter, emptySegments)).ok).toBe(false);
  expect((await recordStructuralCandidate(adapter, emptyIds)).ok).toBe(false);

  const candidates = await getStructuralCandidates(adapter, 'comp_1', 'entity_1');
  expect(candidates).toHaveLength(0);
});
