// Knowledge Engine — G8-1 Causal Test: Entity Merge KE Coherence
//
// Certifies the BLOCK8/G8-1 contract on a REAL isolated database:
// when CompanyKnowledge SOURCE merges into TARGET, entity-bound KE
// knowledge (treatments, observations, structural candidates,
// authorized patterns) consolidates atomically so future decisions
// under TARGET preserve exactly the pre-merge decision behavior.
//
// Coverage (§16 of the controlled-build order):
//   T1  source treatment + target none → transfer in place (same itemId)
//   T2  both same treatment → keep target, source historical
//   T3  different treatments → reject without choice (zero mutation);
//       explicit choice → winner active, loser historical
//   T4  confidence preserved through merge
//   T5  pending conflict over source treatment → same itemId, gating
//       preserved, no rebind, resolve + rehabilitation still work
//   T6  description/alias previously resolving to SOURCE → TARGET
//   T7A direct-decision treatment → 'ke' pre/post, no rule engine
//   T7B uncertain treatment → rule-engine fallback preserved pre/post
//   T7C conflict-degraded → gated while pending → after resolution and
//       rehabilitation the valid behavior returns ('ke')
//   T8  tenant isolation → cross-company rejected, zero foreign mutation
//   T9  audit/version/traceability preserved and KE actions auditable
//   AP1 same GL + direction → compatible, both kept
//   AP2 same direction, different GL → explicit human choice only
//   AP3/AP4 different direction → coexistence, no false conflict
//   OBS observations TRANSFER_COMBINE with exact-content idempotency
//   CAND structural candidates transfer, never auto-authorized
//   AT1  failure inside the KE phase → CK + KE + audit all rolled back
//   AT2  a real KE write completed before the failure does not survive
//   ATOMIC audit-stage failure rolls back CK + KE together
//
// No production database is used. No mocks of the KE logic under test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { TransactionRunner } from '../../src/memory/prisma-types';
import { requestContext } from '../../src/lib/context-storage';
import { merge } from '../../src/internal/company-knowledge/entity/service';
import { resolveImportDecision } from '../../src/lib/services/import.service';
import { resolveEntity } from '../../src/memory/entity-resolution';
import {
  learnEntityTreatment,
  lookupTreatment,
  recordClassificationObservation,
  getClassificationObservations,
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  getStructuralCandidates,
  authorizeStructuralCandidate,
  getAuthorizedPatterns,
  detectConflictingPattern,
  degradeKnowledgeOnConflict,
  resolveClassificationConflict,
  rehabilitateClassificationKnowledge,
  isKnowledgeImplicatedByPendingConflict,
  evolveClassificationConfidence,
  type StructuralGroupKey,
} from '../../src/memory/classification-knowledge';
import { createTestCompany, clearDatabase } from '../helpers/factories';

vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });

const prisma = new PrismaClient();
const runTx: TransactionRunner = (fn) => prisma.$transaction(fn);
const adapter = new MemoryAdapter(prisma, runTx);

const HUMAN = 'g8-1-merge-tester';

// ─── Fixture ownership (test isolation) ─────────────────────────
//
// Every company this file creates is registered here and removed in
// afterEach together with everything FK-dependent on it. This keeps the
// file self-contained: it never relies on clearDatabase() (which only
// cleans companies owned by @example.com test users) and never leaks
// KnowledgeAudit rows that later suites (e.g. f10) query globally.

const fixtureCompanyIds = new Set<string>();

async function createFixtureCompany(name: string) {
  const company = await createTestCompany(name);
  fixtureCompanyIds.add(company.id);
  return company;
}

/**
 * Deletes, in FK order, exactly the data this file created:
 * KnowledgeAudit → PendingApproval → CompanyKnowledge → AuditLog →
 * Company (cascades MemoryItem, which cascades MemoryVersion,
 * TraceabilityLog, ConfidenceLog, Relationship, Contradiction and
 * EvolutionLink). Idempotent; runs even when a test fails.
 */
async function cleanupOwnFixtures(): Promise<void> {
  if (fixtureCompanyIds.size === 0) return;
  const companyIds = [...fixtureCompanyIds];

  const knowledgeRows = await prisma.companyKnowledge.findMany({
    where: { companyId: { in: companyIds } },
    select: { id: true },
  });
  const knowledgeIds = knowledgeRows.map((row) => row.id);

  if (knowledgeIds.length > 0) {
    await prisma.knowledgeAudit.deleteMany({ where: { knowledgeId: { in: knowledgeIds } } });
    await prisma.pendingApproval.deleteMany({ where: { knowledgeId: { in: knowledgeIds } } });
    await prisma.companyKnowledge.deleteMany({ where: { id: { in: knowledgeIds } } });
  }

  await prisma.auditLog.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } });

  fixtureCompanyIds.clear();
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await cleanupOwnFixtures();
  await clearDatabase();
});

// ─── Helpers ─────────────────────────────────────────────────────

async function createEntity(
  companyId: string,
  canonicalName: string,
  aliases: string[] = [],
) {
  return prisma.companyKnowledge.create({
    data: { companyId, type: 'PERSON', canonicalName, aliases, metadata: {} },
  });
}

function runMerge(input: {
  sourceKnowledgeId: string;
  targetKnowledgeId: string;
  companyId: string;
  fieldResolutions?: Record<string, unknown>;
  reason?: string;
}) {
  return requestContext.run({ userId: HUMAN, companyId: input.companyId }, () =>
    merge({ ...input, fieldResolutions: input.fieldResolutions ?? {} }),
  );
}

interface CollisionEnvelope {
  code: string;
  collisions: Array<{
    kind: string;
    direction?: string;
    source: { itemId?: string; itemIds?: string[]; glAccountId: string };
    target: { itemId?: string; itemIds?: string[]; glAccountId: string };
  }>;
}

async function captureMergeError(input: Parameters<typeof runMerge>[0]): Promise<CollisionEnvelope | null> {
  try {
    await runMerge(input);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('G8_1_COLLISION')) {
      return JSON.parse(message) as CollisionEnvelope;
    }
    throw error;
  }
  throw new Error('Expected merge to reject, but it succeeded');
}

function makeRuleSpy() {
  return vi.fn(async () => ({ matchedRuleId: 'rule-1', glAccountId: 'gl-rule-engine' }));
}

async function readItem(itemId: string) {
  const item = await prisma.memoryItem.findUnique({ where: { id: itemId } });
  expect(item).not.toBeNull();
  return item!;
}

