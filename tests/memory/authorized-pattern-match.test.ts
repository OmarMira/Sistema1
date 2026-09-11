// Knowledge Engine — Productive Structural Matching Tests (GENERALIZACIÓN-005)
// AUTHORIZED patterns match new variants with NO AI and NO rule engine.
// ERROR is explicit and distinct from NO_MATCH.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks required by import.service.ts integration tests ─────

const mockResolveEntity = vi.fn();

vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: (...args: unknown[]) => mockResolveEntity(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {},
}));

// ─── KE module (real) + mock prisma ─────────────────────────────

import {
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
  matchAuthorizedPattern,
  recordClassificationObservation,
  learnEntityTreatment,
  AUTHORIZED_PATTERN_TYPE,
} from '../../src/memory/classification-knowledge';
import type { StructuralGroupKey, StructuralSegment } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';
import { resolveImportDecision } from '../../../src/lib/services/import.service';

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

async function buildAuthorized(
  adapter: MemoryAdapter,
  key: StructuralGroupKey,
  descriptions: string[],
): Promise<{ patternId: string; candidateId: string }> {
  await seedObservations(adapter, key.companyId, key.entityId, key.glAccountId, key.direction, descriptions);
  const disc = await discoverStructuralCandidateForGroup(adapter, key);
  if (disc.kind !== 'candidate') throw new Error(`expected candidate: ${disc.reason}`);
  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  if (!rec.ok) throw new Error(`candidate record failed: ${rec.error}`);
  const auth = await authorizeStructuralCandidate(adapter, key.companyId, rec.candidateId, 'user-42');
  if (auth.status !== 'AUTHORIZED') throw new Error(`authorization failed: ${auth.status}`);
  return { patternId: auth.authorizedPatternId, candidateId: rec.candidateId };
}

/** Insert a pre-existing authorized pattern directly (divergent historical state). */
async function recordRawAuthorizedPattern(
  adapter: MemoryAdapter,
  key: StructuralGroupKey,
  segments: StructuralSegment[],
): Promise<string> {
  const content = {
    companyId: key.companyId,
    entityId: key.entityId,
    glAccountId: key.glAccountId,
    direction: key.direction,
    segments,
    sourceCandidateId: 'legacy-candidate',
    observationIds: ['o1', 'o2'],
    authorizedBy: 'legacy-user',
    authorizedAt: new Date().toISOString(),
  };
  const item = await adapter.record({
    content: JSON.stringify(content),
    type: AUTHORIZED_PATTERN_TYPE,
    companyId: key.companyId,
    sourceAuthor: 'legacy-user',
    sourceName: 'pattern_authorization',
    sourceObservedAt: new Date(),
    confidence: 'certain',
  });
  return item.id;
}

const KEY: StructuralGroupKey = {
  companyId: 'comp_1',
  entityId: 'entity_1',
  glAccountId: 'gl_A',
  direction: 'any',
};

beforeEach(() => {
  mockResolveEntity.mockReset();
});

// ─── Matcher unit tests ──────────────────────────────────────────

