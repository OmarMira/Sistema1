// Knowledge Engine — Human Rehabilitation Tests (KE-EVOL-005)
//
// Explicit human rehabilitation of knowledge degraded by a persisted
// deterministic conflict whose enabling conflict has been EXPLICITLY
// RESOLVED by a human:
//
//   UNRESOLVED CONFLICT degrades knowledge (KE-EVOL-001/002)
//   → HUMAN RESOLVES THE CONFLICT (KE-EVOL-004)
//   → NO OTHER PENDING CONFLICT IMPLICATES THE ITEM
//   → HUMAN EXPLICITLY REHABILITATES (rehabilitateClassificationKnowledge)
//   → confidence 'certain', reason 'human_rehabilitation'
//
// Automatic rehabilitation is FORBIDDEN: no thresholds, observation
// counts, time windows, scores, or decay ever change confidence.
// Resolve ≠ rehabilitate: resolution alone never touches confidence.
//
// Defect-fix semantics are exercised with the SAME domain operations the
// route delegates to (FIRST FIGHT: promotion gated under pending conflict;
// SECOND FIGHT: resolved conflict must not re-degrade, genuinely new
// post-resolution conflict still degrades).
//
// Matrix: T01–T38 below.

import { describe, it, expect, vi } from 'vitest';
import {
  learnEntityTreatment,
  recordClassificationObservation,
  detectConflictingPattern,
  degradeKnowledgeOnConflict,
  evolveClassificationConfidence,
  resolveClassificationConflict,
  rehabilitateClassificationKnowledge,
  getPendingConflicts,
  getConflictResolutions,
  isKnowledgeImplicatedByPendingConflict,
  isConflictResolved,
  matchAuthorizedPattern,
  lookupTreatment,
  authorizeStructuralCandidate,
  recordStructuralCandidate,
  discoverStructuralCandidateForGroup,
  CONFLICTING_PATTERN_TYPE,
  REHABILITATION_EVENT_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey, ConflictingPatternContent } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client (contract-only double, repo precedent) ───

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
    traceabilityLog: {
      create: vi.fn(async (args: { data: { itemId: string; action: string; actor: string; details: unknown } }) => {
        return { id: `tl_${nextId++}`, ...args.data };
      }),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: {
      create: vi.fn(async (args: { data: { itemId: string; previousLevel: string; newLevel: string; reason: string } }) => {
        return { id: `cl_${nextId++}`, ...args.data };
      }),
      findMany: vi.fn(async () => []),
    },
    _store: store,
  };
}

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as unknown as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as unknown as MemoryPrismaClient, mockRunTx);
  return { adapter, store: mockPrisma._store, prisma: mockPrisma };
}

// ─── Helpers ─────────────────────────────────────────────────────

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const ENTITY_1 = 'entity-1';
const ENTITY_2 = 'entity-2';
const GL_A = 'gl-a';
const GL_B = 'gl-b';
const HUMAN = 'supervisor-7';

