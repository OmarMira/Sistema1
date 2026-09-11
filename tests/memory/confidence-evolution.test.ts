// Knowledge Engine — Confidence Evolution Tests (KE-EVOL-002)
// Deterministic confidence evolution through the EXISTING C11
// infrastructure (updateConfidence → ConfidenceLog + TraceabilityLog).
// No scoring, no thresholds, no counts, no automatic rehabilitation.

import { describe, it, expect, vi } from 'vitest';
import {
  evolveClassificationConfidence,
  degradeKnowledgeOnConflict,
  learnEntityTreatment,
  recordClassificationObservation,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
  discoverStructuralCandidateForGroup,
  detectConflictingPattern,
  AUTHORIZED_PATTERN_TYPE,
  STRUCTURAL_CANDIDATE_TYPE,
  OBSERVATION_TYPE,
  CONFLICTING_PATTERN_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client (real C11 path through service) ──────────

type ConfidenceLogRow = {
  itemId: string;
  previousLevel: string;
  newLevel: string;
  reason: string;
};

type TraceLogRow = {
  itemId: string;
  action: string;
  details: unknown;
};

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
  const confidenceLogs: ConfidenceLogRow[] = [];
  const traceLogs: TraceLogRow[] = [];
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
      create: vi.fn(async (args: { data: { itemId: string; action: string; details: Record<string, unknown> } }) => {
        traceLogs.push({
          itemId: args.data.itemId,
          action: args.data.action,
          details: args.data.details,
        });
        return {};
      }),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: {
      create: vi.fn(async (args: { data: { itemId: string; previousLevel: string; newLevel: string; reason: string } }) => {
        confidenceLogs.push({
          itemId: args.data.itemId,
          previousLevel: args.data.previousLevel,
          newLevel: args.data.newLevel,
          reason: args.data.reason,
        });
        return {};
      }),
      findMany: vi.fn(async () => []),
    },
    _store: store,
    _confidenceLogs: confidenceLogs,
    _traceLogs: traceLogs,
  };
}

