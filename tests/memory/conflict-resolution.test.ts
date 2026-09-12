// Knowledge Engine — Explicit Conflict Resolution Tests (KE-EVOL-004)
// A deterministic conflict is a verdict ("this divergence was detected"),
// NOT an accounting truth. Resolution records an EXPLICIT HUMAN decision:
//
//   IDENTIFIED (pending query exposes real conflict id)
//   → QUERIED (getPendingConflicts)
//   → EXPLICITLY RESOLVED BY HUMAN (resolveClassificationConflict)
//   → TRACEABLE (getConflictResolutions + untouched original evidence)
//
// Resolving a conflict does NOT rehabilitate knowledge: no confidence
// change, no winner, no GL modification. Rehabilitation is a separate,
// forbidden-by-default operation (FUTURE_REHABILITATION_REASON is out of
// scope for this block).
//
// Matrix:
//   T01 pending conflict exposes REAL conflictItemId (no derived id)
//   T02 resolution requires correct company scope
//   T03 cross-company resolution rejected (NOT_FOUND, no leak)
//   T04 nonexistent conflict → NOT_FOUND
//   T05 wrong MemoryItem type → NOT_FOUND
//   T06 resolvedBy required → ERROR, nothing persisted
//   T07 resolutionReason required → ERROR, nothing persisted
//   T08 pending conflict → RESOLVED
//   T09 second identical resolution → ALREADY_RESOLVED (idempotent)
//   T10 resolution preserves original conflict evidence byte-exactly
//   T11 resolution records actor/reason/time (traceability)
//   T12 resolved conflict disappears from pending query
//   T13 resolved conflict historically observable (getConflictResolutions)
//   T14 resolution changes no treatment confidence
//   T15 resolution changes no authorized pattern confidence
//   T16 resolution chooses no GL winner (no knowledge mutation)
//   T17 unrelated pending conflict remains pending
//   T18 tenant isolation of resolutions
//   T19 same unresolved conflict remains idempotent before resolution
//   T20 genuinely NEW post-resolution conflict is recorded, not swallowed
//   T21 characterization: promote→re-degrade fight (NOT fixed here)
//   T22 no automatic rehabilitation exists

import { describe, it, expect, vi } from 'vitest';
import {
  detectConflictingPattern,
  getPendingConflicts,
  getConflictResolutions,
  resolveClassificationConflict,
  recordClassificationObservation,
  learnEntityTreatment,
  degradeKnowledgeOnConflict,
  evolveClassificationConfidence,
  authorizeStructuralCandidate,
  recordStructuralCandidate,
  discoverStructuralCandidateForGroup,
  CONFLICTING_PATTERN_TYPE,
  CONFLICT_RESOLUTION_TYPE,
  AUTHORIZED_PATTERN_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey } from '../../src/memory/classification-knowledge';
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
    traceabilityLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    _store: store,
  };
}

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as unknown as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as unknown as MemoryPrismaClient, mockRunTx);
  return { adapter, store: mockPrisma._store };
}

// ─── Helpers ─────────────────────────────────────────────────────

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const ENTITY_1 = 'entity-1';
const ENTITY_2 = 'entity-2';
const GL_A = 'gl-a';
const GL_B = 'gl-b';

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

/** Conflicting observation + detection → persisted unresolved conflict. */
async function setupPendingConflict(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  transactionSuffix: string,
): Promise<string> {
  await setupAuthorizedPattern(adapter, companyId, entityId, GL_A);

  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `ABC 999 ${entityId}`,
    glAccountId: GL_B,
    direction: 'any',
    source: 'user_correction',
    transactionId: `tx ${transactionSuffix}`,
  });
  if (!obs.ok) throw new Error('Failed to record conflicting observation');

  const detect = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`expected RECORDED, got ${detect.status}`);
  return detect.conflictId;
}

/**
 * The EXACT flow copied from the route's KNOWN branch
 * (src/app/api/transactions/[id]/route.ts):
 *   learn → promote(certain, human_confirmation) →
 *   observe → detect → degrade (RECORDED | ALREADY_RECORDED).
 * The observation description deliberately does NOT structurally match the
 * authorized pattern segments, so the persisted conflict is
 * AUTHORIZED_VS_EXACT — the conflict kind whose degradation targets the
 * exact treatment (the promote→re-degrade fight driver, 21).
 */