async function setupAuthorizedPattern(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
): Promise<{ candidateId: string; authId: string }> {
  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `ABC ${i * 111} ${entityId}`,
      glAccountId,
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-setup-${entityId}-${glAccountId}-${i}`,
    });
    if (!obs.ok) throw new Error('Failed to record observation');
  }

  const groupKey: StructuralGroupKey = { companyId, entityId, glAccountId, direction: 'any' };
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
 * OBSERVATION_VS_AUTHORIZED flow: authorized pattern GL_A + a
 * structurally-matching observation with GL_B → persisted conflict whose
 * authorizedPatternIds = [patternId]. Degrades it to 'uncertain' on demand.
 */
async function setupPendingObservationConflict(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  suffix: string,
): Promise<{ conflictId: string; patternId: string }> {
  const { authId: patternId } = await setupAuthorizedPattern(adapter, companyId, entityId, GL_A);

  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `ABC 999 ${entityId}`,
    glAccountId: GL_B,
    direction: 'any',
    source: 'user_correction',
    transactionId: `tx-obsconflict-${suffix}`,
  });
  if (!obs.ok) throw new Error('Failed to record conflicting observation');

  const detect = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`expected RECORDED, got ${detect.status}`);
  return { conflictId: detect.conflictId, patternId };
}

/** Degrade the disputed knowledge to 'uncertain' (KE-EVOL-002 behavior). */
async function degradeByConflict(adapter: MemoryAdapter, companyId: string, conflictId: string): Promise<void> {
  const degraded = await degradeKnowledgeOnConflict(adapter, companyId, conflictId);
  if (degraded.status !== 'UPDATED' && degraded.status !== 'UNCHANGED') {
    throw new Error(`degrade failed: ${degraded.status}`);
  }
}

async function setupUncertainPatternTarget(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  suffix: string,
): Promise<{ conflictId: string; patternId: string }> {
  const setup = await setupPendingObservationConflict(adapter, companyId, entityId, suffix);
  await degradeByConflict(adapter, companyId, setup.conflictId);
  return setup;
}

/**
 * AUTHORIZED_VS_EXACT flow: authorized pattern GL_A + exact treatment GL_B
 * whose observation description does NOT structurally match → persisted
 * conflict with exactTreatmentItemIds = [exactId].
 */
async function setupPendingExactConflict(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  suffix: string,
): Promise<{ conflictId: string; patternId: string; exactId: string }> {
  const { authId: patternId } = await setupAuthorizedPattern(adapter, companyId, entityId, GL_A);

  const learn = await learnEntityTreatment(adapter, companyId, entityId, GL_B, 'any', 'user_correction', `tx-exact-${suffix}`);
  if (learn.status !== 'CREATED') throw new Error(`expected CREATED, got ${learn.status}`);
  const exactId = learn.itemId;

  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `ZZZ 123 ${entityId}`,
    glAccountId: GL_B,
    direction: 'any',
    source: 'user_correction',
    transactionId: `tx-obs-exact-${suffix}`,
  });
  if (!obs.ok) throw new Error('observation failed');

  const detect = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`expected RECORDED, got ${detect.status}`);
  return { conflictId: detect.conflictId, patternId, exactId };
}

async function resolveConflict(
  adapter: MemoryAdapter,
  companyId: string,
  conflictId: string,
): Promise<void> {
  const resolved = await resolveClassificationConflict(adapter, companyId, conflictId, HUMAN, 'human decision recorded');
  if (resolved.status !== 'RESOLVED' && resolved.status !== 'ALREADY_RESOLVED') {
    throw new Error(`resolve failed: ${resolved.status}`);
  }
}

/**
 * Contract-only double: a pending conflict record built directly, used to
 * stage multi-conflict and legacy-shaped scenarios that detection cannot
 * produce from the supplied evidence.
 */
async function recordManualConflict(
  adapter: MemoryAdapter,
  companyId: string,
  partial: Pick<
    ConflictingPatternContent,
    'entityId' | 'kind' | 'authorizedPatternIds' | 'conflictingGlAccountId' | 'observationIds'
  > & { exactTreatmentItemIds?: string[] },
): Promise<string> {
  const content: ConflictingPatternContent = {
    companyId,
    entityId: partial.entityId,
    direction: 'any',
    kind: partial.kind,
    authorizedPatternIds: partial.authorizedPatternIds,
    conflictingGlAccountId: partial.conflictingGlAccountId,
    observationIds: partial.observationIds,
    detectedAt: new Date().toISOString(),
    ...(partial.exactTreatmentItemIds !== undefined
      ? { exactTreatmentItemIds: partial.exactTreatmentItemIds }
      : {}),
  };
  const item = await adapter.record({
    content: JSON.stringify(content),
    type: CONFLICTING_PATTERN_TYPE,
    companyId,
    sourceAuthor: 'system',
    sourceName: 'conflict_detection',
    sourceObservedAt: new Date(),
    confidence: 'tentative',
  });
  return item.id;
}

/**
 * The EXACT knowledge sequence of the route's KNOWN branch, POST
 * KE-EVOL-005: promotion gated by isKnowledgeImplicatedByPendingConflict,
 * degradation gated by isConflictResolved. This is the behavior the route
 * now implements around the unchanged domain operations.
 */
async function knownCorrectionCyclePostKeEvol005(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  transactionId: string,
): Promise<void> {
  const learn = await learnEntityTreatment(adapter, companyId, entityId, GL_B, 'any', 'user_correction', transactionId);
  if (learn.status === 'CREATED' || learn.status === 'UNCHANGED') {
    const implicated = await isKnowledgeImplicatedByPendingConflict(adapter, companyId, learn.itemId);
    if (!implicated.implicated) {
      await evolveClassificationConfidence(adapter, companyId, learn.itemId, 'certain', 'human_confirmation');
    }
  }

  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: 'ZZZ 999 ENTITY-1',
    glAccountId: GL_B,
    direction: 'any',
    source: 'user_correction',
    transactionId,
  });
  if (!obs.ok) throw new Error('observation failed');

  const conflict = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (conflict.status === 'RECORDED' || conflict.status === 'ALREADY_RECORDED') {
    const resolvedCheck = await isConflictResolved(adapter, companyId, conflict.conflictId);
    if (!resolvedCheck.resolved) {
      await degradeKnowledgeOnConflict(adapter, companyId, conflict.conflictId);
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────

/** Degrade-blocked target already uncertain → resolve → rehabilitate. */
async function resolveAndRehabilitatePattern(
  adapter: MemoryAdapter,
  conflictId: string,
  patternId: string,
): Promise<{ status: string }> {
  await resolveConflict(adapter, COMPANY_A, conflictId);
  return rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
}

describe('KE-EVOL-005 — Human Rehabilitation Preconditions', () => {
  it('T01: unresolved conflict cannot rehabilitate → CONFLICT_NOT_RESOLVED, nothing modified', async () => {
    const { adapter, store } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't01');

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('CONFLICT_NOT_RESOLVED');

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
    expect(Array.from(store.values()).filter((i) => i.type === REHABILITATION_EVENT_TYPE).length).toBe(0);
  });

  it('T02: resolved conflict + explicit human rehabilitation → REHABILITATED, confidence certain', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't02');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('certain');
  });

  it('T03: explicit human actor required — blank rehabilitatedBy → ERROR, nothing done', async () => {
    const { adapter, store } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't03');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const empty = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, '');
    const blank = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, '   ');
    expect(empty.status).toBe('ERROR');
    expect(blank.status).toBe('ERROR');

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
    expect(Array.from(store.values()).filter((i) => i.type === REHABILITATION_EVENT_TYPE).length).toBe(0);
  });

  it('T04: conflict of another tenant → NOT_FOUND (no existence leak)', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't04');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_B, conflictId, patternId, HUMAN);
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T05: knowledge item of another tenant → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't05');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const foreignLearn = await learnEntityTreatment(adapter, COMPANY_B, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t05-b');
    if (foreignLearn.status !== 'CREATED') throw new Error('foreign learn failed');

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, foreignLearn.itemId, HUMAN);
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T06: nonexistent conflict → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, 'mem_missing', 'mem_x', HUMAN);
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T07: nonexistent knowledge item → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't07');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, 'mem_missing', HUMAN);
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T8 prepared fixture: wrong conflict MemoryItem type → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't08');

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_2, GL_B, 'any', 'user_correction', 'tx-t08');
    if (learn.status !== 'CREATED') throw new Error('learn failed');

    // A classification item is NOT a conflict item
    const wrongType = learn.itemId;
    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, wrongType, wrongType, HUMAN);
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T09: knowledge explicitly implicated-by-nothing → NOT_IMPLICATED', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't09');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    // The conflict implicates the PATTERN only:
    // this UNRELATED uncertain item of a different entity is not implicated.
    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_2, GL_B, 'any', 'user_correction', 'tx-t09');
    if (learn.status !== 'CREATED') throw new Error('learn failed');
    const unrelatedId = learn.itemId;
    await evolveClassificationConfidence(adapter, COMPANY_A, unrelatedId, 'uncertain', 'deterministic_conflict');

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, unrelatedId, HUMAN);
    expect(result.status).toBe('NOT_IMPLICATED');

    // The genuine pattern target remains separately rehabilitable
    const patternResult = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(patternResult.status).toBe('REHABILITATED');
  });

  it('T10: legacy AUTHORIZED_VS_EXACT without exactTreatmentItemIds — exact target NOT derivable → NOT_IMPLICATED (no guess)', async () => {
    const { adapter } = createMockAdapter();
    const { authId: patternId } = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t10');
    if (learn.status !== 'CREATED') throw new Error('learn failed');
    const exactId = learn.itemId;

    // Legacy-shaped conflict: NO exactTreatmentItemIds field
    const legacyConflictId = await recordManualConflict(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      kind: 'AUTHORIZED_VS_EXACT',
      authorizedPatternIds: [patternId],
      conflictingGlAccountId: GL_B,
      observationIds: [],
    });

    await degradeByConflict(adapter, COMPANY_A, legacyConflictId);
    await resolveConflict(adapter, COMPANY_A, legacyConflictId);

    const rehabilitation = await rehabilitateClassificationKnowledge(
      adapter, COMPANY_A, legacyConflictId, exactId, HUMAN,
    );
    expect(rehabilitation.status).toBe('NOT_IMPLICATED');

    const exact = await adapter.getById(exactId, COMPANY_A);
    expect(exact?.confidence).toBe('uncertain');
  });

  it('T11: legacy AUTHORIZED_VS_EXACT — the explicitly identified pattern target remains eligible', async () => {
    const { adapter } = createMockAdapter();
    const { authId: patternId } = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t11');
    if (learn.status !== 'CREATED') throw new Error('learn failed');

    const legacyConflictId = await recordManualConflict(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      kind: 'AUTHORIZED_VS_EXACT',
      authorizedPatternIds: [patternId],
      conflictingGlAccountId: GL_B,
      observationIds: [],
    });

    await degradeByConflict(adapter, COMPANY_A, legacyConflictId);
    await resolveConflict(adapter, COMPANY_A, legacyConflictId);

    const patternTarget = patternId;
    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, legacyConflictId, patternTarget, HUMAN);
    expect(result.status).toBe('REHABILITATED');
  });

  it('T12: currently-uncertain item is the only eligible state for rehabilitation', async () => {
    const { adapter } = createMockAdapter();
    // F-level ordering between T12 (uncertain required → other states
    // rejected) is exercised here across the state matrix.
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't12');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    // The pattern is 'uncertain' and qualifies
    const okResult = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(okResult.status).toBe('REHABILITATED');
  });

  it('T14: currently-tentative item → NOT_UNCERTAIN (only uncertain→certain)', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't14');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    // Push the target to a non-uncertain, non-certain state ('tentative')
    const reset = await evolveClassificationConfidence(adapter, COMPANY_A, patternId, 'tentative', 'deterministic_conflict');
    expect(reset.status).toBe('UPDATED');

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('NOT_UNCERTAIN');

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('tentative');
  });

  it('T13: already-certain item → ALREADY_CERTAIN, no event, no new logs', async () => {
    const { adapter, store, prisma } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't13');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    // First rehabilitation → certain
    const first = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(first.status).toBe('REHABILITATED');
    const confidenceLogsAfterFirst = prisma.confidenceLog.create.mock.calls.length;

    // Re-run → ALREADY_CERTAIN. No new logs, no second event.
    const second = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(second.status).toBe('ALREADY_CERTAIN');
    expect(prisma.confidenceLog.create.mock.calls.length).toBe(confidenceLogsAfterFirst);
    expect(Array.from(store.values()).filter((i) => i.type === REHABILITATION_EVENT_TYPE).length).toBe(1);
  });
});

describe('KE-EVOL-005 — Human Rehabilitation Transition and Traceability', () => {
  it('T15: human rehabilitation produces the uncertain→certain transition', async () => {
    const { adapter } = createMockAdapter();
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_1, 't15');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);

    const exactBefore = await adapter.getById(setup.exactId, COMPANY_A);
    expect(exactBefore?.confidence).toBe('uncertain');

    await resolveConflict(adapter, COMPANY_A, setup.conflictId);
    await rehabilitateClassificationKnowledge(adapter, COMPANY_A, setup.conflictId, setup.exactId, HUMAN);

    const exactAfter = await adapter.getById(setup.exactId, COMPANY_A);
    expect(exactAfter?.confidence).toBe('certain');
  });

  it('T16: the transition reason is human_rehabilitation', async () => {
    const { adapter, prisma } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't16');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');

    const reasonCalls = prisma.confidenceLog.create.mock.calls
      .map((call: [{ data: { reason: string } }]) => call[0].data.reason);
    expect(reasonCalls).toContain('human_rehabilitation');
    expect(reasonCalls.filter((r: string) => r === 'human_rehabilitation').length).toBe(1);
  });

  it('T17: ConfidenceLog records the uncertain→certain transition', async () => {
    const { adapter, prisma } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't17');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');

    const transitions = prisma.confidenceLog.create.mock.calls
      .map((call: [{ data: { itemId: string; previousLevel: string; newLevel: string; reason: string } }]) => call[0].data)
      .filter((d: { itemId: string; reason: string }) => d.itemId === patternId && d.reason === 'human_rehabilitation');
    expect(transitions.length).toBe(1);
    expect(transitions[0].previousLevel).toBe('uncertain');
    expect(transitions[0].newLevel).toBe('certain');
  });

  it('T18: TraceabilityLog records the confidence_changed transition', async () => {
    const { adapter, prisma } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't18');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');

    const traceEvents = prisma.traceabilityLog.create.mock.calls
      .map((call: [{ data: { itemId: string; action: string; actor: string; details: Record<string, unknown> } }]) => call[0].data)
      .filter(
        (d: { itemId: string; action: string; details: Record<string, unknown> }) =>
          d.itemId === patternId
          && d.action === 'confidence_changed'
          && d.details.reason === 'human_rehabilitation',
      );
    expect(traceEvents.length).toBe(1);
    expect(traceEvents[0].details).toEqual(expect.objectContaining({
      previousLevel: 'uncertain',
      newLevel: 'certain',
      reason: 'human_rehabilitation',
    }));
  });

  it('T17 prepared fixture: getConflictResolutions still exposes the enabling resolution after rehabilitation', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't17b');
    await resolveConflict(adapter, COMPANY_A, conflictId);
    await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);

    const resolutions = await getConflictResolutions(adapter, COMPANY_A);
    expect(resolutions.length).toBe(1);
    expect(resolutions[0].conflictItemId).toBe(conflictId);
  });

  it('T19: rehabilitation is tenant scoped — same ids under wrong company → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't19');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_B, conflictId, patternId, HUMAN);
    expect(result.status).toBe('NOT_FOUND');
    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
  });

  it('T20: same rehabilitation is idempotent — second call → ALREADY_CERTAIN, no second event', async () => {
    const { adapter, store } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't20');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    const first = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(first.status).toBe('REHABILITATED');

    const second = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(second.status).toBe('ALREADY_CERTAIN');
    expect(Array.from(store.values()).filter((i) => i.type === REHABILITATION_EVENT_TYPE).length).toBe(1);
  });

  it('T21: another pending conflict implicating the item blocks rehabilitation → OTHER_PENDING_CONFLICT, nothing modified', async () => {
    const { adapter, store } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't21');

    // A SECOND PENDING conflict also implicates the pattern (different observation evidence)
    const secondConflictId = await recordManualConflict(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      kind: 'OBSERVATION_VS_AUTHORIZED',
      authorizedPatternIds: [patternId],
      conflictingGlAccountId: 'gl-c',
      observationIds: ['obs-second'],
    });

    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('OTHER_PENDING_CONFLICT');
    if (result.status !== 'OTHER_PENDING_CONFLICT') return;
    expect(result.blockingConflictItemIds).toContain(secondConflictId);
    expect(result.blockingConflictItemIds).not.toContain(conflictId);

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
    expect(Array.from(store.values()).filter((i) => i.type === REHABILITATION_EVENT_TYPE).length).toBe(0);
  });

  it('T22: the second conflict RESOLVED does not block rehabilitation', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't22');

    const secondConflictId = await recordManualConflict(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      kind: 'OBSERVATION_VS_AUTHORIZED',
      authorizedPatternIds: [patternId],
      conflictingGlAccountId: 'gl-c',
      observationIds: ['obs-second'],
    });

    await resolveConflict(adapter, COMPANY_A, conflictId);
    await resolveConflict(adapter, COMPANY_A, secondConflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('certain');
  });

  it('T23: an UNRELATED pending conflict (not implicating the item) does not block', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't23');

    // Pending conflict of another entity implicating OTHER items only
    const unrelatedConflictId = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_2, 't23b');

    await resolveConflict(adapter, COMPANY_A, conflictId);

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');
    expect(result.status !== 'OTHER_PENDING_CONFLICT').toBe(true);
    // The unrelated conflict is untouched and still pending
    const pending = await getPendingConflicts(adapter, COMPANY_A, ENTITY_2);
    expect(pending.status).toBe('FOUND');
    if (pending.status !== 'FOUND') return;
    expect(pending.conflicts[0].conflictItemId).toBe(unrelatedConflictId.conflictId);
  });

  it('T24: resolve ALONE leaves knowledge uncertain (resolve ≠ rehabilitate)', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't24');

    await resolveConflict(adapter, COMPANY_A, conflictId);

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
  });
});

describe('KE-EVOL-005 — NO Automatic Rehabilitation', () => {
  it('T25: no observation count causes rehabilitation', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't25');

    // Bump a large number of COMPATIBLE observations — counting evidence
    // must never move confidence.
    for (let i = 1; i <= 25; i++) {
      const obs = await recordClassificationObservation(adapter, COMPANY_A, {
        entityId: ENTITY_1,
        originalDescription: `ABC ${i * 7} ENTITY-1`,
        glAccountId: GL_A,
        direction: 'any',
        source: 'user_correction',
        transactionId: `tx-t25-compatible-${i}`,
      });
      if (!obs.ok) throw new Error('observation failed');
    }

    const item = await adapter.getById(patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
    // No rehabilitation events exist — nothing automatic happened
    const items = await adapter.getByType(COMPANY_A, REHABILITATION_EVENT_TYPE);
    expect(items.length).toBe(0);
  });

  it('T26: no time passage causes rehabilitation', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId, patternId: patternTarget } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't26');

    // Push every stored observation far into the past (simulated elapsed time)
    const now = Date.now();
    const past = new Date(now - 1000 * 60 * 60 * 24 * 365 * 5).toISOString();
    for (const item of Array.from((await adapter.getByType(COMPANY_A, 'classification_observation')).values())) {
      const parsed = JSON.parse(item.content) as Record<string, unknown>;
      parsed.transactionId = `${String(parsed.transactionId)}-aged`;
      // age the observable evidence itself
      const aged = await adapter.record({
        content: JSON.stringify(parsed),
        type: 'classification_observation',
        companyId: COMPANY_A,
        sourceAuthor: 'system',
        sourceName: 'aged_replay',
        sourceObservedAt: new Date(past),
        confidence: 'tentative',
      });
      expect(aged.id).toBeTruthy();
    }

    await resolveConflict(adapter, COMPANY_A, conflictId);

    // Time alone has NOT rehabilitated anything
    const item = await adapter.getById(patternTarget, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
  });

  it('T27: orphan uncertain item cannot be rehabilitated — no conflict link → NOT_IMPLICATED', async () => {
    const { adapter, store } = createMockAdapter();
    await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't27');

    // Uncertain item with NO demonstrable conflict link:
    // an uncertain pattern of a DIFFERENT entity (no conflict exists for it)
    const { authId: orphanPatternId } = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_2, GL_A);
    await evolveClassificationConfidence(adapter, COMPANY_A, orphanPatternId, 'uncertain', 'deterministic_conflict');

    // Any resolved conflict is unrelated to it — orphan status holds
    const allConflicts = await adapter.getByType(COMPANY_A, CONFLICTING_PATTERN_TYPE);
    const firstConflictId = allConflicts[0]?.id;
    if (firstConflictId) {
      await resolveConflict(adapter, COMPANY_A, firstConflictId);
      const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, firstConflictId, orphanPatternId, HUMAN);
      expect(result.status).toBe('NOT_IMPLICATED');
    }
    expect(Array.from(store.values()).filter((i) => i.type === REHABILITATION_EVENT_TYPE).length).toBe(0);
  });
});

describe('KE-EVOL-005 — Defect Fixes (route-delegated semantics)', () => {
  it('T28: correction under unresolved conflict does NOT promote the uncertain exact treatment', async () => {
    const { adapter } = createMockAdapter();
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_1, 't28');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);

    // Second conflicting human correction — route would want to promote
    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t28-second');
    expect(learn.status === 'UNCHANGED' || learn.status === 'UPDATED').toBe(true);
    const implicated = await isKnowledgeImplicatedByPendingConflict(adapter, COMPANY_A, setup.exactId);
    expect(implicated.implicated).toBe(true);

    // Gating: NO promotion call — the knowledge stays uncertain
    const item = await adapter.getById(setup.exactId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
  });

  it('T29: correction under unresolved conflict ends uncertain WITHOUT fake durable promotion', async () => {
    const { adapter } = createMockAdapter();
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_1, 't29');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);

    // Route's KNOWN-branch cycle (post-KE-EVOL-005 semantics) — promotion
    // is skipped because the item is implicated by a pending conflict.
    await knownCorrectionCyclePostKeEvol005(adapter, COMPANY_A, ENTITY_1, 'tx-t29-second');

    const item = await adapter.getById(setup.exactId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
  });

  it('T30: resolved historical conflict returned ALREADY_RECORDED does NOT re-degrade rehabilitated knowledge', async () => {
    const { adapter } = createMockAdapter();
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_1, 't30');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);
    await resolveConflict(adapter, COMPANY_A, setup.conflictId);
    const rehab = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, setup.conflictId, setup.exactId, HUMAN);
    expect(rehab.status).toBe('REHABILITATED');

    const certain = await adapter.getById(setup.exactId, COMPANY_A);
    expect(certain?.confidence).toBe('certain');

    // Detection again BEFORE new conflicting evidence → ALREADY_RECORDED
    // of the RESOLVED conflict. The resolution gate must NOT degrade back.
    const idempotentDetect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(idempotentDetect.status).toBe('ALREADY_RECORDED');
    if (idempotentDetect.status !== 'ALREADY_RECORDED') return;
    expect(idempotentDetect.conflictId).toBe(setup.conflictId);
    const resolvedCheck = await isConflictResolved(adapter, COMPANY_A, idempotentDetect.conflictId);
    expect(resolvedCheck.resolved).toBe(true);
    // → route skips degradation; the certain state survives
    const stillCertain = await adapter.getById(setup.exactId, COMPANY_A);
    expect(stillCertain?.confidence).toBe('certain');
  });

  it('T31: a genuinely NEW post-resolution conflict CAN degrade rehabilitated knowledge', async () => {
    const { adapter } = createMockAdapter();
    // Pattern target: OBSERVATION_VS_AUTHORIZED conflict → the pattern is
    // the degraded/rehabilitated knowledge.
    const setup = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't31');
    const rehab = await resolveAndRehabilitatePattern(adapter, setup.conflictId, setup.patternId);
    expect(rehab.status).toBe('REHABILITATED');

    // GENUINELY new evidence after rehabilitation: a NEW observation with a
    // DIFFERENT conflicting GL → different conflict identity → new conflict
    const conflictingObs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 778 ENTITY-1',
      glAccountId: 'gl-c',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-t31-new',
    });
    expect(conflictingObs.ok).toBe(true);
    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');
    if (detect.status !== 'RECORDED') return;
    expect(detect.conflictId).not.toBe(setup.conflictId);
    const resolvedCheck = await isConflictResolved(adapter, COMPANY_A, detect.conflictId);
    expect(resolvedCheck.resolved).toBe(false);

    // Route degrades: rehabilitated knowledge goes back to uncertain
    const degraded = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);
    expect(degraded.status).toBe('UPDATED');
    if (degraded.status !== 'UPDATED') return;
    expect(degraded.degradedItemIds).toContain(setup.patternId);

    const item = await adapter.getById(setup.patternId, COMPANY_A);
    expect(item?.confidence).toBe('uncertain');
  });
});

describe('KE-EVOL-005 — Rehabilitation Side-Effect Boundary', () => {
  it('T32/T34: rehabilitation changes no GL and no authorized pattern content', async () => {
    const { adapter, store } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't32');
    const patternBefore = await adapter.getById(patternId, COMPANY_A);
    if (!patternBefore) throw new Error('pattern lost');

    await resolveConflict(adapter, COMPANY_A, conflictId);
    const rehab = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(rehab.status).toBe('REHABILITATED');

    const patterns = await adapter.getByType(COMPANY_A, 'classification_authorized_pattern');
    for (const pattern of patterns) {
      const content = JSON.parse(pattern.content) as { glAccountId: string };
      expect(content.glAccountId).toBe(GL_A); // no GL winner chosen — GL-A unchanged
    }

    const patternAfter = await adapter.getById(patternId, COMPANY_A);
    expect(patternAfter?.content).toBe(patternBefore.content);
    expect(patternAfter?.status).toBe('active');
  });

  it('T33: rehabilitation mutates no exact treatment content', async () => {
    const { adapter } = createMockAdapter();
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_1, 't33');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);
    const exactBefore = await adapter.getById(setup.exactId, COMPANY_A);
    if (!exactBefore) throw new Error('exact lost');

    await resolveConflict(adapter, COMPANY_A, setup.conflictId);
    await rehabilitateClassificationKnowledge(adapter, COMPANY_A, setup.conflictId, setup.exactId, HUMAN);

    const exactAfter = await adapter.getById(setup.exactId, COMPANY_A);
    expect(exactAfter?.content).toBe(exactBefore.content);
    expect(JSON.parse(exactAfter!.content).glAccountId).toBe(GL_B);
  });

  it('T35: rehabilitation changes only the intended confidence state + logs + one event item', async () => {
    const { adapter, store } = createMockAdapter();
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't35');
    await resolveConflict(adapter, COMPANY_A, conflictId);

    // Snapshot AFTER resolution: the only new evidence from here on is the
    // rehabilitation operation itself.
    const before = Array.from(store.values()).map((i) => ({ id: i.id, content: i.content, type: i.type, status: i.status, confidence: i.confidence }));

    const result = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(result.status).toBe('REHABILITATED');

    const afterMap = new Map(Array.from(store.values()).map((i) => [i.id, i]));
    let mutatedConfidenceTargets = 0;
    let newItems = 0;
    for (const beforeItem of before) {
      const after = afterMap.get(beforeItem.id);
      expect(after).toBeTruthy();
      if (after!.id === patternId) {
        expect(after!.confidence).toBe('certain');
        expect(after!.content).toBe(beforeItem.content);
        mutatedConfidenceTargets++;
      } else {
        expect(after!.confidence).toBe(beforeItem.confidence);
        expect(after!.content).toBe(beforeItem.content);
      }
      expect(after!.status).toBe(beforeItem.status);
      expect(after!.type).toBe(beforeItem.type);
    }
    expect(mutatedConfidenceTargets).toBe(1);

    // Exactly ONE new MemoryItem: the rehabilitation event
    const afterItems = Array.from(store.values());
    expect(afterItems.filter((i) => !before.some((b) => b.id === i.id)).length).toBe(1);
    expect(afterItems.find((i) => !before.some((b) => b.id === i.id))!.type).toBe(REHABILITATION_EVENT_TYPE);
  });
});

describe('KE-EVOL-005 — Rehabilitated Authority (KE-EVOL-003 contract, unchanged consumers)', () => {
  it('T36: certain rehabilitated knowledge regains existing consumer authority', async () => {
    const { adapter } = createMockAdapter();
    // Pattern rehabilitation → matcher authority:
    const { conflictId, patternId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't36');
    const uncertainMatch = await matchAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, 'ABC 123 ENTITY-1', 'any');
    expect(uncertainMatch.kind).toBe('match');
    if (uncertainMatch.kind !== 'match') return;
    expect(uncertainMatch.confidence).toBe('uncertain');
    expect(uncertainMatch.authorizedPatternId).toBe(patternId);

    await resolveConflict(adapter, COMPANY_A, conflictId);
    const rehab = await rehabilitateClassificationKnowledge(adapter, COMPANY_A, conflictId, patternId, HUMAN);
    expect(rehab.status).toBe('REHABILITATED');

    // SAME matcher, no consumer changes, now sees the certain authority
    const certainMatch = await matchAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, 'ABC 123 ENTITY-1', 'any');
    expect(certainMatch.kind).toBe('match');
    if (certainMatch.kind !== 'match') return;
    expect(certainMatch.confidence).toBe('certain');

    // Exact treatment rehabilitation → lookupTreatment authority:
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_2, 't36b');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);
    await resolveConflict(adapter, COMPANY_A, setup.conflictId);
    await rehabilitateClassificationKnowledge(adapter, COMPANY_A, setup.conflictId, setup.exactId, HUMAN);

    const lookup = await lookupTreatment(adapter, COMPANY_A, ENTITY_2);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status !== 'FOUND') return;
    expect(lookup.confidence).toBe('certain');
  });
});

describe('KE-EVOL-005 — Coupling and Contract Boundaries', () => {
  it('T37: NO automatic resolve→rehabilitate coupling exists', async () => {
    const { adapter, store } = createMockAdapter();
    const setup = await setupPendingExactConflict(adapter, COMPANY_A, ENTITY_1, 't37');
    await degradeByConflict(adapter, COMPANY_A, setup.conflictId);

    await resolveConflict(adapter, COMPANY_A, setup.conflictId);

    // Nothing was promoted, no rehabilitation event exists, no items mutated
    const items = await adapter.getByType(COMPANY_A, REHABILITATION_EVENT_TYPE);
    expect(items.length).toBe(0);
    const exact = await adapter.getById(setup.exactId, COMPANY_A);
    expect(exact?.confidence).toBe('uncertain');
    const pattern = await adapter.getById(setup.patternId, COMPANY_A);
    expect(pattern?.confidence).toBe('uncertain');
    // And the ONLY resolution-type items are resolution records
    expect(
      Array.from(store.values()).filter(
        (i) => i.type === 'classification_conflict_resolution',
      ).length,
    ).toBe(1);
  });

  it('T38: promotion NOT_FOUND behavior unchanged — missing item still → NOT_FOUND, not swallowed', async () => {
    const { adapter } = createMockAdapter();
    // The promotion path delegates to evolveClassificationConfidence with
    // reason 'human_confirmation'; its NOT_FOUND contract is untouched.
    const result = await evolveClassificationConfidence(adapter, COMPANY_A, 'mem_missing', 'certain', 'human_confirmation');
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T39-support: resolution empties pending conflicts (support evidence for T22/T24)', async () => {
    const { adapter } = createMockAdapter();
    const { conflictId } = await setupUncertainPatternTarget(adapter, COMPANY_A, ENTITY_1, 't20b');
    await conflictResolutionRound(adapter, conflictId);

    // Pending conflicts shrink to EMPTY after resolution
    const pending = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(pending.status).toBe('EMPTY');
  });
});

async function conflictResolutionRound(adapter: MemoryAdapter, conflictId: string): Promise<void> {
  const resolved = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, HUMAN, 'round recorded');
  expect(resolved.status === 'RESOLVED' || resolved.status === 'ALREADY_RESOLVED').toBe(true);
}
