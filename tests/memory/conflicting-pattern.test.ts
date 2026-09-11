// Knowledge Engine — Conflicting Pattern Detection Tests (KE-EVOL-001)
// Detects and persists evidence that authorized structural knowledge
// has been contradicted by subsequent evidence. Does NOT resolve conflicts.
//
// Matrix (memory level):
//   M01 obs compatible GL → NO_CONFLICT
//   M02 obs matches structure + different GL → OBSERVATION_VS_AUTHORIZED RECORDED
//   M03 same evidence re-run → ALREADY_RECORDED
//   M04 same conflicting GL, NEW distinct observation → second evidence preserved (RECORDED)
//   M05 exact GL-B vs authorized GL-A → AUTHORIZED_VS_EXACT
//   M06 exact GL-A vs authorized GL-A → NO_CONFLICT
//   M07 two OVERLAPPING authorized patterns, different GL → AUTHORIZED_VS_AUTHORIZED
//   M08 two authorized patterns, same GL → NO_CONFLICT
//   M09 two NON-overlapping authorized patterns, different GL → NO_CONFLICT
//   M10 tenant isolation
//   M11 persisted conflict retrievable → getPendingConflicts FOUND
//   M12 pendingConflicts scoped by company (B → EMPTY)
//   M13 no conflicts at all → getPendingConflicts EMPTY
//   M14 getPendingConflicts adapter failure → ERROR (never [])
//   M15 detectConflictingPattern adapter failure → ERROR (not NO_CONFLICT)
//   M16 no authorized patterns → NO_CONFLICT
//   M17 lineage preserved (authorizationPatternIds, observationIds, sourceCandidateId)
//   M18 authorized pattern not mutated by detection
//   M19 exact treatment not mutated by detection
//   M20 no candidate/authorization created automatically
//   M21 non-matching description + different GL → NO_CONFLICT (structural requirement)

import { describe, it, expect, vi } from 'vitest';
import {
  detectConflictingPattern,
  getPendingConflicts,
  recordClassificationObservation,
  learnEntityTreatment,
  authorizeStructuralCandidate,
  recordStructuralCandidate,
  discoverStructuralCandidateForGroup,
  CONFLICTING_PATTERN_TYPE,
  AUTHORIZED_PATTERN_TYPE,
  STRUCTURAL_CANDIDATE_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey } from '../../src/memory/classification-knowledge';
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
  return { adapter, store: mockPrisma._store };
}

// ─── Helpers ─────────────────────────────────────────────────────

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const ENTITY_1 = 'entity-1';
const GL_A = 'gl-a';
const GL_B = 'gl-b';

/**
 * Full chain: 2 observations (GL) → discovered candidate → persisted
 * candidate → authorized pattern. Descriptions share stable tokens so the
 * candidate structure is: [stable 'abc', variable, stable entityId].
 */
async function setupAuthorizedPattern(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
  direction: 'debit' | 'credit' | 'any' = 'any',
): Promise<{ candidateId: string; authId: string }> {
  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `ABC ${i * 111} ${entityId}`,
      glAccountId,
      direction,
      source: 'user_correction',
      transactionId: `tx-${entityId}-${glAccountId}-${i}`,
    });
    if (!obs.ok) throw new Error('Failed to record observation');
  }

  const groupKey: StructuralGroupKey = { companyId, entityId, glAccountId, direction };
  const discovery = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (discovery.kind !== 'candidate') throw new Error(`Failed to discover candidate: ${discovery.reason}`);

  const candidate = await recordStructuralCandidate(adapter, discovery.candidate);
  if (!candidate.ok) throw new Error('Failed to record candidate');

  const auth = await authorizeStructuralCandidate(adapter, companyId, candidate.candidateId, 'admin');
  if (auth.status !== 'AUTHORIZED' && auth.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`Failed to authorize: ${auth.status}`);
  }

  return { candidateId: candidate.candidateId, authId: auth.authorizedPatternId };
}

/**
 * Create a SECOND authorized pattern directly (bypassing the authorization
 * conflict check) so two active patterns coexist for the same entity.
 * Segments come from that group's discovery so the structural shape is real.
 */