describe('matchAuthorizedPattern (GENERALIZACIÓN-005)', () => {
  // T1: canonical match
  it('T1: ABC 999 XYZ matches ABC <VARIABLE> XYZ with GL_A', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('match');
    expect(m.kind === 'match' && m.glAccountId).toBe('gl_A');
  });

  it('T2: different initial stable token → NO_MATCH', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABD 999 XYZ', 'any');
    expect(m.kind).toBe('no_match');
  });

  it('T3: different final stable token → NO_MATCH', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 QRS', 'any');
    expect(m.kind).toBe('no_match');
  });

  it('T4: different token length → NO_MATCH', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ EXTRA', 'any');
    expect(m.kind).toBe('no_match');
  });

  // T5: NEVER-SEEN variable value still matches — that is the point
  it('T5: unseen VARIABLE value matches (no list membership required)', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 987654 XYZ', 'any');
    expect(m.kind).toBe('match');
    expect(m.kind === 'match' && m.glAccountId).toBe('gl_A');
  });

  // T6: tenant isolation
  it('T6: pattern stored for company B does not match company A', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(
      adapter,
      { companyId: 'comp_2', entityId: 'entity_1', glAccountId: 'gl_A', direction: 'any' },
      ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ'],
    );

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('no_match');
  });

  // T7: entity isolation
  it('T7: pattern of another entity does not match', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_2', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('no_match');
  });

  // T8: direction isolation — ONLY the direction dimension varies:
  // same company, same entity, matching structure, different pattern.direction.
  it('T8: direction isolation — credit pattern rejects debit request; any stays compatible', async () => {
    const { adapter } = createMockAdapter();

    // Authorized pattern with direction 'credit' for the SAME company+entity.
    // Structure: DDD 111 YYY → stable, variable, stable.
    await buildAuthorized(
      adapter,
      { companyId: 'comp_1', entityId: 'entity_1', glAccountId: 'gl_A', direction: 'credit' },
      ['DDD 111 YYY', 'DDD 222 YYY', 'DDD 333 YYY'],
    );

    // Requested 'credit' → MATCH (test isolates structure: not entity, not tenant)
    const credit = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'DDD 999 YYY', 'credit');
    expect(credit.kind).toBe('match');

    // Requested 'debit' with same structure → NO_MATCH purely by direction
    const debit = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'DDD 999 YYY', 'debit');
    expect(debit.kind).toBe('no_match');

    // Requested 'any' is compatible with a 'credit' pattern (existing semantics)
    const any = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'DDD 999 YYY', 'any');
    expect(any.kind).toBe('match');
  });

  it('T8b: "any" pattern accepts credit and debit requests (existing any semantics)', async () => {
    const { adapter } = createMockAdapter();
    await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    expect((await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'credit')).kind).toBe('match');
    expect((await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'debit')).kind).toBe('match');
  });

  // T9: candidate WITHOUT authorization has no productive authority
  it('T9: persisted candidate that was never authorized → NO_MATCH', async () => {
    const { adapter } = createMockAdapter();
    await seedObservations(adapter, KEY.companyId, KEY.entityId, KEY.glAccountId, KEY.direction, [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
      'ABC 333 XYZ',
    ]);
    const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(disc.kind).toBe('candidate');
    if (disc.kind !== 'candidate') return;
    expect((await recordStructuralCandidate(adapter, disc.candidate)).ok).toBe(true);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('no_match');
  });

  // T10: malformed authorized pattern → ERROR (never NO_MATCH)
  it('T10: malformed authorized pattern content → ERROR', async () => {
    const { adapter, store } = createMockAdapter();
    const { patternId } = await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    store.get(patternId)!.content = 'corrupt{json';

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('error');
  });

  // T11: adapter/DB failure → ERROR, never NO_MATCH
  it('T11: adapter failure → ERROR, never silently NO_MATCH', async () => {
    const { adapter, prisma } = createMockAdapter();
    (prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection lost'));

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('error');
    expect(m.kind === 'error' && m.reason).toContain('DB connection lost');
  });

  // T12: two authorized patterns, same scope, incompatible treatments → AMBIGUOUS
  it('T12: incompatible multiple matches → AMBIGUOUS, no invented winner', async () => {
    const { adapter } = createMockAdapter();
    const a = await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    // Divergent historical state: an authorized pattern with a different GL for
    // the same entity+direction, created directly in the store (the current
    // authorization operation would block this case — the matcher must DEFEND
    // against pre-existing divergent knowledge).
    const b = await recordRawAuthorizedPattern(adapter, { ...KEY, glAccountId: 'gl_B' }, [
      { kind: 'stable', value: 'abc' },
      { kind: 'variable', evidence: [] },
      { kind: 'stable', value: 'xyz' },
    ]);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') {
      expect(m.matchedPatternIds.sort()).toEqual([a.patternId, b].sort());
    }
  });

  // T13: multiple matches with the SAME compatible treatment → single treatment, no fake conflict
  it('T13: compatible multiple matches → deterministic single treatment with full traceability', async () => {
    const { adapter } = createMockAdapter();
    const a = await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    await seedObservations(adapter, KEY.companyId, KEY.entityId, KEY.glAccountId, KEY.direction, [
      'ABC 555 XYZ',
      'ABC 666 XYZ',
    ]);
    const disc = await discoverStructuralCandidateForGroup(adapter, KEY);
    expect(disc.kind).toBe('candidate');
    if (disc.kind !== 'candidate') return;
    const rec = await recordStructuralCandidate(adapter, disc.candidate);
    if (!rec.ok) throw new Error(`candidate record failed: ${rec.error}`);
    const auth = await authorizeStructuralCandidate(adapter, 'comp_1', rec.candidateId, 'user-42');
    if (auth.status !== 'AUTHORIZED') throw new Error(`authorization failed: ${auth.status}`);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('match');
    if (m.kind !== 'match') return;
    expect(m.glAccountId).toBe('gl_A');
    expect(m.matchedPatternIds).toEqual([a.patternId, auth.authorizedPatternId]);
  });

  // T20: matching does not mutate stored knowledge
  it('T20: matched pattern bytes unchanged, no new authorization, confidence untouched', async () => {
    const { adapter, store } = createMockAdapter();
    const { patternId } = await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    const before = JSON.stringify(store.get(patternId));

    await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');

    expect(JSON.stringify(store.get(patternId))).toBe(before);

    // No new authorized/candidate item added by matching
    const items = Array.from(store.values()).filter((i) => i.companyId === 'comp_1');
    expect(items.filter((i) => i.type === 'classification')).toHaveLength(0);
  });

  // T22: traceability preserved from the match result
  it('T22: match result exposes authorizedPatternId, sourceCandidateId, observationIds', async () => {
    const { adapter } = createMockAdapter();
    const { patternId, candidateId } = await buildAuthorized(adapter, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);

    const m = await matchAuthorizedPattern(adapter, 'comp_1', 'entity_1', 'ABC 999 XYZ', 'any');
    expect(m.kind).toBe('match');
    if (m.kind !== 'match') return;
    expect(m.authorizedPatternId).toBe(patternId);
    expect(m.sourceCandidateId).toBe(candidateId);
    expect(m.observationIds).toHaveLength(3);
    expect(m.entityId).toBe('entity_1');
    expect(m.direction).toBe('any');
  });
});

