// KE-CONFLICT-UI-001 — Integration tests (T31–T36)
// Full REAL Knowledge Engine pipeline (observations → structural candidate
// → authorization → conflict detection → degradation → explicit resolution
// → rehabilitation) driven through the API route handlers.
//
// Wiring under test, not domain semantics (see tests/memory/rehabilitation.test.ts
// for the KE-EVOL-005 domain suite).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';


import { createKeMockDb } from '../helpers/ke-conflict-mock-db';
import { db as mockDb } from '@/lib/db';

const harness = vi.hoisted(() => ({
  context: { userId: 'user-1', companyId: 'company-a' } as { userId: string; companyId: string } | null,
}));

vi.mock('@/lib/db', () => ({ db: createKeMockDb() }));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
}));

vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(() => {
    if (!harness.context) throw new Error('unauthenticated');
    return harness.context;
  }),
}));

vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(async () => undefined),
}));

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn(async () => ({})),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports after mocks ─────────────────────────────────────────

import { GET } from '../../src/app/api/learning/classification-conflicts/route';
import { POST as POST_RESOLVE } from '../../src/app/api/learning/classification-conflicts/[id]/resolve/route';
import { POST as POST_REHAB } from '../../src/app/api/learning/classification-conflicts/[id]/rehabilitate/route';
import { createAdapter } from '@/memory/classification-knowledge';
import type { MemoryPrismaClient } from '@/memory/prisma-types';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const GL_A = 'gl-a';
const GL_B = 'gl-b';
const ACTOR = 'user-1';

function makeAdapter() {
  return createAdapter(mockDb as unknown as MemoryPrismaClient, (fn) => mockDb.$transaction(fn as never));
}