async function knownCorrectionCycle(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  transactionId: string,
): Promise<void> {
  const learn = await learnEntityTreatment(adapter, companyId, entityId, GL_B, 'any', 'user_correction', transactionId);
  if (learn.status === 'CREATED' || learn.status === 'UNCHANGED') {
    await evolveClassificationConfidence(adapter, companyId, learn.itemId, 'certain', 'human_confirmation');
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
    await degradeKnowledgeOnConflict(adapter, companyId, conflict.conflictId);
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('KE-EVOL-004 — Conflict Resolution Foundation', () => {
  it('T01: pending conflict exposes the REAL conflictItemId (detect.conflictId)', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't01');

    const result = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(result.status).toBe('FOUND');
    if (result.status !== 'FOUND') return;
    expect(result.conflicts.length).toBe(1);
    // Real MemoryItem id — not a derived id, array index, or hash
    expect(result.conflicts[0].conflictItemId).toBe(conflictId);
    expect(result.conflicts[0].content.kind).toBe('OBSERVATION_VS_AUTHORIZED');
  });

  it('T02: resolution is company-scoped — pending conflict only resolvable under its own company', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't02');

    // Wrong company → NOT_FOUND, no resolution written
    const foreign = await resolveClassificationConflict(adapter, COMPANY_B, conflictId, 'admin', 'other scope');
    expect(foreign.status).toBe('NOT_FOUND');
    expect(Array.from(store.values()).filter((i) => i.type === CONFLICT_RESOLUTION_TYPE).length).toBe(0);
    // Still pending
    const pending = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(pending.status).toBe('FOUND');
    if (pending.status !== 'FOUND') return;
    expect(pending.conflicts[0].conflictItemId).toBe(conflictId);

    // Correct company succeeds
    const result = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'pattern wins');
    expect(result.status).toBe('RESOLVED');
  });

  it('T03: cross-company resolution rejected without existence leak', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't03');

    const result = await resolveClassificationConflict(adapter, COMPANY_B, conflictId, 'admin', 'foreign admin');
    expect(result.status).toBe('NOT_FOUND');
    // No resolution persisted anywhere
    expect(Array.from(store.values()).filter((i) => i.type === CONFLICT_RESOLUTION_TYPE).length).toBe(0);
  });

  it('T04: nonexistent conflict → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();

    const result = await resolveClassificationConflict(adapter, COMPANY_A, 'mem_does_not_exist', 'admin', 'reason');
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T05: wrong MemoryItem type → NOT_FOUND', async () => {
    const { adapter } = createMockAdapter();
    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx-t05');
    if (learn.status !== 'CREATED') throw new Error('learn failed');

    // A classification item is NOT a conflict item
    const result = await resolveClassificationConflict(adapter, COMPANY_A, learn.itemId, 'admin', 'reason');
    expect(result.status).toBe('NOT_FOUND');
  });

  it('T06: blank resolvedBy → ERROR, nothing persisted', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't06');

    const empty = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, '', 'reason');
    expect(empty.status).toBe('ERROR');
    const blank = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, '   ', 'reason');
    expect(blank.status).toBe('ERROR');

    expect(Array.from(store.values()).filter((i) => i.type === CONFLICT_RESOLUTION_TYPE).length).toBe(0);
  });

  it('T07: blank resolutionReason → ERROR, nothing persisted', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't07');

    const empty = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', '');
    expect(empty.status).toBe('ERROR');
    const blank = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', '  ');
    expect(blank.status).toBe('ERROR');

    expect(Array.from(store.values()).filter((i) => i.type === CONFLICT_RESOLUTION_TYPE).length).toBe(0);
  });

  it('T08: pending conflict → RESOLVED', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't08');

    const result = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'GL-A confirmed by supervisor');
    expect(result.status).toBe('RESOLVED');
    if (result.status !== 'RESOLVED') return;
    expect(result.conflictItemId).toBe(conflictId);
    expect(result.resolutionId).toBeTruthy();
  });

  it('T09: second identical resolution → ALREADY_RESOLVED, same resolution id', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't09');

    const first = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'reason');
    expect(first.status).toBe('RESOLVED');

    const second = await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'other-admin', 'second attempt');
    expect(second.status).toBe('ALREADY_RESOLVED');
    if (first.status !== 'RESOLVED' || second.status !== 'ALREADY_RESOLVED') return;
    expect(second.resolutionId).toBe(first.resolutionId);
    expect(second.conflictItemId).toBe(conflictId);
    // exactly one resolution record for this conflict
    expect(Array.from(store.values()).filter((i) => i.type === CONFLICT_RESOLUTION_TYPE).length).toBe(1);
  });

  it('T10: resolution preserves original conflict evidence untouched', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't10');

    const before = await adapter.getById(conflictId, COMPANY_A);
    if (!before) throw new Error('conflict lost');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'accepted GL-A');

    const after = await adapter.getById(conflictId, COMPANY_A);
    if (!after) throw new Error('conflict lost');
    // No mutation of the historical conflict item: content byte-equal,
    // status and confidence untouched
    expect(after.content).toBe(before.content);
    expect(after.status).toBe('active');
    expect(after.confidence).toBe(before.confidence);
    expect(after.type).toBe(CONFLICTING_PATTERN_TYPE);
  });

  it('T11: resolution records actor/reason/time', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't11');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'supervisor-7', 'GL-A verified against invoice');

    const resolutions = await getConflictResolutions(adapter, COMPANY_A);
    expect(resolutions.length).toBe(1);
    expect(resolutions[0].conflictItemId).toBe(conflictId);
    expect(resolutions[0].companyId).toBe(COMPANY_A);
    expect(resolutions[0].resolvedBy).toBe('supervisor-7');
    expect(resolutions[0].resolutionReason).toBe('GL-A verified against invoice');
    expect(resolutions[0].resolvedAt).toBeTruthy();
    // ISO-8601
    expect(() => new Date(resolutions[0].resolvedAt).toISOString()).not.toThrow();
  });

  it('T12: resolved conflict disappears from pending query', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't12');

    const before = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(before.status).toBe('FOUND');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'reason');

    const after = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(after.status).toBe('EMPTY');
  });

  it('T13: resolved conflict remains historically observable', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't13');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'decision logged');

    // Conflict item itself still persisted and readable
    const conflictItem = Array.from(store.values()).find((i) => i.id === conflictId);
    expect(conflictItem).toBeTruthy();
    expect(conflictItem!.type).toBe(CONFLICTING_PATTERN_TYPE);

    // Resolution record observable for later what/who/when/why demonstration
    const resolutions = await getConflictResolutions(adapter, COMPANY_A);
    expect(resolutions.length).toBe(1);
    expect(resolutions[0].conflictItemId).toBe(conflictId);
  });

  it('T14: resolution changes no treatment confidence', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't14');

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t14');
    if (learn.status !== 'CREATED') throw new Error('learn failed');
    const exactBefore = await adapter.getById(learn.itemId, COMPANY_A);
    if (!exactBefore) throw new Error('exact treatment lost');
    const confidenceBefore = exactBefore.confidence;

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'reason');

    const exactAfter = await adapter.getById(learn.itemId, COMPANY_A);
    expect(exactAfter?.confidence).toBe(confidenceBefore);
  });

  it('T15: resolution changes no authorized pattern confidence', async () => {
    const { adapter } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't15');

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, conflictId);
    expect(degrade.status).toBe('UPDATED');

    const patternsBefore = await adapter.getByType(COMPANY_A, AUTHORIZED_PATTERN_TYPE);
    const confidenceBefore = patternsBefore.map((p) => ({ id: p.id, confidence: p.confidence }));

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'reason');

    const patternsAfter = await adapter.getByType(COMPANY_A, AUTHORIZED_PATTERN_TYPE);
    expect(patternsAfter.map((p) => ({ id: p.id, confidence: p.confidence }))).toEqual(confidenceBefore);
  });

  it('T16: resolution chooses no GL winner (does not modify any GL)', async () => {
    const { adapter, store } = createMockAdapter();
    const conflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't16');

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t16');
    if (learn.status !== 'CREATED') throw new Error('learn failed');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictId, 'admin', 'kept both as-is');

    // Authorized pattern still proposes GL-A
    const patterns = await adapter.getByType(COMPANY_A, AUTHORIZED_PATTERN_TYPE);
    for (const pattern of patterns) {
      const content = JSON.parse(pattern.content) as { glAccountId: string };
      expect(content.glAccountId).toBe(GL_A);
    }
    // Exact treatment still proposes GL-B
    const allClassifications = await adapter.getByType(COMPANY_A, 'classification');
    const exactItem = Array.from(store.values()).find((i) => i.id === learn.itemId);
    expect(exactItem).toBeTruthy();
    expect(exactItem!.content).toBe(allClassifications.find((c) => c.id === learn.itemId)?.content);
    expect(JSON.parse(exactItem!.content).glAccountId).toBe(GL_B);
  });

  it('T17: unrelated pending conflict remains pending after resolving one', async () => {
    const { adapter } = createMockAdapter();
    const conflictA = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't17-a');
    const conflictB = await setupPendingConflict(adapter, COMPANY_A, ENTITY_2, 't17-b');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictA, 'admin', 'entity1 is fine');

    const pending = await getPendingConflicts(adapter, COMPANY_A);
    expect(pending.status).toBe('FOUND');
    if (pending.status !== 'FOUND') return;
    expect(pending.conflicts.length).toBe(1);
    expect(pending.conflicts[0].conflictItemId).toBe(conflictB);
    expect(pending.conflicts[0].content.entityId).toBe(ENTITY_2);
  });

  it('T18: tenant isolation — resolutions of company A invisible to company B', async () => {
    const { adapter } = createMockAdapter();
    const conflictA = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't18-a');
    await setupPendingConflict(adapter, COMPANY_B, ENTITY_1, 't18-b');

    await resolveClassificationConflict(adapter, COMPANY_A, conflictA, 'admin', 'A only');

    // B still sees its own unresolved conflict
    const pendingB = await getPendingConflicts(adapter, COMPANY_B, ENTITY_1);
    expect(pendingB.status).toBe('FOUND');
    // B has no resolutions
    const resolutionsB = await getConflictResolutions(adapter, COMPANY_B);
    expect(resolutionsB.length).toBe(0);
    // A has exactly one
    const resolutionsA = await getConflictResolutions(adapter, COMPANY_A);
    expect(resolutionsA.length).toBe(1);
  });

  it('T19: same unresolved conflict remains idempotent before resolution', async () => {
    const { adapter } = createMockAdapter();
    await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't19');

    // No new evidence since first detection → ALREADY_RECORDED, not a second item
    const second = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(second.status).toBe('ALREADY_RECORDED');
  });

  it('T20: genuinely NEW post-resolution conflict is recorded, not swallowed', async () => {
    const { adapter } = createMockAdapter();
    const resolvedConflictId = await setupPendingConflict(adapter, COMPANY_A, ENTITY_1, 't20');

    await resolveClassificationConflict(adapter, COMPANY_A, resolvedConflictId, 'admin', 'kept GL-A for now');

    // Genuinely new evidence: a NEW transaction contradicts the pattern AFTER resolution
    const newObs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 777 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-t20-new',
    });
    expect(newObs.ok).toBe(true);

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');
    if (detect.status !== 'RECORDED') return;
    // New conflict item — NOT the already-resolved one
    expect(detect.conflictId).not.toBe(resolvedConflictId);

    const pending = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(pending.status).toBe('FOUND');
    if (pending.status !== 'FOUND') return;
    expect(pending.conflicts.length).toBe(1);
    expect(pending.conflicts[0].conflictItemId).toBe(detect.conflictId);
  });

  it('T21: PROMOTE→RE-DEGRADE under unresolved conflict ends uncertain (promote→re-degrade fight — eliminated in KE-EVOL-005: promotion is now GATED under pending conflicts, so the same expectations below still hold)', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // First KNOWN-branch correction: learn → promote → observe → detect → degrade
    await knownCorrectionCycle(adapter, COMPANY_A, ENTITY_1, 'tx-t21-first');
    const conflict = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    if (conflict.status !== 'FOUND') throw new Error('expected persisted conflict');
    expect(conflict.conflicts.length).toBe(1);

    const exactTreatments = await adapter.getByType(COMPANY_A, 'classification');
    const exactId = exactTreatments[0].id;
    const exactAfterFirst = await adapter.getById(exactId, COMPANY_A);
    if (!exactAfterFirst) throw new Error('exact treatment lost');

    // Second SAME conflicting human correction (same GL-B): route promotes
    // to certain, then the ALREADY_RECORDED unresolved conflict degrades it
    // back in the same request.
    await knownCorrectionCycle(adapter, COMPANY_A, ENTITY_1, 'tx-t21-second');

    const exactAfterSecond = await adapter.getById(exactId, COMPANY_A);
    expect(exactAfterSecond?.confidence).toBe('uncertain');

    // The conflict is still unresolved and still degrades: the human
    // correction can NEVER durably rehabilitate while the conflict is open.
    const pendingAfter = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    if (pendingAfter.status !== 'FOUND') throw new Error('expected unresolved conflict still pending');
    await degradeKnowledgeOnConflict(adapter, COMPANY_A, pendingAfter.conflicts[0].conflictItemId);
    const exactFinally = await adapter.getById(exactId, COMPANY_A);
    expect(exactFinally?.confidence).toBe('uncertain');
  });

  it('T22: NO automatic rehabilitation — detect+degrade+resolve leaves knowledge uncertain and untouched', async () => {
    const { adapter } = createMockAdapter();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx-t22');
    if (learn.status !== 'CREATED') throw new Error('learn failed');
    const exactId = learn.itemId;

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    if (detect.status !== 'RECORDED') throw new Error(`expected RECORDED, got ${detect.status}`);
    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);
    expect(degrade.status).toBe('UPDATED');

    // Explicit resolution of the conflict does NOT rehabilitate anything
    await resolveClassificationConflict(adapter, COMPANY_A, detect.conflictId, 'admin', 'human decision recorded');

    const exactAfter = await adapter.getById(exactId, COMPANY_A);
    expect(exactAfter?.confidence).toBe('uncertain');

    // Nothing was automatically promoted to certain by the resolution
    const allClassifications = await adapter.getByType(COMPANY_A, 'classification');
    for (const item of allClassifications) {
      if (JSON.parse(item.content).entityId === ENTITY_1) {
        expect(item.confidence).toBe('uncertain');
      }
    }
  });
});