/** Observations → discover → record → authorize an entity-bound pattern. */
async function setupAuthorizedPatternFor(
  companyId: string,
  entityId: string,
  glAccountId: string,
  tag: string,
  direction: 'debit' | 'credit' | 'any' = 'any',
): Promise<{ candidateId: string; authId: string }> {
  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `ABC ${i * 111} ${tag}`,
      glAccountId,
      direction,
      source: 'user_correction',
      transactionId: `tx-${tag}-${i}`,
    });
    if (!obs.ok) throw new Error(`setup observation failed: ${obs.error}`);
  }

  const groupKey: StructuralGroupKey = { companyId, entityId, glAccountId, direction };
  const discovery = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (discovery.kind !== 'candidate') throw new Error(`discovery failed: ${discovery.reason}`);

  const candidate = await recordStructuralCandidate(adapter, discovery.candidate);
  if (!candidate.ok) throw new Error(`candidate record failed: ${candidate.error}`);

  const auth = await authorizeStructuralCandidate(adapter, companyId, candidate.candidateId, HUMAN);
  if (auth.status !== 'AUTHORIZED' && auth.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`authorize failed: ${auth.status}`);
  }
  return { candidateId: candidate.candidateId, authId: auth.authorizedPatternId };
}

/** Same as above but stops at the candidate (never authorized). */
async function setupCandidateFor(
  companyId: string,
  entityId: string,
  glAccountId: string,
  tag: string,
): Promise<string> {
  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `MERG ${i * 7} ${tag}`,
      glAccountId,
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-${tag}-${i}`,
    });
    if (!obs.ok) throw new Error(`setup observation failed: ${obs.error}`);
  }

  const groupKey: StructuralGroupKey = { companyId, entityId, glAccountId, direction: 'any' };
  const discovery = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (discovery.kind !== 'candidate') throw new Error(`discovery failed: ${discovery.reason}`);

  const candidate = await recordStructuralCandidate(adapter, discovery.candidate);
  if (!candidate.ok) throw new Error(`candidate record failed: ${candidate.error}`);
  return candidate.candidateId;
}

/**
 * AUTHORIZED_VS_EXACT pending conflict implicating the exact treatment:
 * authorized pattern GL auth + exact treatment GL exact + non-matching
 * observation → detect → conflictId (same recipe as rehabilitation tests).
 */
async function setupPendingExactConflict(
  companyId: string,
  entityId: string,
  tag: string,
): Promise<{ conflictId: string; patternId: string; exactTreatmentItemId: string }> {
  const { authId } = await setupAuthorizedPatternFor(companyId, entityId, 'gl-conflict-auth', tag);

  const learn = await learnEntityTreatment(
    adapter,
    companyId,
    entityId,
    'gl-conflict-exact',
    'any',
    'user_correction',
    `tx-exact-${tag}`,
  );
  if (learn.status !== 'CREATED') throw new Error(`treatment learn failed: ${learn.status}`);

  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `ZZZ 123 ${tag}`,
    glAccountId: 'gl-conflict-exact',
    direction: 'any',
    source: 'user_correction',
    transactionId: `tx-obs-exact-${tag}`,
  });
  if (!obs.ok) throw new Error(`conflicting observation failed: ${obs.error}`);

  const detect = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`conflict detect failed: ${detect.status}`);

  return { conflictId: detect.conflictId, patternId: authId, exactTreatmentItemId: learn.itemId };
}

async function degradeByConflict(companyId: string, conflictId: string): Promise<void> {
  const degraded = await degradeKnowledgeOnConflict(adapter, companyId, conflictId);
  if (degraded.status !== 'UPDATED' && degraded.status !== 'UNCHANGED') {
    throw new Error(`degrade failed: ${degraded.status}`);
  }
}

// ─── T1 — treatment transfer in place ────────────────────────────

describe('T1 — SOURCE treatment transfers in place to TARGET', () => {
  it('keeps itemId/gl/direction, lookup moves to TARGET, source left without treatment, history preserved', async () => {
    const company = await createFixtureCompany('G8-1 T1');
    const source = await createEntity(company.id, 'Taco Bell Norte');
    const target = await createEntity(company.id, 'Taco Bell Sur');

    const learn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-food-500', 'debit', 'user_correction', 'tx-t1',
    );
    expect(learn.status).toBe('CREATED');
    const itemId = learn.itemId;

    const pre = await lookupTreatment(adapter, company.id, source.id);
    expect(pre.status).toBe('FOUND');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T1',
    });

    // Same itemId now resolves under TARGET.
    const post = await lookupTreatment(adapter, company.id, target.id);
    expect(post.status).toBe('FOUND');
    if (post.status === 'FOUND') {
      expect(post.memoryItemId).toBe(itemId);
      expect(post.glAccountId).toBe('gl-food-500');
      expect(post.direction).toBe('debit');
    }

    // SOURCE no longer has an active treatment.
    const sourceLookup = await lookupTreatment(adapter, company.id, source.id);
    expect(sourceLookup.status).toBe('NOT_FOUND');

    // Content rewritten in place; itemId and status preserved.
    const item = await readItem(itemId);
    expect(item.status).toBe('active');
    const content = JSON.parse(item.content) as { entityId?: string; glAccountId: string };
    expect(content.entityId).toBe(target.id);
    expect(content.glAccountId).toBe('gl-food-500');

    // History preserved: initial version (source-keyed) + update snapshot.
    const versions = await prisma.memoryVersion.findMany({
      where: { itemId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const v1 = JSON.parse(versions[0].content) as { entityId?: string };
    expect(v1.entityId).toBe(source.id);

    // CK identity: source merged, target active.
    const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: source.id } });
    const targetRow = await prisma.companyKnowledge.findUnique({ where: { id: target.id } });
    expect(sourceRow!.status).toBe('merged');
    expect(sourceRow!.mergedIntoId).toBe(target.id);
    expect(targetRow!.status).toBe('active');
  });
});

// ─── T2 — identical treatments: KEEP TARGET ──────────────────────

describe('T2 — identical treatments keep TARGET and historicalize SOURCE', () => {
  it('target treatment survives with intact confidence; source treatment forgotten with entity_merged reason', async () => {
    const company = await createFixtureCompany('G8-1 T2');
    const source = await createEntity(company.id, 'Naranja X');
    const target = await createEntity(company.id, 'Naranja X Plus');

    const srcLearn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-same-400', 'debit', 'user_correction', 'tx-t2-src',
    );
    const tgtLearn = await learnEntityTreatment(
      adapter, company.id, target.id, 'gl-same-400', 'debit', 'user_correction', 'tx-t2-tgt',
    );
    expect(srcLearn.status).toBe('CREATED');
    expect(tgtLearn.status).toBe('CREATED');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T2',
    });

    // TARGET keeps ITS item (no swap), confidence untouched.
    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.memoryItemId).toBe(tgtLearn.itemId);
      expect(lookup.confidence).toBe('tentative');
    }

    // SOURCE treatment → historical via forget, reason preserved.
    const srcItem = await readItem(srcLearn.itemId);
    expect(srcItem.status).toBe('forgotten');
    expect(srcItem.forgetReason).toBe('entity_merged');
    expect(srcItem.confidence).toBe('tentative');

    // TARGET treatment content untouched (still target-keyed).
    const tgtItem = await readItem(tgtLearn.itemId);
    expect(tgtItem.status).toBe('active');
    expect((JSON.parse(tgtItem.content) as { entityId?: string }).entityId).toBe(target.id);
  });
});

// ─── T3 — different treatments: explicit human choice only ───────

describe('T3 — treatment collision requires explicit human choice', () => {
  it('without a choice: rejects with G8_1_COLLISION and zero mutation', async () => {
    const company = await createFixtureCompany('G8-1 T3 reject');
    const source = await createEntity(company.id, 'Previlegio Gold');
    const target = await createEntity(company.id, 'Previlegio Silver');

    const srcLearn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-gold-1', 'debit', 'user_correction', 'tx-t3a',
    );
    const tgtLearn = await learnEntityTreatment(
      adapter, company.id, target.id, 'gl-silver-2', 'credit', 'user_correction', 'tx-t3b',
    );
    expect(srcLearn.status).toBe('CREATED');
    expect(tgtLearn.status).toBe('CREATED');

    const envelope = await captureMergeError({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T3 reject',
    });
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe('G8_1_COLLISION');
    expect(envelope!.collisions).toHaveLength(1);
    expect(envelope!.collisions[0].kind).toBe('treatment');

    // Zero mutation: CK, KE items, and audits untouched.
    const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: source.id } });
    const targetRow = await prisma.companyKnowledge.findUnique({ where: { id: target.id } });
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.version).toBe(1);
    expect(targetRow!.status).toBe('active');
    expect(targetRow!.version).toBe(1);

    const srcItem = await readItem(srcLearn.itemId);
    expect(srcItem.status).toBe('active');
    expect((JSON.parse(srcItem.content) as { entityId?: string }).entityId).toBe(source.id);
    const tgtItem = await readItem(tgtLearn.itemId);
    expect(tgtItem.status).toBe('active');
    expect((JSON.parse(tgtItem.content) as { entityId?: string }).entityId).toBe(target.id);

    const audits = await prisma.knowledgeAudit.findMany({
      where: { knowledgeId: { in: [source.id, target.id] } },
    });
    expect(audits).toHaveLength(0);
  });

  it('with treatment="target": target wins, source treatment historical', async () => {
    const company = await createFixtureCompany('G8-1 T3 target');
    const source = await createEntity(company.id, 'Mastercard Black');
    const target = await createEntity(company.id, 'Mastercard Gold');

    const srcLearn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-black-1', 'debit', 'user_correction', 'tx-t3c',
    );
    const tgtLearn = await learnEntityTreatment(
      adapter, company.id, target.id, 'gl-gold-2', 'credit', 'user_correction', 'tx-t3d',
    );

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      fieldResolutions: { treatment: 'target' },
      reason: 'T3 target',
    });

    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.memoryItemId).toBe(tgtLearn.itemId);
      expect(lookup.glAccountId).toBe('gl-gold-2');
    }
    const srcItem = await readItem(srcLearn.itemId);
    expect(srcItem.status).toBe('forgotten');
    expect(srcItem.forgetReason).toBe('entity_merged');
    const tgtItem = await readItem(tgtLearn.itemId);
    expect(tgtItem.status).toBe('active');
  });

  it('with treatment="source": source wins in place (same itemId), target treatment historical', async () => {
    const company = await createFixtureCompany('G8-1 T3 source');
    const source = await createEntity(company.id, 'Oca Orange');
    const target = await createEntity(company.id, 'Oca Blue');

    const srcLearn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-orange-1', 'debit', 'user_correction', 'tx-t3e',
    );
    const tgtLearn = await learnEntityTreatment(
      adapter, company.id, target.id, 'gl-blue-2', 'credit', 'user_correction', 'tx-t3f',
    );

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      fieldResolutions: { treatment: 'source' },
      reason: 'T3 source',
    });

    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.memoryItemId).toBe(srcLearn.itemId); // same itemId transferred
      expect(lookup.glAccountId).toBe('gl-orange-1');
    }
    const srcItem = await readItem(srcLearn.itemId);
    expect(srcItem.status).toBe('active');
    expect((JSON.parse(srcItem.content) as { entityId?: string }).entityId).toBe(target.id);
    const tgtItem = await readItem(tgtLearn.itemId);
    expect(tgtItem.status).toBe('forgotten');
    expect(tgtItem.forgetReason).toBe('entity_merged');
  });
});

// ─── T4 — confidence preservation ────────────────────────────────

describe('T4 — merge never modifies confidence', () => {
  it('preserves certain confidence through an in-place transfer', async () => {
    const company = await createFixtureCompany('G8-1 T4');
    const source = await createEntity(company.id, 'Galicia Visa');
    const target = await createEntity(company.id, 'Galicia Master');

    const learn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-visa-9', 'debit', 'user_correction', 'tx-t4',
    );
    expect(learn.status).toBe('CREATED');

    const evolved = await evolveClassificationConfidence(
      adapter, company.id, learn.itemId, 'certain', 'human_confirmation',
    );
    expect(evolved.status).toBe('UPDATED');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T4',
    });

    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.confidence).toBe('certain');
      expect(lookup.memoryItemId).toBe(learn.itemId);
    }
    const item = await readItem(learn.itemId);
    expect(item.confidence).toBe('certain');
    expect(item.status).toBe('active');
  });
});

// ─── T5 — pending conflict gating survives the merge ─────────────

describe('T5 — pending conflict over source treatment survives merge', () => {
  it('same itemId keeps gating active, conflict evidence not rebound, resolve + rehabilitation work', async () => {
    const company = await createFixtureCompany('G8-1 T5');
    const source = await createEntity(company.id, 'YPF Shell');
    const target = await createEntity(company.id, 'YPF Shell Express');

    const { conflictId, exactTreatmentItemId } = await setupPendingExactConflict(
      company.id, source.id, 't5',
    );
    await degradeByConflict(company.id, conflictId);

    // Gate BEFORE merge: pending conflict implicates the treatment.
    const gatePre = await isKnowledgeImplicatedByPendingConflict(
      adapter, company.id, exactTreatmentItemId,
    );
    expect(gatePre.implicated).toBe(true);

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T5',
    });

    // Same itemId under TARGET; gate STILL active (no rebind needed).
    const item = await readItem(exactTreatmentItemId);
    expect(item.status).toBe('active');
    expect((JSON.parse(item.content) as { entityId?: string }).entityId).toBe(target.id);

    const gatePost = await isKnowledgeImplicatedByPendingConflict(
      adapter, company.id, exactTreatmentItemId,
    );
    expect(gatePost.implicated).toBe(true);

    // Conflict evidence NOT rebound: historical entityId stays SOURCE.
    const conflictItem = await readItem(conflictId);
    const conflictContent = JSON.parse(conflictItem.content) as { entityId?: string };
    expect(conflictContent.entityId).toBe(source.id);

    // Explicit resolution still works post-merge.
    const resolved = await resolveClassificationConflict(
      adapter, company.id, conflictId, HUMAN, 'human decision recorded',
    );
    expect(resolved.status).toBe('RESOLVED');

    // Rehabilitation restores the degraded treatment post-merge.
    const rehab = await rehabilitateClassificationKnowledge(
      adapter, company.id, conflictId, exactTreatmentItemId, HUMAN,
    );
    expect(rehab.status).toBe('REHABILITATED');

    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.confidence).toBe('certain');
      expect(lookup.memoryItemId).toBe(exactTreatmentItemId);
    }
  });
});

// ─── T6 — identity resolution continuity ─────────────────────────

describe('T6 — descriptions previously resolving to SOURCE resolve to TARGET', () => {
  it('resolveEntity returns TARGET for source canonical name and alias; treatment correct under TARGET', async () => {
    const company = await createFixtureCompany('G8-1 T6');
    const source = await createEntity(company.id, 'Delta Gas Station', ['Delta Gas']);
    const target = await createEntity(company.id, 'Delta Gas Station Norte');

    await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-t6-fuel', 'credit', 'user_correction', 'tx-t6',
    );

    // Pre-merge: both descriptions resolve to SOURCE.
    const preCanonical = await resolveEntity(company.id, 'Delta Gas Station');
    expect(preCanonical).toEqual({ status: 'KNOWN', entityId: source.id });
    const preAlias = await resolveEntity(company.id, 'Delta Gas');
    expect(preAlias).toEqual({ status: 'KNOWN', entityId: source.id });

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T6',
    });

    // Post-merge: both descriptions resolve to TARGET (alias union §5).
    const postCanonical = await resolveEntity(company.id, 'Delta Gas Station');
    expect(postCanonical).toEqual({ status: 'KNOWN', entityId: target.id });
    const postAlias = await resolveEntity(company.id, 'Delta Gas');
    expect(postAlias).toEqual({ status: 'KNOWN', entityId: target.id });

    // Treatment correct under TARGET.
    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.glAccountId).toBe('gl-t6-fuel');
      expect(lookup.direction).toBe('credit');
    }
  });
});

// ─── T7A — direct decision behavior preserved ────────────────────

describe('T7A — direct-decision treatment keeps KE authority after merge', () => {
  it('pre/post decision source="ke", rule engine never called', async () => {
    const company = await createFixtureCompany('G8-1 T7A');
    const source = await createEntity(company.id, 'Sherwin Williams');
    const target = await createEntity(company.id, 'Sherwin Williams Depot');

    await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-t7a-paint', 'debit', 'user_correction', 'tx-t7a',
    );

    const ruleSpy = makeRuleSpy();
    const pre = await resolveImportDecision(adapter, company.id, 'Sherwin Williams', ruleSpy);
    expect(pre).toEqual({ source: 'ke', glAccountId: 'gl-t7a-paint', matchedRuleId: null });
    expect(ruleSpy).not.toHaveBeenCalled();

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T7A',
    });

    const ruleSpy2 = makeRuleSpy();
    const post = await resolveImportDecision(adapter, company.id, 'Sherwin Williams', ruleSpy2);
    expect(post).toEqual({ source: 'ke', glAccountId: 'gl-t7a-paint', matchedRuleId: null });
    expect(ruleSpy2).not.toHaveBeenCalled();
  });
});

// ─── T7B — uncertain fallback preserved ──────────────────────────

describe('T7B — uncertain treatment keeps rule-engine fallback after merge', () => {
  it('pre/post decision falls back to rule engine; confidence stays uncertain', async () => {
    const company = await createFixtureCompany('G8-1 T7B');
    const source = await createEntity(company.id, 'Burger King Caballito');
    const target = await createEntity(company.id, 'Burger King Caballito Oeste');

    const { conflictId, exactTreatmentItemId } = await setupPendingExactConflict(
      company.id, source.id, 't7b',
    );
    await degradeByConflict(company.id, conflictId);

    const preLookup = await lookupTreatment(adapter, company.id, source.id);
    expect(preLookup.status).toBe('FOUND');
    if (preLookup.status === 'FOUND') expect(preLookup.confidence).toBe('uncertain');

    const preSpy = makeRuleSpy();
    const pre = await resolveImportDecision(
      adapter, company.id, 'Burger King Caballito', preSpy,
    );
    expect(pre.source).toBe('rule_engine');
    expect(pre.glAccountId).toBe('gl-rule-engine');
    expect(preSpy).toHaveBeenCalledTimes(1);

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T7B',
    });

    // Confidence NOT changed by the merge: still uncertain.
    const postLookup = await lookupTreatment(adapter, company.id, target.id);
    expect(postLookup.status).toBe('FOUND');
    if (postLookup.status === 'FOUND') {
      expect(postLookup.confidence).toBe('uncertain');
      expect(postLookup.memoryItemId).toBe(exactTreatmentItemId);
    }

    // Fallback behavior preserved: still decides via rule engine.
    const postSpy = makeRuleSpy();
    const post = await resolveImportDecision(
      adapter, company.id, 'Burger King Caballito', postSpy,
    );
    expect(post.source).toBe('rule_engine');
    expect(post.glAccountId).toBe('gl-rule-engine');
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── T7C — degraded → gated → resolved → rehabilitated ───────────

describe('T7C — conflict-degraded behavior recovers after resolve + rehabilitation', () => {
  it('promotion stays gated while pending; after resolve + rehab KE decides directly again', async () => {
    const company = await createFixtureCompany('G8-1 T7C');
    const source = await createEntity(company.id, 'Mostro Pizza');
    const target = await createEntity(company.id, 'Mostro Pizza Congreso');

    const { conflictId, exactTreatmentItemId } = await setupPendingExactConflict(
      company.id, source.id, 't7c',
    );
    await degradeByConflict(company.id, conflictId);

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T7C',
    });

    // While the conflict is pending, promotion stays gated by the very
    // same gate the route consults (implication by pending conflict).
    const gate = await isKnowledgeImplicatedByPendingConflict(
      adapter, company.id, exactTreatmentItemId,
    );
    expect(gate.implicated).toBe(true);

    const fallbackSpy = makeRuleSpy();
    const degraded = await resolveImportDecision(
      adapter, company.id, 'Mostro Pizza', fallbackSpy,
    );
    expect(degraded.source).toBe('rule_engine');
    expect(fallbackSpy).toHaveBeenCalledTimes(1);

    // Human resolves the conflict, then explicitly rehabilitates.
    const resolved = await resolveClassificationConflict(
      adapter, company.id, conflictId, HUMAN, 'human decided',
    );
    expect(resolved.status).toBe('RESOLVED');
    const rehab = await rehabilitateClassificationKnowledge(
      adapter, company.id, conflictId, exactTreatmentItemId, HUMAN,
    );
    expect(rehab.status).toBe('REHABILITATED');

    // Valid behavior recovered under TARGET: KE decides directly again.
    const lookup = await lookupTreatment(adapter, company.id, target.id);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') expect(lookup.confidence).toBe('certain');

    const ruleSpy = makeRuleSpy();
    const recovered = await resolveImportDecision(
      adapter, company.id, 'Mostro Pizza', ruleSpy,
    );
    expect(recovered).toEqual({
      source: 'ke',
      glAccountId: 'gl-conflict-exact',
      matchedRuleId: null,
    });
    expect(ruleSpy).not.toHaveBeenCalled();
  });
});

// ─── T8 — tenant isolation ───────────────────────────────────────

describe('T8 — tenant isolation', () => {
  it('cross-company merge is rejected with zero mutation; foreign company knowledge untouched', async () => {
    const companyA = await createFixtureCompany('G8-1 T8 A');
    const companyB = await createFixtureCompany('G8-1 T8 B');

    const sourceA = await createEntity(companyA.id, 'Shared Name Entity');
    const targetA = await createEntity(companyA.id, 'Shared Name Entity B');
    const foreignB = await createEntity(companyB.id, 'Shared Name Entity');

    const learnA = await learnEntityTreatment(
      adapter, companyA.id, sourceA.id, 'gl-a-tx', 'debit', 'user_correction', 'tx-t8a',
    );
    const learnB = await learnEntityTreatment(
      adapter, companyB.id, foreignB.id, 'gl-b-tx', 'debit', 'user_correction', 'tx-t8b',
    );

    // Attempt to merge A's entities under B's company scope → rejected.
    await expect(
      runMerge({
        sourceKnowledgeId: sourceA.id,
        targetKnowledgeId: targetA.id,
        companyId: companyB.id,
        reason: 'T8 cross',
      }),
    ).rejects.toThrow('Company isolation violation');

    // Company A untouched (zero mutation from the rejected attempt).
    const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: sourceA.id } });
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.version).toBe(1);
    const aItem = await readItem(learnA.itemId);
    expect(aItem.status).toBe('active');
    expect((JSON.parse(aItem.content) as { entityId?: string }).entityId).toBe(sourceA.id);

    // Company B untouched.
    const bRow = await prisma.companyKnowledge.findUnique({ where: { id: foreignB.id } });
    expect(bRow!.status).toBe('active');
    const bItem = await readItem(learnB.itemId);
    expect(bItem.status).toBe('active');
    expect((JSON.parse(bItem.content) as { entityId?: string }).entityId).toBe(foreignB.id);

    // A real merge in company A must not leak into company B.
    await runMerge({
      sourceKnowledgeId: sourceA.id,
      targetKnowledgeId: targetA.id,
      companyId: companyA.id,
      reason: 'T8 merge',
    });
    const bItemAfter = await readItem(learnB.itemId);
    expect(bItemAfter.status).toBe('active');
    expect((JSON.parse(bItemAfter.content) as { entityId?: string }).entityId).toBe(foreignB.id);
    const bLookup = await lookupTreatment(adapter, companyB.id, foreignB.id);
    expect(bLookup.status).toBe('FOUND');
    if (bLookup.status === 'FOUND') {
      expect(bLookup.glAccountId).toBe('gl-b-tx');
      expect(bLookup.memoryItemId).toBe(learnB.itemId);
    }
  });
});

// ─── T9 — audit / version / traceability ─────────────────────────

describe('T9 — audit, version, and traceability', () => {
  it('CK audits exist for both sides with KE consolidation trace; item history preserved', async () => {
    const company = await createFixtureCompany('G8-1 T9');
    const source = await createEntity(company.id, 'Mercado Libre');
    const target = await createEntity(company.id, 'Mercado Libre Ads');

    const learn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-t9-ecom', 'credit', 'user_correction', 'tx-t9',
    );
    expect(learn.status).toBe('CREATED');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'T9 duplicate consolidation',
    });

    // CK audits: one per side, action merge, actor recorded.
    const targetAudits = await prisma.knowledgeAudit.findMany({
      where: { knowledgeId: target.id },
    });
    expect(targetAudits).toHaveLength(1);
    expect(targetAudits[0].action).toBe('merge');
    expect(targetAudits[0].changedByUserId).toBe(HUMAN);

    const after = targetAudits[0].afterValue as unknown as {
      knowledgeConsolidation: {
        source: string;
        target: string;
        transferred: Array<{ itemId: string; type: string }>;
        deactivated: Array<{ itemId: string; type: string; reason: string }>;
        humanResolutions: Record<string, unknown>;
      };
    };
    expect(after.knowledgeConsolidation.source).toBe(source.id);
    expect(after.knowledgeConsolidation.target).toBe(target.id);
    expect(
      after.knowledgeConsolidation.transferred.some((t) => t.itemId === learn.itemId),
    ).toBe(true);
    expect(after.knowledgeConsolidation.deactivated).toHaveLength(0);
    expect(after.knowledgeConsolidation.humanResolutions).toEqual({});

    const sourceAudits = await prisma.knowledgeAudit.findMany({
      where: { knowledgeId: source.id },
    });
    expect(sourceAudits).toHaveLength(1);
    const sourceAfter = sourceAudits[0].afterValue as unknown as {
      status: string;
      mergedIntoId: string;
    };
    expect(sourceAfter.status).toBe('merged');
    expect(sourceAfter.mergedIntoId).toBe(target.id);

    // CK versions bumped on both sides.
    const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: source.id } });
    const targetRow = await prisma.companyKnowledge.findUnique({ where: { id: target.id } });
    expect(sourceRow!.version).toBe(2);
    expect(targetRow!.version).toBe(2);

    // MemoryVersion history: initial source-keyed snapshot preserved.
    const versions = await prisma.memoryVersion.findMany({
      where: { itemId: learn.itemId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const v1 = JSON.parse(versions[0].content) as { entityId?: string };
    expect(v1.entityId).toBe(source.id);

    // Traceability: the in-place update logged the previous content.
    const logs = await prisma.traceabilityLog.findMany({ where: { itemId: learn.itemId } });
    const updateLog = logs.find((l) => l.action === 'updated');
    expect(updateLog).toBeDefined();
    const details = updateLog!.details as unknown as { previousContent: string };
    const previous = JSON.parse(details.previousContent) as { entityId?: string };
    expect(previous.entityId).toBe(source.id);
  });
});

// ─── AP1 — compatible patterns (same GL + direction) ─────────────

describe('AP1 — same GL + direction is compatible', () => {
  it('keeps both patterns active under TARGET, source pattern transferred with same itemId', async () => {
    const company = await createFixtureCompany('G8-1 AP1');
    const source = await createEntity(company.id, 'Netflix AR');
    const target = await createEntity(company.id, 'Netflix BR');

    const src = await setupAuthorizedPatternFor(company.id, source.id, 'gl-ap1-shared', 'ap1src');
    const tgt = await setupAuthorizedPatternFor(company.id, target.id, 'gl-ap1-shared', 'ap1tgt');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'AP1',
    });

    const patterns = await getAuthorizedPatterns(adapter, company.id, target.id);
    expect(patterns).toHaveLength(2);
    expect(patterns.every((p) => p.glAccountId === 'gl-ap1-shared')).toBe(true);

    const srcItem = await readItem(src.authId);
    expect(srcItem.status).toBe('active');
    expect((JSON.parse(srcItem.content) as { entityId?: string }).entityId).toBe(target.id);

    const tgtItem = await readItem(tgt.authId);
    expect(tgtItem.status).toBe('active');
    expect((JSON.parse(tgtItem.content) as { entityId?: string }).entityId).toBe(target.id);
  });
});

// ─── AP2 — collision: explicit human choice only ─────────────────

describe('AP2 — same direction, different GL is a collision', () => {
  it('without a choice: rejects with G8_1_COLLISION and zero mutation', async () => {
    const company = await createFixtureCompany('G8-1 AP2 reject');
    const source = await createEntity(company.id, 'Uber Trip A');
    const target = await createEntity(company.id, 'Uber Trip B');

    const src = await setupAuthorizedPatternFor(company.id, source.id, 'gl-ap2-src', 'ap2asrc');
    const tgt = await setupAuthorizedPatternFor(company.id, target.id, 'gl-ap2-tgt', 'ap2atgt');

    const envelope = await captureMergeError({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'AP2 reject',
    });
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe('G8_1_COLLISION');
    expect(envelope!.collisions).toHaveLength(1);
    expect(envelope!.collisions[0].kind).toBe('authorized_pattern');
    expect(envelope!.collisions[0].direction).toBe('any');
    expect(envelope!.collisions[0].source.glAccountId).toBe('gl-ap2-src');
    expect(envelope!.collisions[0].target.glAccountId).toBe('gl-ap2-tgt');

    // Zero mutation.
    const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: source.id } });
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.version).toBe(1);
    const srcItem = await readItem(src.authId);
    expect(srcItem.status).toBe('active');
    expect((JSON.parse(srcItem.content) as { entityId?: string }).entityId).toBe(source.id);
    const tgtItem = await readItem(tgt.authId);
    expect(tgtItem.status).toBe('active');
    expect((JSON.parse(tgtItem.content) as { entityId?: string }).entityId).toBe(target.id);
    const audits = await prisma.knowledgeAudit.findMany({
      where: { knowledgeId: { in: [source.id, target.id] } },
    });
    expect(audits).toHaveLength(0);
  });

  it('with authorizedPatterns.any="source": source pattern wins, target pattern historical', async () => {
    const company = await createFixtureCompany('G8-1 AP2 source');
    const source = await createEntity(company.id, 'Cabify Ride A');
    const target = await createEntity(company.id, 'Cabify Ride B');

    const src = await setupAuthorizedPatternFor(company.id, source.id, 'gl-ap2-wsrc', 'ap2bsrc');
    const tgt = await setupAuthorizedPatternFor(company.id, target.id, 'gl-ap2-wtgt', 'ap2btgt');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      fieldResolutions: { authorizedPatterns: { any: 'source' } },
      reason: 'AP2 source wins',
    });

    const patterns = await getAuthorizedPatterns(adapter, company.id, target.id);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].glAccountId).toBe('gl-ap2-wsrc');

    const srcItem = await readItem(src.authId);
    expect(srcItem.status).toBe('active');
    expect((JSON.parse(srcItem.content) as { entityId?: string }).entityId).toBe(target.id);

    const tgtItem = await readItem(tgt.authId);
    expect(tgtItem.status).toBe('forgotten');
    expect(tgtItem.forgetReason).toBe('entity_merged');
  });

  it('with authorizedPatterns.any="target": target pattern stays, source pattern historical', async () => {
    const company = await createFixtureCompany('G8-1 AP2 target');
    const source = await createEntity(company.id, 'Pedidos Ya A');
    const target = await createEntity(company.id, 'Pedidos Ya B');

    const src = await setupAuthorizedPatternFor(company.id, source.id, 'gl-ap2-csrc', 'ap2csrc');
    const tgt = await setupAuthorizedPatternFor(company.id, target.id, 'gl-ap2-ctgt', 'ap2ctgt');

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      fieldResolutions: { authorizedPatterns: { any: 'target' } },
      reason: 'AP2 target wins',
    });

    const patterns = await getAuthorizedPatterns(adapter, company.id, target.id);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].glAccountId).toBe('gl-ap2-ctgt');

    const tgtItem = await readItem(tgt.authId);
    expect(tgtItem.status).toBe('active');
    expect((JSON.parse(tgtItem.content) as { entityId?: string }).entityId).toBe(target.id);

    const srcItem = await readItem(src.authId);
    expect(srcItem.status).toBe('forgotten');
    expect(srcItem.forgetReason).toBe('entity_merged');
  });
});

// ─── AP3/AP4 — different direction is NOT a collision ────────────

describe('AP3/AP4 — different direction coexists without false conflict', () => {
  it('merges without any choice; both patterns stay active under TARGET', async () => {
    const company = await createFixtureCompany('G8-1 AP3-AP4');
    const source = await createEntity(company.id, 'Falabella Credito');
    const target = await createEntity(company.id, 'Falabella Debito');

    const src = await setupAuthorizedPatternFor(
      company.id, source.id, 'gl-ap3-debit', 'ap3src', 'debit',
    );
    const tgt = await setupAuthorizedPatternFor(
      company.id, target.id, 'gl-ap3-credit', 'ap3tgt', 'credit',
    );

    // No fieldResolutions at all: direction difference must NOT be a collision.
    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'AP3/AP4',
    });

    const patterns = await getAuthorizedPatterns(adapter, company.id, target.id);
    expect(patterns).toHaveLength(2);
    const directions = patterns.map((p) => p.direction).sort();
    expect(directions).toEqual(['credit', 'debit']);
    const gls = patterns.map((p) => p.glAccountId).sort();
    expect(gls).toEqual(['gl-ap3-credit', 'gl-ap3-debit']);

    const srcItem = await readItem(src.authId);
    expect(srcItem.status).toBe('active');
    expect((JSON.parse(srcItem.content) as { entityId?: string }).entityId).toBe(target.id);
  });
});

// ─── OBS — observations TRANSFER_COMBINE ─────────────────────────

describe('OBS — observation transfer with exact-content idempotency', () => {
  it('transfers observations in place, combines duplicates, never creates a logical duplicate', async () => {
    const company = await createFixtureCompany('G8-1 OBS');
    const source = await createEntity(company.id, 'Pago Servicios A');
    const target = await createEntity(company.id, 'Pago Servicios B');

    // Duplicate pair: identical except entityId (byte-identical after transfer).
    const targetObs = await recordClassificationObservation(adapter, company.id, {
      entityId: target.id,
      originalDescription: 'PAGO SERVICE 001',
      glAccountId: 'gl-obs',
      direction: 'debit',
      source: 'user_correction',
      transactionId: 'tx-dup',
    });
    expect(targetObs.ok).toBe(true);

    const sourceDup = await recordClassificationObservation(adapter, company.id, {
      entityId: source.id,
      originalDescription: 'PAGO SERVICE 001',
      glAccountId: 'gl-obs',
      direction: 'debit',
      source: 'user_correction',
      transactionId: 'tx-dup',
    });
    expect(sourceDup.ok).toBe(true);

    const sourceOther = await recordClassificationObservation(adapter, company.id, {
      entityId: source.id,
      originalDescription: 'PAGO SERVICE 777',
      glAccountId: 'gl-obs',
      direction: 'debit',
      source: 'user_correction',
      transactionId: 'tx-other',
    });
    expect(sourceOther.ok).toBe(true);
    const sourceOtherId = sourceOther.observationId;

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'OBS combine',
    });

    // Unique observation transferred in place (same itemId, target-keyed).
    const transferred = await readItem(sourceOtherId);
    expect(transferred.status).toBe('active');
    expect((JSON.parse(transferred.content) as { entityId?: string }).entityId).toBe(target.id);

    // Reader under TARGET: exactly one observation per logical content.
    const readerObservations = await getClassificationObservations(
      adapter, company.id, target.id,
    );
    expect(readerObservations).toHaveLength(2);
    const dupUnderTarget = readerObservations.filter(
      (o) => o.transactionId === 'tx-dup',
    );
    expect(dupUnderTarget).toHaveLength(1);
    const otherUnderTarget = readerObservations.filter(
      (o) => o.transactionId === 'tx-other',
    );
    expect(otherUnderTarget).toHaveLength(1);

    // The source-side duplicate was NOT rewritten into a second copy:
    // no logical duplicate under TARGET; it stays source-keyed history.
    const dupItem = await readItem(sourceDup.observationId);
    expect((JSON.parse(dupItem.content) as { entityId?: string }).entityId).toBe(source.id);

    const activeItems = await prisma.memoryItem.findMany({
      where: { companyId: company.id, type: 'classification_observation', status: 'active' },
    });
    const targetKeyedDupes = activeItems.filter((i) => {
      const c = JSON.parse(i.content) as { entityId?: string; transactionId?: string };
      return c.entityId === target.id && c.transactionId === 'tx-dup';
    });
    expect(targetKeyedDupes).toHaveLength(1);
  });
});

// ─── CAND — structural candidates transfer, never auto-authorize ─

describe('CAND — structural candidate transfer without auto-authorization', () => {
  it('candidate moves to TARGET with itemId/segments/observationIds preserved and stays un-authorized', async () => {
    const company = await createFixtureCompany('G8-1 CAND');
    const source = await createEntity(company.id, 'Spotify Premium A');
    const target = await createEntity(company.id, 'Spotify Premium B');

    const candidateId = await setupCandidateFor(company.id, source.id, 'gl-cand-sub', 'candtag');
    const before = await readItem(candidateId);
    const beforeContent = JSON.parse(before.content) as {
      entityId?: string;
      observationIds: string[];
      segments: unknown[];
    };
    expect(beforeContent.entityId).toBe(source.id);

    await runMerge({
      sourceKnowledgeId: source.id,
      targetKnowledgeId: target.id,
      companyId: company.id,
      reason: 'CAND transfer',
    });

    // Same itemId, target-keyed, evidence preserved byte-for-byte otherwise.
    const after = await readItem(candidateId);
    expect(after.status).toBe('active');
    const afterContent = JSON.parse(after.content) as {
      entityId?: string;
      observationIds: string[];
      segments: unknown[];
      glAccountId: string;
      direction: string;
    };
    expect(afterContent.entityId).toBe(target.id);
    expect(afterContent.observationIds).toEqual(beforeContent.observationIds);
    expect(afterContent.segments).toEqual(beforeContent.segments);
    expect(afterContent.glAccountId).toBe('gl-cand-sub');
    expect(afterContent.direction).toBe('any');

    // Reader under TARGET sees the candidate.
    const candidates = await getStructuralCandidates(adapter, company.id, target.id);
    expect(candidates.some((c) => c.entityId === target.id)).toBe(true);

    // NEVER auto-authorized during merge: no pattern exists.
    const patterns = await getAuthorizedPatterns(adapter, company.id, target.id);
    expect(patterns).toHaveLength(0);
  });
});

// ─── AT1 / AT2 — failure during the KE phase ────────────────────
//
// Fault injection happens ONLY at the MemoryAdapter boundary: the real
// update/forget implementations keep running against the real database
// inside the merge transaction, and a controlled error is thrown before
// a chosen write index. DB persistence, CompanyKnowledge persistence,
// KnowledgeAudit and the merge itself are NOT mocked — rollback depends
// exclusively on real Prisma interactive-transaction behavior.

interface KeFaultState {
  /** Real KE write calls (update/forget) that completed inside the tx. */
  executedWrites: number;
  injected: boolean;
}

function installKeWriteFault(failBeforeWrite: number): {
  state: KeFaultState;
  restore: () => void;
} {
  const state: KeFaultState = { executedWrites: 0, injected: false };
  const realUpdate = MemoryAdapter.prototype.update;
  const realForget = MemoryAdapter.prototype.forget;

  const guard =
    <Args extends unknown[], Result>(real: (...args: Args) => Promise<Result>) =>
    async function (this: MemoryAdapter, ...args: Args): Promise<Result> {
      if (!state.injected && state.executedWrites === failBeforeWrite - 1) {
        state.injected = true;
        throw new Error('G8_1_INJECTED_KE_FAILURE');
      }
      const result = await real.apply(this, args);
      state.executedWrites += 1;
      return result;
    };

  const updateSpy = vi
    .spyOn(MemoryAdapter.prototype, 'update')
    .mockImplementation(guard(realUpdate) as unknown as typeof MemoryAdapter.prototype.update);
  const forgetSpy = vi
    .spyOn(MemoryAdapter.prototype, 'forget')
    .mockImplementation(guard(realForget) as unknown as typeof MemoryAdapter.prototype.forget);

  return {
    state,
    restore: () => {
      updateSpy.mockRestore();
      forgetSpy.mockRestore();
    },
  };
}

/**
 * Real fixture: SOURCE has an exact treatment AND an observation,
 * TARGET has neither — so applyEntityMergeKnowledge performs at least
 * two real KE writes (treatment transfer, then observation transfer).
 */
async function setupAtomicityFixture(tag: string) {
  const company = await createFixtureCompany(`G8-1 ${tag}`);
  const source = await createEntity(company.id, `${tag} Source`);
  const target = await createEntity(company.id, `${tag} Target`);

  const learn = await learnEntityTreatment(
    adapter,
    company.id,
    source.id,
    `gl-${tag}-1`,
    'debit',
    'user_correction',
    `tx-${tag}`,
  );
  if (learn.status !== 'CREATED') {
    throw new Error(`treatment learn failed: ${learn.status}`);
  }

  const obs = await recordClassificationObservation(adapter, company.id, {
    entityId: source.id,
    originalDescription: `${tag} observation description`,
    glAccountId: `gl-${tag}-1`,
    direction: 'debit',
    source: 'user_correction',
    transactionId: `tx-obs-${tag}`,
  });
  if (!obs.ok) throw new Error(`observation failed: ${obs.error}`);

  const sourceObservations = await getClassificationObservations(adapter, company.id, source.id);
  if (sourceObservations.length !== 1) {
    throw new Error(`expected 1 source observation, got ${sourceObservations.length}`);
  }

  return {
    company,
    source,
    target,
    treatmentItemId: learn.itemId,
    auditBefore: await prisma.knowledgeAudit.count({
      where: { knowledgeId: { in: [source.id, target.id] } },
    }),
    versionsBefore: await prisma.memoryVersion.count({
      where: { itemId: learn.itemId },
    }),
  };
}

/** Reads REAL DB state after the rejected merge: everything must be pre-merge. */
async function expectFullyRolledBack(fixture: Awaited<ReturnType<typeof setupAtomicityFixture>>) {
  const { company, source, target, treatmentItemId, auditBefore, versionsBefore } = fixture;

  // CK untouched.
  const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: source.id } });
  const targetRow = await prisma.companyKnowledge.findUnique({ where: { id: target.id } });
  expect(sourceRow!.status).toBe('active');
  expect(sourceRow!.mergedIntoId).toBeNull();
  expect(sourceRow!.version).toBe(1);
  expect(sourceRow!.canonicalName).toBe(source.canonicalName);
  expect(targetRow!.version).toBe(1);
  expect(targetRow!.canonicalName).toBe(target.canonicalName);

  // KE untouched: treatment still source-keyed and active.
  const treatment = await readItem(treatmentItemId);
  expect(treatment.status).toBe('active');
  expect((JSON.parse(treatment.content) as { entityId?: string }).entityId).toBe(source.id);
  expect(await lookupTreatment(adapter, company.id, source.id)).toMatchObject({ status: 'FOUND' });
  expect(await lookupTreatment(adapter, company.id, target.id)).toMatchObject({ status: 'NOT_FOUND' });

  // KE untouched: observation still source-keyed.
  expect(await getClassificationObservations(adapter, company.id, source.id)).toHaveLength(1);
  expect(await getClassificationObservations(adapter, company.id, target.id)).toHaveLength(0);

  // KE history untouched (no version rows written by the failed tx).
  expect(
    await prisma.memoryVersion.count({ where: { itemId: treatmentItemId } }),
  ).toBe(versionsBefore);

  // No KnowledgeAudit row from the failed merge.
  expect(
    await prisma.knowledgeAudit.count({
      where: { knowledgeId: { in: [source.id, target.id] } },
    }),
  ).toBe(auditBefore);
}

describe('AT1 — failure inside the KE phase rolls back CK + KE + audit', () => {
  it('throws before the first KE write (CK updates already executed in the tx) and leaves zero residue', async () => {
    const fixture = await setupAtomicityFixture('AT1');
    const fault = installKeWriteFault(1);
    try {
      await expect(
        runMerge({
          sourceKnowledgeId: fixture.source.id,
          targetKnowledgeId: fixture.target.id,
          companyId: fixture.company.id,
          reason: 'AT1 injected KE failure',
        }),
      ).rejects.toThrow('G8_1_INJECTED_KE_FAILURE');
    } finally {
      fault.restore();
    }

    expect(fault.state.injected).toBe(true);
    expect(fault.state.executedWrites).toBe(0);
    await expectFullyRolledBack(fixture);
  });
});

describe('AT2 — a KE write completed before the failure does not survive rollback', () => {
  it('executes the treatment transfer inside the tx, then fails on the observation transfer; rollback erases both CK and KE', async () => {
    const fixture = await setupAtomicityFixture('AT2');
    const fault = installKeWriteFault(2);
    try {
      await expect(
        runMerge({
          sourceKnowledgeId: fixture.source.id,
          targetKnowledgeId: fixture.target.id,
          companyId: fixture.company.id,
          reason: 'AT2 injected KE failure after first KE write',
        }),
      ).rejects.toThrow('G8_1_INJECTED_KE_FAILURE');
    } finally {
      fault.restore();
    }

    // AT2 causal proof: one REAL KE write completed before the failure…
    expect(fault.state.injected).toBe(true);
    expect(fault.state.executedWrites).toBe(1);

    // …and it did not survive: treatment still source-keyed (the
    // non-atomic alternative would leave entityId=target.id persisted).
    await expectFullyRolledBack(fixture);
  });
});

// ─── ATOMIC — single-transaction rollback ────────────────────────

describe('ATOMIC — CK and KE writes share one transaction', () => {
  it('an audit-stage failure rolls back CK updates and KE transfers together', async () => {
    const company = await createFixtureCompany('G8-1 ATOMIC');
    const source = await createEntity(company.id, 'Atomic Source');
    const target = await createEntity(company.id, 'Atomic Target');

    const learn = await learnEntityTreatment(
      adapter, company.id, source.id, 'gl-atomic-1', 'debit', 'user_correction', 'tx-atomic',
    );
    expect(learn.status).toBe('CREATED');

    // No request context → appendAuditEntry throws AUTH_REQUIRED INSIDE the
    // transaction, AFTER the CK updates and the KE transfer already ran.
    await expect(
      merge({
        sourceKnowledgeId: source.id,
        targetKnowledgeId: target.id,
        companyId: company.id,
        fieldResolutions: {},
        reason: 'ATOMIC',
      }),
    ).rejects.toThrow('Authentication required');

    // Nothing may persist: CK untouched.
    const sourceRow = await prisma.companyKnowledge.findUnique({ where: { id: source.id } });
    const targetRow = await prisma.companyKnowledge.findUnique({ where: { id: target.id } });
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.mergedIntoId).toBeNull();
    expect(sourceRow!.version).toBe(1);
    expect(targetRow!.version).toBe(1);

    // KE transfer rolled back: treatment still source-keyed, active.
    const item = await readItem(learn.itemId);
    expect(item.status).toBe('active');
    expect((JSON.parse(item.content) as { entityId?: string }).entityId).toBe(source.id);
    const lookupSource = await lookupTreatment(adapter, company.id, source.id);
    expect(lookupSource.status).toBe('FOUND');
    const lookupTarget = await lookupTreatment(adapter, company.id, target.id);
    expect(lookupTarget.status).toBe('NOT_FOUND');

    // No audit rows written.
    const audits = await prisma.knowledgeAudit.findMany({
      where: { knowledgeId: { in: [source.id, target.id] } },
    });
    expect(audits).toHaveLength(0);
  });
});