/** Full real pipeline: unresolved OBSERVATION_VS_AUTHORIZED conflict + pattern degraded to uncertain. */
async function seedRealPendingConflict(companyId: string, entityId: string, suffix: string) {
  const adapter = makeAdapter();
  const { recordClassificationObservation, discoverStructuralCandidateForGroup, recordStructuralCandidate, authorizeStructuralCandidate, detectConflictingPattern, degradeKnowledgeOnConflict } =
    await import('@/memory/classification-knowledge');
  type StructuralGroupKey = Parameters<typeof discoverStructuralCandidateForGroup>[1];

  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `ABC ${i * 111} ${entityId}`,
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-seed-${companyId}-${entityId}-${i}`,
    });
    if (!obs.ok) throw new Error('seed observation failed');
  }
  const groupKey: StructuralGroupKey = { companyId, entityId, glAccountId: GL_A, direction: 'any' };
  const disc = await discoverStructuralCandidateForGroup(adapter, groupKey);
  if (disc.kind !== 'candidate') throw new Error(`seed discovery failed: ${JSON.stringify(disc)}`);
  const rec = await recordStructuralCandidate(adapter, disc.candidate);
  if (!rec.ok) throw new Error('seed candidate failed');
  const auth = await authorizeStructuralCandidate(adapter, companyId, rec.candidateId, ACTOR);
  if (auth.status !== 'AUTHORIZED' && auth.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`seed authorize failed: ${auth.status}`);
  }
  const patternId = auth.authorizedPatternId;

  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `ABC 999 ${entityId}`,
    glAccountId: GL_B,
    direction: 'any',
    source: 'user_correction',
    transactionId: `tx-obsconflict-${companyId}-${suffix}`,
  });
  if (!obs.ok) throw new Error('seed conflicting observation failed');

  const detect = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`seed detect failed: ${detect.status}`);

  const degraded = await degradeKnowledgeOnConflict(adapter, companyId, detect.conflictId);
  if (degraded.status !== 'UPDATED' && degraded.status !== 'UNCHANGED') {
    throw new Error(`seed degrade failed: ${degraded.status}`);
  }
  return { conflictId: detect.conflictId, patternId };
}

async function listConflicts(): Promise<Record<string, unknown>> {
  const res = await GET(
    new NextRequest('http://localhost/api/learning/classification-conflicts', { method: 'GET' }),
    { params: Promise.resolve({}) },
  );
  return (await res.json()) as Record<string, unknown>;
}

function resolveBody(reason: string) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutionReason: reason }),
  } as const;
}

function rehabBody(knowledgeItemId: string) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knowledgeItemId }),
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.reset();
  harness.context = { userId: ACTOR, companyId: COMPANY_A };
});

describe('T31–T36 — conflict lifecycle through the API (real pipeline)', () => {
  it('T31: a pending conflict created by real detection appears via the API', async () => {
    const { conflictId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'a');
    const body = await listConflicts();
    const conflicts = body.conflicts as Array<Record<string, unknown>>;
    expect(conflicts.map((c) => c.conflictItemId)).toContain(conflictId);
  });

  it('T32: explicit resolution removes the conflict from pending', async () => {
    const { conflictId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'a');
    const res = await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, resolveBody('kept GL-B per approval')),
      { params: Promise.resolve({ id: conflictId }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).status).toBe('RESOLVED');
    const body = await listConflicts();
    const conflicts = body.conflicts as Array<Record<string, unknown>>;
    expect(conflicts.map((c) => c.conflictItemId)).not.toContain(conflictId);
  });

  it('T33: resolve alone leaves the knowledge uncertain', async () => {
    const { conflictId, patternId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'a');
    expect(mockDb._store.get(patternId)?.confidence).toBe('uncertain');
    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, resolveBody('kept GL-B per approval')),
      { params: Promise.resolve({ id: conflictId }) },
    );
    expect(mockDb._store.get(patternId)?.confidence).toBe('uncertain');
  });

  it('T34: subsequent rehabilitation uncertain → certain', async () => {
    const { conflictId, patternId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'a');
    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, resolveBody('kept GL-B per approval')),
      { params: Promise.resolve({ id: conflictId }) },
    );
    const res = await POST_REHAB(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/rehabilitate`, rehabBody(patternId)),
      { params: Promise.resolve({ id: conflictId }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).status).toBe('REHABILITATED');
    expect(mockDb._store.get(patternId)?.confidence).toBe('certain');
  });

  it('T35: rehabilitated certain knowledge regains authority via existing behavior', async () => {
    const { conflictId, patternId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'a');
    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, resolveBody('kept GL-B per approval')),
      { params: Promise.resolve({ id: conflictId }) },
    );
    await POST_REHAB(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/rehabilitate`, rehabBody(patternId)),
      { params: Promise.resolve({ id: conflictId }) },
    );

    // Existing authority lookup: the pattern must match again with GL_A
    const { matchAuthorizedPattern } = await import('@/memory/classification-knowledge');
    const match = await matchAuthorizedPattern(makeAdapter(), COMPANY_A, 'entity-1', 'ABC 555 entity-1', 'any');
    expect(match.kind).toBe('match');
    if (match.kind === 'match') {
      expect(match.glAccountId).toBe(GL_A);
      expect(match.confidence).toBe('certain');
    }
  });

  it('T36: another pending conflict blocks rehabilitation', async () => {
    const adapter = makeAdapter();
    const { recordClassificationObservation, detectConflictingPattern } =
      await import('@/memory/classification-knowledge');

    const { conflictId: conflictA, patternId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'a');
    // Second pending conflict implicating the same pattern (different GL → real new conflict)
    const obs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: 'entity-1',
      originalDescription: 'ABC 888 entity-1',
      glAccountId: 'gl-c',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-obsconflict-blocker',
    });
    if (!obs.ok) throw new Error('seed obs blocker failed');
    const blocker = await detectConflictingPattern(adapter, COMPANY_A, 'entity-1', 'any');
    if (blocker.status !== 'RECORDED') throw new Error(`blocker detect: ${blocker.status}`);

    // seedRealPendingConflict already degraded the pattern to 'uncertain'

    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictA}/resolve`, resolveBody('kept GL-B per approval')),
      { params: Promise.resolve({ id: conflictA }) },
    );

    const res = await POST_REHAB(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictA}/rehabilitate`, rehabBody(patternId)),
      { params: Promise.resolve({ id: conflictA }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('OTHER_PENDING_CONFLICT');
    expect(body.blockingConflictItemIds).toEqual([blocker.conflictId]);
    // Nothing was rehabilitated
    expect(mockDb._store.get(patternId)?.confidence).toBe('uncertain');
  });
});