async function setupSecondAuthorizedPattern(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
  prefix: string,
): Promise<void> {
  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `${prefix} ${i * 111} ${entityId}`,
      glAccountId,
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-second-${glAccountId}-${i}`,
    });
    if (!obs.ok) throw new Error('Failed to record second observation');
  }

  const groupKey: StructuralGroupKey = { companyId, entityId, glAccountId, direction: 'any' };
  const disc = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (disc.kind !== 'candidate') throw new Error(`second discovery failed: ${disc.reason}`);
  const cand = await recordStructuralCandidate(adapter, disc.candidate);
  if (!cand.ok) throw new Error('second candidate failed');

  const content = {
    companyId,
    entityId,
    glAccountId,
    direction: 'any' as const,
    segments: disc.candidate.segments,
    sourceCandidateId: cand.candidateId,
    observationIds: disc.candidate.observationIds,
    authorizedBy: 'admin',
    authorizedAt: new Date().toISOString(),
  };
  await adapter.record({
    content: JSON.stringify(content),
    type: AUTHORIZED_PATTERN_TYPE,
    companyId,
    sourceAuthor: 'admin',
    sourceName: 'pattern_authorization',
    sourceObservedAt: new Date(),
    confidence: 'certain',
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('KE-EVOL-001 — Conflicting Pattern Detection (memory level)', () => {
  // M01: observation with the authorized GL → NO_CONFLICT
  it('M01: observation compatible with authorized pattern → NO_CONFLICT', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Additional observation, SAME GL, structurally matching description
    const obs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 333 ENTITY-1',
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m01',
    });
    expect(obs.ok).toBe(true);

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('NO_CONFLICT');
  });

  // M02: observation structurally matches pattern but carries different GL
  it('M02: matching observation with different GL → OBSERVATION_VS_AUTHORIZED RECORDED', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // ABC 999 entity-1 matches [stable abc, variable, stable entity-1] but GL differs
    const obs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m02',
    });
    expect(obs.ok).toBe(true);

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('RECORDED');
    expect(result.kind).toBe('OBSERVATION_VS_AUTHORIZED');
  });

  // M03: exact repetition of M02 → ALREADY_RECORDED
  it('M03: same detection repeated → ALREADY_RECORDED', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m03',
    });

    const first = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(first.status).toBe('RECORDED');

    const second = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.kind).toBe('OBSERVATION_VS_AUTHORIZED');
  });

  // M04: same divergent GL-B, NEW distinct observation → new evidence preserved
  it('M04: new distinct observation with SAME conflicting GL → new evidence preserved (RECORDED)', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Observation 1: structural match + GL-B divergence
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m04-a',
    });

    const first = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(first.status).toBe('RECORDED');

    // Observation 2: DIFFERENT transaction/description, SAME GL-B divergence
    const obs2 = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 777 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m04-b',
    });
    expect(obs2.ok).toBe(true);

    const second = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(second.status).toBe('RECORDED');
    expect(second.kind).toBe('OBSERVATION_VS_AUTHORIZED');

    const conflicts = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    if (conflicts.status !== 'FOUND') throw new Error(`expected FOUND, got ${conflicts.status}`);
    // Second evidence preserved: the new conflict identity (obsIds incl. obs2)
    // is distinct from the first one, so BOTH conflict records persist
    if (!obs2.ok) throw new Error('unreachable');
    expect(conflicts.conflicts.length).toBe(2);
    const latest = conflicts.conflicts[1];
    expect(latest.content.observationIds).toContain(obs2.observationId);
  });

  // M05: exact treatment GL-B vs authorized GL-A → AUTHORIZED_VS_EXACT
  it('M05: exact treatment differs from authorized → AUTHORIZED_VS_EXACT', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-m05');
    expect(learn.status).toBe('CREATED');

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('RECORDED');
    expect(result.kind).toBe('AUTHORIZED_VS_EXACT');
  });

  // M06: exact treatment same GL → NO_CONFLICT
  it('M06: exact treatment matches authorized → NO_CONFLICT', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx-m06');
    expect(learn.status).toBe('CREATED');

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('NO_CONFLICT');
  });

  // M07: two OVERLAPPING authorized patterns with different GL → AUTHORIZED_VS_AUTHORIZED
  it('M07: two overlapping patterns different GL → AUTHORIZED_VS_AUTHORIZED', async () => {
    const { adapter } = createMockAdapter();

    // Pattern 1: [stable abc, variable, stable entity-1] → GL-A
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Pattern 2: same stable tokens 'abc' + entityId (overlap with pattern 1)
    // but different GL → authorized directly (authorize would return CONFLICT)
    await setupSecondAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_B, 'ABC');

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('RECORDED');
    expect(result.kind).toBe('AUTHORIZED_VS_AUTHORIZED');

    // Overlap exists but observation conflicts are checked AFTER pattern-vs-pattern:
    // verify conflict ids are the pair, both patterns, sorted
    const conflicts = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    if (conflicts.status !== 'FOUND') throw new Error(`expected FOUND, got ${conflicts.status}`);
    const aVSA = conflicts.conflicts.find((c) => c.content.kind === 'AUTHORIZED_VS_AUTHORIZED');
    expect(aVSA).toBeTruthy();
    expect(aVSA!.content.authorizedPatternIds).toContain(setup.authId);
    expect(aVSA!.content.authorizedPatternIds.length).toBe(2);
  });

  // M08: two authorized patterns, SAME GL → NO_CONFLICT
  it('M08: two authorized patterns with same GL → NO_CONFLICT', async () => {
    const { adapter } = createMockAdapter();

    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);
    await setupSecondAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A, 'XYZ');

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('NO_CONFLICT');
  });

  // M09: two NON-overlapping patterns with different GL → NO AUTHORIZED_VS_AUTHORIZED
  it('M09: two non-overlapping patterns different GL → NO CONFLICT', async () => {
    const { adapter } = createMockAdapter();

    // Pattern 1: [stable abc, variable, stable entity-1] → GL-A
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Pattern 2: [stable xyz, variable, stable xyz-shape] → GL-B
    // Stable pos0 'xyz' ≠ pos0 'abc' → structural NEVER overlaps pattern 1
    await setupSecondAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_B, 'XYZ');

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('NO_CONFLICT');
  });

  // M10: tenant isolation — Company A conflicts do not affect Company B
  it('M10: tenant isolation — same entity, only companyId varies', async () => {
    const { adapter } = createMockAdapter();

    // Company A: pattern GL-A (same structure, same entity id, same GL shape)
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);
    // Company B: pattern GL-B, exact same entity/direction/structure/GL names
    await setupAuthorizedPattern(adapter, COMPANY_B, ENTITY_1, GL_B);

    // Company A observation: structural match + GL-B → conflicts with A's pattern
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m10-a',
    });

    const resultA = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(resultA.status).toBe('RECORDED');
    expect(resultA.kind).toBe('OBSERVATION_VS_AUTHORIZED');

    // Company B: same entity, same direction, same structure, same GL — NO conflict
    const resultB = await detectConflictingPattern(adapter, COMPANY_B, ENTITY_1, 'any');
    expect(resultB.status).toBe('NO_CONFLICT');
  });

  // M11: persisted conflict retrievable → FOUND
  it('M11: conflict persisted → getPendingConflicts FOUND', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m11',
    });

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');

    const result = await getPendingConflicts(adapter, COMPANY_A);
    expect(result.status).toBe('FOUND');
    if (result.status !== 'FOUND') return;
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].content.kind).toBe('OBSERVATION_VS_AUTHORIZED');
    expect(result.conflicts[0].content.companyId).toBe(COMPANY_A);
    expect(result.conflicts[0].content.entityId).toBe(ENTITY_1);
    expect(result.conflicts[0].content.conflictingGlAccountId).toBe(GL_B);
  });

  // M12: pendingConflicts scoped by company
  it('M12: pendingConflicts(companyA) returns only companyA conflicts', async () => {
    const { adapter } = createMockAdapter();

    // Company A: conflict
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m12-a',
    });
    await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');

    // Company B: pattern, no conflicting evidence
    await setupAuthorizedPattern(adapter, COMPANY_B, ENTITY_1, GL_A);

    const resultA = await getPendingConflicts(adapter, COMPANY_A);
    expect(resultA.status).toBe('FOUND');
    if (resultA.status !== 'FOUND') return;
    expect(resultA.conflicts.length).toBe(1);
    expect(resultA.conflicts[0].content.companyId).toBe(COMPANY_A);

    const resultB = await getPendingConflicts(adapter, COMPANY_B);
    expect(resultB.status).toBe('EMPTY');
  });

  // M13: no conflicts at all → EMPTY
  it('M13: company with no conflicts → getPendingConflicts EMPTY (not FOUND)', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const result = await getPendingConflicts(adapter, COMPANY_A);
    expect(result.status).toBe('EMPTY');
  });

  // M14: getPendingConflicts adapter failure → explicit ERROR
  it('M14: getPendingConflicts adapter failure → ERROR (never empty-array-as-silence)', async () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.memoryItem.findMany.mockRejectedValue(new Error('DB connection lost'));
    const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
    const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);

    const result = await getPendingConflicts(adapter, COMPANY_A);
    expect(result.status).toBe('ERROR');
  });

  // M15: detectConflictingPattern adapter failure → ERROR, not NO_CONFLICT
  it('M15: detect adapter failure → ERROR (not NO_CONFLICT)', async () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.memoryItem.findMany.mockRejectedValue(new Error('DB connection lost'));
    const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
    const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('ERROR');
  });

  // M16: no authorized patterns → NO_CONFLICT
  it('M16: no authorized patterns → NO_CONFLICT (nothing to conflict with)', async () => {
    const { adapter } = createMockAdapter();

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 M16',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m16',
    });

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('NO_CONFLICT');
  });

  // M17: lineage preserved in persisted conflict
  it('M17: OBSERVATION_VS_AUTHORIZED preserves lineage', async () => {
    const { adapter } = createMockAdapter();
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m17',
    });

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');

    const result = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    if (result.status !== 'FOUND') throw new Error(`expected FOUND, got ${result.status}`);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].content.authorizedPatternIds).toContain(setup.authId);
    expect(result.conflicts[0].content.observationIds.length).toBeGreaterThan(0);
    expect(result.conflicts[0].content.sourceCandidateId).toBe(setup.candidateId);
    expect(result.conflicts[0].content.detectedAt).toBeTruthy();
  });

  // M18: authorized pattern untouched after conflict detection
  it('M18: authorized pattern not modified by conflict detection', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m18',
    });

    await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');

    const patterns = await adapter.getByType(COMPANY_A, AUTHORIZED_PATTERN_TYPE);
    const active = patterns.filter((p) => p.status === 'active');
    expect(active.length).toBe(1);
    const content = JSON.parse(active[0].content);
    expect(content.glAccountId).toBe(GL_A);
    expect(content.entityId).toBe(ENTITY_1);
  });

  // M19: exact treatment untouched after conflict detection
  it('M19: exact treatment not modified by conflict detection', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-m19');

    await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');

    const all = await adapter.getByType(COMPANY_A, 'classification');
    const entityItems = all.filter((item) => {
      if (item.status !== 'active') return false;
      try {
        const c = JSON.parse(item.content);
        return c.entityId === ENTITY_1;
      } catch {
        return false;
      }
    });
    expect(entityItems.length).toBe(1);
    const content = JSON.parse(entityItems[0].content);
    expect(content.glAccountId).toBe(GL_B);
  });

  // M20: no candidate or authorization created automatically
  it('M20: conflict detection does not create candidates or authorizations', async () => {
    const { adapter, store } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m20',
    });

    const beforeCandidates = Array.from(store.values()).filter((i) => i.type === STRUCTURAL_CANDIDATE_TYPE && i.status === 'active').length;
    const beforeAuth = Array.from(store.values()).filter((i) => i.type === AUTHORIZED_PATTERN_TYPE && i.status === 'active').length;

    await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');

    const afterCandidates = Array.from(store.values()).filter((i) => i.type === STRUCTURAL_CANDIDATE_TYPE && i.status === 'active').length;
    const afterAuth = Array.from(store.values()).filter((i) => i.type === AUTHORIZED_PATTERN_TYPE && i.status === 'active').length;

    expect(afterCandidates).toBe(beforeCandidates);
    expect(afterAuth).toBe(beforeAuth);

    const conflicts = Array.from(store.values()).filter((i) => i.type === CONFLICTING_PATTERN_TYPE && i.status === 'active');
    expect(conflicts.length).toBe(1);
  });

  // M21: structural requirement NEGATIVE — different GL but description does
  // NOT match the authorized structure → NO OBSERVATION_VS_AUTHORIZED
  it('M21: non-matching description with different GL → NO_CONFLICT', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // ZZZ 999 does NOT match [stable abc, variable, stable entity-1]
    const obs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ZZZ 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-m21',
    });
    expect(obs.ok).toBe(true);

    const result = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(result.status).toBe('NO_CONFLICT');
  });
});