// ─── Productive integration: resolveImportDecision ───────────────

describe('resolveImportDecision with structural matching (GENERALIZACIÓN-005)', () => {
  let resolveRule: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockResolveEntity.mockReset();
    resolveRule = vi.fn().mockResolvedValue({ matchedRuleId: 'rule-1', glAccountId: 'gl_RULE' });
  });

  function known(entityId: string) {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId });
  }

  // T15 + T16 + T17 + T23: exact MISS + structural MATCH → KE treatment, no rule engine, no AI
  it('T15/T16/T17/T23: new unseen variant resolves via authorized pattern — no rule engine, no AI', async () => {
    const { adapter: fresh } = createMockAdapter();
    await buildAuthorized(fresh, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    known('entity_1');
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_1' });

    const decision = await resolveImportDecision(fresh, 'comp_1', 'ABC 999 XYZ', resolveRule);

    expect(decision.source).toBe('ke');
    expect(decision.glAccountId).toBe('gl_A');
    expect(decision.matchedRuleId).toBeNull();
    expect(resolveRule).not.toHaveBeenCalled();
  });

  // T14: exact treatment FOUND keeps precedence — matcher not even needed
  it('T14: exact treatment lookup FOUND wins over structural matching', async () => {
    const { adapter: fresh } = createMockAdapter();
    await buildAuthorized(fresh, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    // Exact knowledge: confirm a DIFFERENT GL for the entity first
    const learn = await learnEntityTreatment(
      fresh,
      KEY.companyId,
      KEY.entityId,
      'gl_EXACT',
      'any',
      'user_correction',
      'tx_exact',
    );
    expect(learn.status).toBe('CREATED');
    known('entity_1');

    const decision = await resolveImportDecision(fresh, 'comp_1', 'ABC 999 XYZ', resolveRule);

    expect(decision.source).toBe('ke');
    expect(decision.glAccountId).toBe('gl_EXACT');
    expect(resolveRule).not.toHaveBeenCalled();
  });

  // T18: structural NO_MATCH → pipeline continues exactly as before
  it('T18: known identity, no structural match → rule engine as before', async () => {
    const { adapter: fresh } = createMockAdapter();
    // No patterns at all for comp_1
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_1' });

    const decision = await resolveImportDecision(fresh, 'comp_1', 'ZZZ 111 YYY', resolveRule);

    expect(decision.source).toBe('rule_engine');
    expect(decision.glAccountId).toBe('gl_RULE');
    expect(decision.matchedRuleId).toBe('rule-1');
    expect(resolveRule).toHaveBeenCalledTimes(1);
  });

  // T19: structural ERROR → ke_error, never silent fallback
  it('T19: corrupt authorized pattern → ke_error, no rule engine fallback', async () => {
    const { adapter: fresh, store } = createMockAdapter();
    const { patternId } = await buildAuthorized(fresh, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ']);
    store.get(patternId)!.content = 'corrupt{';
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_1' });

    const decision = await resolveImportDecision(fresh, 'comp_1', 'ABC 999 XYZ', resolveRule);

    expect(decision.source).toBe('ke_error');
    expect(decision.glAccountId).toBeNull();
    expect(resolveRule).not.toHaveBeenCalled();
  });

  // T12b (integration): AMBIGUOUS → no KE decision; existing resolution mechanism continues
  it('ambiguous structural match continues to the existing resolution mechanism explicitly', async () => {
    const { adapter: fresh } = createMockAdapter();
    await buildAuthorized(fresh, KEY, ['ABC 111 XYZ', 'ABC 222 XYZ']);
    // Divergent historical state (different GL, same entity+direction), raw store
    await recordRawAuthorizedPattern(fresh, { ...KEY, glAccountId: 'gl_B' }, [
      { kind: 'stable', value: 'abc' },
      { kind: 'variable', evidence: [] },
      { kind: 'stable', value: 'xyz' },
    ]);
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_1' });

    const decision = await resolveImportDecision(fresh, 'comp_1', 'ABC 999 XYZ', resolveRule);

    // No invented KE decision; the existing downstream mechanism (rule engine) continues
    expect(decision.source).toBe('rule_engine');
    expect(decision.glAccountId).toBe('gl_RULE');
    expect(resolveRule).toHaveBeenCalledTimes(1);
  });

  // T24: UNKNOWN identity (no pattern applicable path) → legacy behavior
  it('T24: UNKNOWN identity keeps legacy behavior (rule engine)', async () => {
    const { adapter: fresh } = createMockAdapter();
    mockResolveEntity.mockResolvedValue({ status: 'UNKNOWN' });

    const decision = await resolveImportDecision(fresh, 'comp_1', 'ABC 999 XYZ', resolveRule);

    expect(decision.source).toBe('rule_engine');
    expect(resolveRule).toHaveBeenCalledTimes(1);
  });

  // Canonical end-to-end chain: evidence → discovery → authorization → match without AI
  it('canonical: three corrections → authorized → ABC 999 XYZ resolves by KE with no AI/RB', async () => {
    const { adapter: fresh, store: freshStore } = createMockAdapter();

    // Stage 1: user confirms three times (evidence)
    await seedObservations(fresh, 'comp_1', 'entity_1', 'gl_A', 'any', [
      'ABC 111 XYZ',
      'ABC 222 XYZ',
      'ABC 333 XYZ',
    ]);

    // Stage 2: discovery
    const disc = await discoverStructuralCandidateForGroup(fresh, KEY);
    expect(disc.kind).toBe('candidate');

    // Stage 3: explicit human authorization
    if (disc.kind !== 'candidate') throw new Error('expected candidate');
    const rec = await recordStructuralCandidate(fresh, disc.candidate);
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const auth = await authorizeStructuralCandidate(fresh, 'comp_1', rec.candidateId, 'user-42');
    expect(auth.status).toBe('AUTHORIZED');

    // Stage 4: NEW unseen variant resolved without AI or rule engine
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'entity_1' });
    const decision = await resolveImportDecision(fresh, 'comp_1', 'ABC 999 XYZ', resolveRule);

    expect(decision.source).toBe('ke');
    expect(decision.glAccountId).toBe('gl_A');
    expect(resolveRule).not.toHaveBeenCalled();
    // Productive classification state did not change (no classification items)
    const classificationItems = Array.from(freshStore.values()).filter(
      (item) => item.type === 'classification',
    );
    expect(classificationItems).toHaveLength(0);
  });
});