function createKeharness() {
  const prisma = createMockPrisma();
  const runTx: TransactionRunner = async (fn) => fn(prisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(prisma as MemoryPrismaClient, runTx);
  return { adapter, prisma, store: prisma._store };
}

// ─── Helpers ─────────────────────────────────────────────────────

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const ENTITY_1 = 'entity-1';
const GL_A = 'gl-a';
const GL_B = 'gl-b';

/** Authorized pattern shape: [stable 'abc', variable, stable entityId]. */
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
  if (discovery.kind !== 'candidate') throw new Error(`discovery failed: ${discovery.reason}`);

  const candidate = await recordStructuralCandidate(adapter, discovery.candidate);
  if (!candidate.ok) throw new Error('record candidate failed');

  const auth = await authorizeStructuralCandidate(adapter, companyId, candidate.candidateId, 'admin');
  if (auth.status !== 'AUTHORIZED' && auth.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`authorize failed: ${auth.status}`);
  }

  return { candidateId: candidate.candidateId, authId: auth.authorizedPatternId };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('KE-EVOL-002 — Confidence Evolution (C11 reused)', () => {
  // T1: exact treatment tentative + human confirmation → certain UPDATED
  it('T1: tentative → certain via human_confirmation (UPDATED)', async () => {
    const { adapter, prisma } = createKeharness();

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx1');
    if (learn.status !== 'CREATED') throw new Error(`expected CREATED, got ${learn.status}`);

    const result = await evolveClassificationConfidence(
      adapter, COMPANY_A, learn.itemId, 'certain', 'human_confirmation',
    );

    expect(result.status).toBe('UPDATED');
    if (result.status !== 'UPDATED') return;
    expect(result.previousConfidence).toBe('tentative');
    expect(result.newConfidence).toBe('certain');

    expect(prisma._confidenceLogs).toEqual([
      {
        itemId: learn.itemId,
        previousLevel: 'tentative',
        newLevel: 'certain',
        reason: 'human_confirmation',
      },
    ]);

    const confidenceChangeLogs = prisma._traceLogs.filter((l) => l.action === 'confidence_changed');
    expect(confidenceChangeLogs.length).toBe(1);
    expect(confidenceChangeLogs[0].itemId).toBe(learn.itemId);
    expect(JSON.stringify(confidenceChangeLogs[0].details)).toContain('human_confirmation');

    const item = await adapter.getById(learn.itemId, COMPANY_A);
    if (!item) throw new Error('item lost');
    expect(item.confidence).toBe('certain');
  });

  // T2: already certain + new confirmation → UNCHANGED, no new logs
  it('T2: already certain → UNCHANGED and no new log rows', async () => {
    const { adapter, prisma } = createKeharness();

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx1');
    if (learn.status !== 'CREATED') throw new Error(`${learn.status}`);

    await evolveClassificationConfidence(adapter, COMPANY_A, learn.itemId, 'certain', 'human_confirmation');
    const confidenceLogsBefore = prisma._confidenceLogs.length;
    const traceBefore = prisma._traceLogs.filter((l) => l.action === 'confidence_changed').length;

    const again = await evolveClassificationConfidence(
      adapter, COMPANY_A, learn.itemId, 'certain', 'human_confirmation',
    );

    expect(again.status).toBe('UNCHANGED');
    if (again.status !== 'UNCHANGED') return;
    expect(again.confidence).toBe('certain');
    expect(prisma._confidenceLogs.length).toBe(confidenceLogsBefore);
    expect(prisma._traceLogs.filter((l) => l.action === 'confidence_changed').length).toBe(traceBefore);
  });

  // T3: compatible evidence does NOT change confidence
  it('T3: compatible evidence → confidence unchanged', async () => {
    const { adapter, prisma } = createKeharness();

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx3');
    if (learn.status !== 'CREATED') throw new Error(`${learn.status}`);
    await evolveClassificationConfidence(adapter, COMPANY_A, learn.itemId, 'certain', 'human_confirmation');

    // Compatible evidence against an authorized pattern with the same GL
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('NO_CONFLICT');

    // Confidence untouched; only the one promotion log exists
    const item = await adapter.getById(learn.itemId, COMPANY_A);
    if (!item) throw new Error('item lost');
    expect(item.confidence).toBe('certain');
    expect(prisma._confidenceLogs.length).toBe(1);
  });

  // T4: OBSERVATION_VS_AUTHORIZED → authorized pattern certain → uncertain
  it('T4: OBSERVATION_VS_AUTHORIZED degrades the contradicted pattern (reason deterministic_conflict)', async () => {
    const { adapter, prisma } = createKeharness();
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const patternItem = await adapter.getById(setup.authId, COMPANY_A);
    if (!patternItem) throw new Error('pattern lost');
    expect(patternItem.confidence).toBe('certain');

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-t4',
    });

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');
    if (detect.status !== 'RECORDED') return;
    expect(detect.kind).toBe('OBSERVATION_VS_AUTHORIZED');

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);
    expect(degrade.status).toBe('UPDATED');
    if (degrade.status !== 'UPDATED') return;
    expect(degrade.degradedItemIds).toContain(setup.authId);

    const after = await adapter.getById(setup.authId, COMPANY_A);
    if (!after) throw new Error('pattern lost after degrade');
    expect(after.confidence).toBe('uncertain');
    expect(after.status).toBe('active'); // item is NOT invalidated

    const conflictLogs = prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict');
    expect(conflictLogs.length).toBe(1);
    expect(conflictLogs[0].previousLevel).toBe('certain');
    expect(conflictLogs[0].newLevel).toBe('uncertain');
    expect(conflictLogs[0].itemId).toBe(setup.authId);
    const traceConflicts = prisma._traceLogs.filter((l) => l.action === 'confidence_changed');
    expect(JSON.stringify(traceConflicts[traceConflicts.length - 1].details)).toContain('deterministic_conflict');
  });

  // T5: AUTHORIZED_VS_EXACT → BOTH pattern and THE implicated exact treatment
  it('T5: AUTHORIZED_VS_EXACT degrades pattern AND exactly the implicated exact item', async () => {
    const { adapter, prisma } = createKeharness();
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Exact treatment: created tentative, promoted by the confirmed correction
    const learnA = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx5a');
    if (learnA.status !== 'CREATED') throw new Error(`${learnA.status}`);
    await evolveClassificationConfidence(adapter, COMPANY_A, learnA.itemId, 'certain', 'human_confirmation');

    // A DIFFERENT entity's exact treatment exists and must NOT be degraded
    const otherLearn = await learnEntityTreatment(adapter, COMPANY_A, 'entity-other', GL_A, 'any', 'user_correction', 'tx5-other');
    if (otherLearn.status !== 'CREATED') throw new Error(`${otherLearn.status}`);
    await evolveClassificationConfidence(adapter, COMPANY_A, otherLearn.itemId, 'certain', 'human_confirmation');

    // The exact treatment evolves to GL-B (the audited divergence case)
    const learnB = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx5b');
    if (learnB.status !== 'UPDATED') throw new Error(`${learnB.status}`);

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');
    if (detect.status !== 'RECORDED') return;
    expect(detect.kind).toBe('AUTHORIZED_VS_EXACT');

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);
    expect(degrade.status).toBe('UPDATED');
    if (degrade.status !== 'UPDATED') return;
    expect(degrade.degradedItemIds).toContain(setup.authId);
    expect(degrade.degradedItemIds).toContain(learnB.itemId);
    // The OTHER entity's treatment is NOT touched
    expect(degrade.degradedItemIds).not.toContain(otherLearn.itemId);

    const pattern = await adapter.getById(setup.authId, COMPANY_A);
    const exact = await adapter.getById(learnB.itemId, COMPANY_A);
    const other = await adapter.getById(otherLearn.itemId, COMPANY_A);
    if (!pattern || !exact || !other) throw new Error('items lost');
    expect(pattern.confidence).toBe('uncertain');
    expect(exact.confidence).toBe('uncertain');
    expect(other.confidence).toBe('certain');

    // No winner was chosen — neither item was invalidated
    expect(pattern.status).toBe('active');
    expect(exact.status).toBe('active');
    expect(prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict').length).toBe(2);
  });

  // T6: AUTHORIZED_VS_AUTHORIZED → every participating pattern → uncertain
  it('T6: AUTHORIZED_VS_AUTHORIZED degrades all participating patterns', async () => {
    const { adapter, prisma } = createKeharness();
    const setupA = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Second OVERLAPPING pattern (same stable tokens) with different GL
    for (let i = 1; i <= 2; i++) {
      const obs = await recordClassificationObservation(adapter, COMPANY_A, {
        entityId: ENTITY_1,
        originalDescription: `ABC ${i * 777} ENTITY-1`,
        glAccountId: GL_B,
        direction: 'any',
        source: 'user_correction',
        transactionId: `tx6-second-${i}`,
      });
      if (!obs.ok) throw new Error('second obs failed');
    }
    const groupB: StructuralGroupKey = { companyId: COMPANY_A, entityId: ENTITY_1, glAccountId: GL_B, direction: 'any' };
    const discB = await discoverStructuralCandidateForGroup(adapter, groupB);
    if (discB.kind !== 'candidate') throw new Error(`discB: ${discB.reason}`);
    const candB = await recordStructuralCandidate(adapter, discB.candidate);
    if (!candB.ok) throw new Error('candB failed');

    const content = {
      companyId: COMPANY_A,
      entityId: ENTITY_1,
      glAccountId: GL_B,
      direction: 'any' as const,
      segments: discB.candidate.segments,
      sourceCandidateId: candB.candidateId,
      observationIds: discB.candidate.observationIds,
      authorizedBy: 'admin',
      authorizedAt: new Date().toISOString(),
    };
    const secondItem = await adapter.record({
      content: JSON.stringify(content),
      type: AUTHORIZED_PATTERN_TYPE,
      companyId: COMPANY_A,
      sourceAuthor: 'admin',
      sourceName: 'pattern_authorization',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });

    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(detect.status).toBe('RECORDED');
    if (detect.status !== 'RECORDED') return;
    expect(detect.kind).toBe('AUTHORIZED_VS_AUTHORIZED');

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);
    expect(degrade.status).toBe('UPDATED');
    if (degrade.status !== 'UPDATED') return;
    expect(degrade.degradedItemIds).toContain(setupA.authId);
    expect(degrade.degradedItemIds).toContain(secondItem.id);

    // No winner was chosen — both remain active and both are degraded
    expect(prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict').length).toBe(2);
  });

  // T7: repeated conflict → ALREADY_RECORDED, uncertain stays, NO new logs
  it('T7: repeated conflict is idempotent (no new ConfidenceLog)', async () => {
    const { adapter, prisma } = createKeharness();
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx7',
    });

    const first = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(first.status).toBe('RECORDED');
    if (first.status !== 'RECORDED') return;
    const firstDegrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, first.conflictId);
    expect(firstDegrade.status).toBe('UPDATED');

    const conflictLogsAfterFirst = prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict').length;

    const second = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(second.status).toBe('ALREADY_RECORDED');
    if (second.status !== 'ALREADY_RECORDED') return;
    const secondDegrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, second.conflictId);
    expect(secondDegrade.status).toBe('UNCHANGED');

    expect(prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict').length).toBe(conflictLogsAfterFirst);
  });

  // T10/T11: the two deterministic reason values exist and are distinct
  it('T10/T11: reasons human_confirmation and deterministic_conflict are auditable and distinct', async () => {
    const { adapter, prisma } = createKeharness();

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx10');
    if (learn.status !== 'CREATED') throw new Error(`${learn.status}`);

    const promo = await evolveClassificationConfidence(
      adapter, COMPANY_A, learn.itemId, 'certain', 'human_confirmation',
    );
    expect(promo.status).toBe('UPDATED');

    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx10-conflict',
    });
    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    if (detect.status !== 'RECORDED') throw new Error(`${detect.status}`);
    await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);

    expect(prisma._confidenceLogs.some((l) => l.reason === 'human_confirmation')).toBe(true);
    expect(prisma._confidenceLogs.some((l) => l.reason === 'deterministic_conflict')).toBe(true);
  });

  // T12: tenant isolation — only companyId varies
  it('T12: cross-company evolve is NOT_FOUND; company A never touches company B', async () => {
    const { adapter, prisma } = createKeharness();

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx12');
    if (learn.status !== 'CREATED') throw new Error(`${learn.status}`);

    const result = await evolveClassificationConfidence(
      adapter, COMPANY_B, learn.itemId, 'certain', 'human_confirmation',
    );

    expect(result.status).toBe('NOT_FOUND');

    // Company A item remains exactly as it was
    const item = await adapter.getById(learn.itemId, COMPANY_A);
    if (!item) throw new Error('item lost');
    expect(item.confidence).toBe('tentative');
    expect(prisma._confidenceLogs.length).toBe(0);
  });

  // T13: NOT_FOUND explicit (nonexistent item / nonexistent conflict)
  it('T13: NOT_FOUND for nonexistent item and nonexistent conflict', async () => {
    const { adapter, prisma } = createKeharness();

    const evolve = await evolveClassificationConfidence(
      adapter, COMPANY_A, 'mem_nonexistent', 'certain', 'human_confirmation',
    );
    expect(evolve.status).toBe('NOT_FOUND');

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, 'mem_nonexistent');
    expect(degrade.status).toBe('NOT_FOUND');
    expect(prisma._confidenceLogs.length).toBe(0);
  });

  // T14: adapter failure → ERROR (never UNCHANGED, never silent)
  it('T14: adapter failure → ERROR for both operations', async () => {
    const prisma = createMockPrisma();
    prisma.memoryItem.findFirst.mockRejectedValue(new Error('DB_DOWN'));
    prisma.memoryItem.findMany.mockRejectedValue(new Error('DB_DOWN'));
    const runTx: TransactionRunner = async (fn) => fn(prisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
    const adapter = new MemoryAdapter(prisma as MemoryPrismaClient, runTx);

    const evolve = await evolveClassificationConfidence(
      adapter, COMPANY_A, 'mem_1', 'certain', 'human_confirmation',
    );
    expect(evolve.status).toBe('ERROR');

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, 'mem_1');
    expect(degrade.status).toBe('ERROR');
  });

  // T19: authorized pattern born certain; T22: conflict item stays tentative
  it('T19/T22: authorization born certain; conflict item NOT auto-promoted', async () => {
    const { adapter } = createKeharness();

    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);
    const pattern = await adapter.getById(setup.authId, COMPANY_A);
    if (!pattern) throw new Error('pattern lost');
    expect(pattern.confidence).toBe('certain');

    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx19',
    });
    const detect = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    if (detect.status !== 'RECORDED') throw new Error(`${detect.status}`);
    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detect.conflictId);
    expect(degrade.status).toBe('UPDATED');

    // The conflict item itself was NOT degraded and NOT promoted
    const conflict = await getPendingConflictsSafe(adapter);
    expect(conflict.kind).toBe('OBSERVATION_VS_AUTHORIZED');
    const all = await adapter.getByType(COMPANY_A, CONFLICTING_PATTERN_TYPE);
    expect(all.length).toBe(1);
    expect(all[0].confidence).toBe('tentative');
  });

  // T20: structural candidate born tentative
  it('T20: structural candidate born tentative', async () => {
    const { adapter } = createKeharness();

    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    const candidates = await adapter.getByType(COMPANY_A, STRUCTURAL_CANDIDATE_TYPE);
    expect(candidates.length).toBe(1);
    expect(candidates[0].confidence).toBe('tentative');
  });

  // T21: observation born tentative
  it('T21: observation born tentative', async () => {
    const { adapter } = createKeharness();

    const obs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 111 ENTITY-1',
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx21',
    });
    expect(obs.ok).toBe(true);

    const observations = await adapter.getByType(COMPANY_A, OBSERVATION_TYPE);
    expect(observations.length).toBe(1);
    expect(observations[0].confidence).toBe('tentative');
  });

  // T23: no automatic promotion from compatible evidence
  it('T23: compatible evidence never promotes any knowledge item', async () => {
    const { adapter, prisma, store } = createKeharness();

    const learn = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx23');
    if (learn.status !== 'CREATED') throw new Error(`${learn.status}`);

    // Compatible evidence recorded — no operation changes confidence
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 555 ENTITY-1',
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx23-obs',
    });

    // Zero confidence logs and zero confidence_changed trace logs
    expect(prisma._confidenceLogs.length).toBe(0);
    expect(prisma._traceLogs.filter((l) => l.action === 'confidence_changed').length).toBe(0);

    // Item still tentative — only explicit human confirmation could change it
    const items = Array.from(store.values()).filter((i) => i.type === 'classification');
    expect(items.every((i) => i.confidence === 'tentative')).toBe(true);
  });

  // T24: no automatic rehabilitation — uncertain + compatible evidence stays uncertain
  it('T24: uncertain + new compatible evidence → uncertain (no rehabilitation)', async () => {
    const { adapter, prisma } = createKeharness();

    // Degrade the authorized pattern first
    await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 999 ENTITY-1',
      glAccountId: GL_B,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx24-conflict',
    });
    const detectFirst = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    if (detectFirst.status !== 'RECORDED') throw new Error(`${detectFirst.status}`);
    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, detectFirst.conflictId);
    if (degrade.status !== 'UPDATED') throw new Error(`${degrade.status}`);

    const patterns = await adapter.getByType(COMPANY_A, AUTHORIZED_PATTERN_TYPE);
    expect(patterns[0].confidence).toBe('uncertain');
    const conflictLogsAfterDegrade = prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict').length;

    // NEW compatible evidence arrives
    await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: ENTITY_1,
      originalDescription: 'ABC 555 ENTITY-1',
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx24-compatible',
    });
    const detectSecond = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');

    // Detection finds the ALREADY-persisted conflict only — no new conflict,
    // no rehabilitation, no new logs, and confidence stays uncertain
    expect(detectSecond.status).toBe('ALREADY_RECORDED');
    expect(prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict').length).toBe(conflictLogsAfterDegrade);

    const patternsAfter = await adapter.getByType(COMPANY_A, AUTHORIZED_PATTERN_TYPE);
    expect(patternsAfter[0].confidence).toBe('uncertain');
    expect(patternsAfter[0].status).toBe('active');
  });

  // Precision against TWO distinguishable exact treatments of the SAME entity:
  // the write path (learnEntityTreatment) never creates a second active exact
  // treatment (identity companyId+entityId → UPDATED replaces). Coexistence is
  // only possible as raw state, which the degrade path must NOT degrade.
  it('T25: psychedelic exact pair — degrade pins exactly exactTreatmentItemIds, refuses ambiguous legacy fallback', async () => {
    const { adapter } = createKeharness();
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Two distinguishable RAW exact treatments coexisting for the same entity
    const exactA = await adapter.record({
      content: JSON.stringify({
        pattern: '', glAccountId: 'gl-x', direction: 'any',
        source: 'user_correction', transactionId: 'tx25x', entityId: ENTITY_1,
      }),
      type: 'classification',
      companyId: COMPANY_A,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });
    const exactB = await adapter.record({
      content: JSON.stringify({
        pattern: '', glAccountId: GL_B, direction: 'any',
        source: 'user_correction', transactionId: 'tx25b', entityId: ENTITY_1,
      }),
      type: 'classification',
      companyId: COMPANY_A,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });

    // LEGACY conflict (pre-EVOL-002): AUTHORIZED_VS_EXACT WITHOUT
    // exactTreatmentItemIds; GL-B is the conflicting GL (matches exactB)
    const legacyConflict = await adapter.record({
      content: JSON.stringify({
        companyId: COMPANY_A,
        entityId: ENTITY_1,
        direction: 'any',
        kind: 'AUTHORIZED_VS_EXACT',
        authorizedPatternIds: [setup.authId],
        conflictingGlAccountId: GL_B,
        observationIds: [],
        detectedAt: new Date().toISOString(),
        sourceCandidateId: setup.candidateId,
      }),
      type: CONFLICTING_PATTERN_TYPE,
      companyId: COMPANY_A,
      sourceAuthor: 'system',
      sourceName: 'conflict_detection',
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });

    // The stored state has TWO exact treatments → the legacy fallback MUST
    // refuse (not 1 single match) and must NOT degrade either exact item.
    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, legacyConflict.id);

    expect(degrade.status).toBe('UPDATED');
    if (degrade.status !== 'UPDATED') return;
    // ONLY the implicated authorized pattern was degraded
    expect(degrade.degradedItemIds).toEqual([setup.authId]);

    // BOTH exact treatments remain untouched (not degraded, not chosen)
    const exactAItem = await adapter.getById(exactA.id, COMPANY_A);
    const exactBItem = await adapter.getById(exactB.id, COMPANY_A);
    if (!exactAItem || !exactBItem) throw new Error('exact items lost');
    expect(exactAItem.confidence).toBe('certain');
    expect(exactBItem.confidence).toBe('certain');
    expect(exactAItem.status).toBe('active');
    expect(exactBItem.status).toBe('active');
  });

  // Precision when the legacy state DOES match a single implicated item:
  // exactly 1 exact treatment whose GL equals the persisted conflict GL.
  it('T26: legacy fallback degrades exactly the unique implicated exact item (state matches conflict)', async () => {
    const { adapter, prisma } = createKeharness();
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // The implicated exact treatment (GL-B, conflicting GL)
    const exactImplicated = await adapter.record({
      content: JSON.stringify({
        pattern: '', glAccountId: GL_B, direction: 'any',
        source: 'user_correction', transactionId: 'tx26', entityId: ENTITY_1,
      }),
      type: 'classification',
      companyId: COMPANY_A,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });

    // DIFFERENT entity's exact treatment must stay untouched
    const otherLearn = await learnEntityTreatment(adapter, COMPANY_A, 'entity-other', GL_A, 'any', 'user_correction', 'tx26-other');
    if (otherLearn.status !== 'CREATED') throw new Error(`${otherLearn.status}`);
    const otherPromo = await evolveClassificationConfidence(adapter, COMPANY_A, otherLearn.itemId, 'certain', 'human_confirmation');
    if (otherPromo.status !== 'UPDATED' && otherPromo.status !== 'UNCHANGED') throw new Error(`${otherPromo.status}`);

    // Legacy conflict whose unique exact state matches: legacyExactIds=[exactImplicated]
    const legacyConflict = await adapter.record({
      content: JSON.stringify({
        companyId: COMPANY_A,
        entityId: ENTITY_1,
        direction: 'any',
        kind: 'AUTHORIZED_VS_EXACT',
        authorizedPatternIds: [setup.authId],
        conflictingGlAccountId: GL_B,
        observationIds: [],
        detectedAt: new Date().toISOString(),
        sourceCandidateId: setup.candidateId,
      }),
      type: CONFLICTING_PATTERN_TYPE,
      companyId: COMPANY_A,
      sourceAuthor: 'system',
      sourceName: 'conflict_detection',
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });

    const degrade = await degradeKnowledgeOnConflict(adapter, COMPANY_A, legacyConflict.id);
    expect(degrade.status).toBe('UPDATED');
    if (degrade.status !== 'UPDATED') return;
    expect(degrade.degradedItemIds).toContain(setup.authId);
    expect(degrade.degradedItemIds).toContain(exactImplicated.id);
    expect(degrade.degradedItemIds).not.toContain(otherLearn.itemId);

    const implicated = await adapter.getById(exactImplicated.id, COMPANY_A);
    const other = await adapter.getById(otherLearn.itemId, COMPANY_A);
    if (!implicated || !other) throw new Error('items lost');
    expect(implicated.confidence).toBe('uncertain');
    expect(other.confidence).toBe('certain');

    // TRACEABILITY: exactly 2 degradation rows (pattern + implicated exact)
    const conflictLogs = prisma._confidenceLogs.filter((l) => l.reason === 'deterministic_conflict');
    expect(conflictLogs.length).toBe(2);
    expect(conflictLogs.every((l) => l.previousLevel === 'certain' && l.newLevel === 'uncertain')).toBe(true);
  });

  // AUTHORIZED_VS_EXACT idempotency, borderline C11, lineage and DETECTED_AT outside identity
  it('T27: A_VS_EXACT idempotent identity, lineage preserved, detectedAt/sourceCandidate outside identity', async () => {
    const { adapter } = createKeharness();
    const setup = await setupAuthorizedPattern(adapter, COMPANY_A, ENTITY_1, GL_A);

    // Exact treatment evolves to GL-B — the audited divergence
    // (first created, then replaced by the divergent correction → UPDATED)
    const learnA = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_A, 'any', 'user_correction', 'tx27a');
    if (learnA.status !== 'CREATED') throw new Error(`${learnA.status}`);
    const learnB = await learnEntityTreatment(adapter, COMPANY_A, ENTITY_1, GL_B, 'any', 'user_correction', 'tx27b');
    if (learnB.status !== 'UPDATED') throw new Error(`${learnB.status}`);

    const first = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(first.status).toBe('RECORDED');
    if (first.status !== 'RECORDED') return;

    const persisted = await getConflictContentById(adapter, first.conflictId);
    expect(persisted.kind).toBe('AUTHORIZED_VS_EXACT');
    expect(persisted.companyId).toBe(COMPANY_A);
    expect(persisted.entityId).toBe(ENTITY_1);
    expect(persisted.conflictingGlAccountId).toBe(GL_B);
    // LINEAGE
    expect(persisted.authorizedPatternIds).toEqual([setup.authId]);
    expect(persisted.sourceCandidateId).toBe(setup.candidateId);
    expect(Array.isArray(persisted.exactTreatmentItemIds) && persisted.exactTreatmentItemIds.length === 1).toBe(true);
    const implicatedExactId = persisted.exactTreatmentItemIds![0];
    const implicatedItem = await adapter.getById(implicatedExactId, COMPANY_A);
    if (!implicatedItem) throw new Error('implicated exact lost');
    expect(implicatedItem.status).toBe('active');

    // Second detection in a DIFFERENT second — identity excludes detectedAt
    const second = await detectConflictingPattern(adapter, COMPANY_A, ENTITY_1, 'any');
    expect(second.status).toBe('ALREADY_RECORDED');
    if (second.status !== 'ALREADY_RECORDED') return;

    // Exactly ONE persisted conflict for this evidence set
    const { getPendingConflicts } = await import('../../src/memory/classification-knowledge');
    const read = await getPendingConflicts(adapter, COMPANY_A, ENTITY_1);
    expect(read.status).toBe('FOUND');
    if (read.status !== 'FOUND') return;
    expect(read.conflicts.length).toBe(1);
    expect(read.conflicts[0].exactTreatmentItemIds).toEqual([implicatedExactId]);
    expect(read.conflicts[0].detectedAt).toBeTruthy();
  });
});

async function getConflictContentById(adapter: MemoryAdapter, conflictId: string) {
  const item = await adapter.getById(conflictId, 'company-a');
  if (!item) throw new Error('conflict lost');
  const parsed: unknown = JSON.parse(item.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad conflict');
  return parsed as {
    kind: string; companyId: string; entityId: string; conflictingGlAccountId: string;
    authorizedPatternIds: string[]; sourceCandidateId?: string; exactTreatmentItemIds?: string[];
    detectedAt: string;
  };
}

async function getPendingConflictsSafe(adapter: MemoryAdapter) {
  const { getPendingConflicts } = await import('../../src/memory/classification-knowledge');
  const result = await getPendingConflicts(adapter, 'company-a');
  if (result.status !== 'FOUND') throw new Error(`expected FOUND, got ${result.status}`);
  return result.conflicts[0];
}
