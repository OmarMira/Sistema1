// AUDIT-SIDE-EFFECT-001 — T1–T18
// An audit failure must NEVER convert a successfully persisted domain
// operation into an HTTP failure, in any of the three affected surfaces:
//   resolve (classification conflict) / rehabilitate (knowledge) / authorize
//   (structural pattern).
// Precedent pattern: conversational-parse try/catch + logger.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AppError } from '@/lib/api-error';

import { createKeMockDb } from '../helpers/ke-conflict-mock-db';
import { db as mockDb } from '@/lib/db';

const harness = vi.hoisted(() => ({
  context: { userId: 'user-1', companyId: 'company-a' } as { userId: string; companyId: string } | null,
  roleError: null as Error | null,
}));

vi.mock('@/lib/db', () => ({ db: createKeMockDb() }));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
}));

vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(() => {
    if (!harness.context) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
    return harness.context;
  }),
}));

vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(async () => {
    if (harness.roleError) throw harness.roleError;
    return undefined;
  }),
}));

const auditMock = vi.hoisted(() => ({ fn: null as ((...args: unknown[]) => unknown) | null }));

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn(async (...args: unknown[]) => {
    if (auditMock.fn) return auditMock.fn(...args);
    return {};
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports after mocks ─────────────────────────────────────────

import { logger } from '@/lib/logger';
import { safeAuditLog } from '@/lib/services/audit-service';
import { POST as POST_RESOLVE } from '../../src/app/api/learning/classification-conflicts/[id]/resolve/route';
import { POST as POST_REHAB } from '../../src/app/api/learning/classification-conflicts/[id]/rehabilitate/route';
import { POST as POST_AUTHORIZE } from '../../src/app/api/learning/structural-candidates/[id]/authorize/route';
import {
  createAdapter,
  recordClassificationObservation,
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
} from '@/memory/classification-knowledge';
import type { MemoryPrismaClient } from '@/memory/prisma-types';

const COMPANY_A = 'company-a';
const GL_A = 'gl-a';
const GL_B = 'gl-b';
const ACTOR = 'user-1';

function makeAdapter() {
  return createAdapter(mockDb as unknown as MemoryPrismaClient, (fn) => mockDb.$transaction(fn as never));
}

/** Real pending OBSERVATION_VS_AUTHORIZED conflict + degraded pattern. */
async function seedRealPendingConflict(companyId: string, entityId: string, suffix: string) {
  const adapter = makeAdapter();
  for (let i = 1; i <= 2; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `ABC ${i * 111} ${entityId}`,
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-seed-${companyId}-${entityId}-${i}-${suffix}`,
    });
    if (!obs.ok) throw new Error('seed observation failed');
  }
  const { discoverStructuralCandidateForGroup: disc, recordStructuralCandidate: rec, authorizeStructuralCandidate: auth } =
    await import('@/memory/classification-knowledge');
  type GroupKey = Parameters<typeof disc>[1];
  const groupKey: GroupKey = { companyId, entityId, glAccountId: GL_A, direction: 'any' };
  const discovery = await disc(adapter, groupKey);
  if (discovery.kind !== 'candidate') throw new Error('seed discovery failed');
  const record = await rec(adapter, discovery.candidate);
  if (!record.ok) throw new Error('seed record failed');
  const authorization = await auth(adapter, companyId, record.candidateId, ACTOR);
  if (authorization.status !== 'AUTHORIZED' && authorization.status !== 'ALREADY_AUTHORIZED') {
    throw new Error(`seed authorize failed: ${authorization.status}`);
  }
  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: `ABC 999 ${entityId}`,
    glAccountId: GL_B,
    direction: 'any',
    source: 'user_correction',
    transactionId: `tx-conflict-${companyId}-${suffix}`,
  });
  if (!obs.ok) throw new Error('seed conflicting observation failed');
  const detect = await detectConflictingPatternFn(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`seed detect failed: ${detect.status}`);
  await degradeKnowledgeOnConflictFn(adapter, companyId, detect.conflictId);
  return { conflictId: detect.conflictId, patternId: authorization.status === 'AUTHORIZED' ? authorization.authorizedPatternId : (authorization as { authorizedPatternId: string }).authorizedPatternId };
}

async function detectConflictingPatternFn(adapter: ReturnType<typeof makeAdapter>, companyId: string, entityId: string, direction: 'any') {
  const { detectConflictingPattern } = await import('@/memory/classification-knowledge');
  return detectConflictingPattern(adapter, companyId, entityId, direction);
}

async function degradeKnowledgeOnConflictFn(adapter: ReturnType<typeof makeAdapter>, companyId: string, conflictId: string) {
  const { degradeKnowledgeOnConflict } = await import('@/memory/classification-knowledge');
  return degradeKnowledgeOnConflict(adapter, companyId, conflictId);
}

/** Real candidate via discovery + record (no authorization). */
async function seedPendingCandidate() {
  await recordClassificationObservation(makeAdapter(), COMPANY_A, {
    entityId: 'entity-1',
    originalDescription: 'ABC 111 entity-1',
    glAccountId: GL_A,
    direction: 'any',
    source: 'user_correction',
    transactionId: 'tx-cand-1',
  });
  await recordClassificationObservation(makeAdapter(), COMPANY_A, {
    entityId: 'entity-1',
    originalDescription: 'ABC 222 entity-1',
    glAccountId: GL_A,
    direction: 'any',
    source: 'user_correction',
    transactionId: 'tx-cand-2',
  });
  const adapter = makeAdapter();
  const discovery = await discoverStructuralCandidateForGroup(adapter, {
    companyId: COMPANY_A,
    entityId: 'entity-1',
    glAccountId: GL_A,
    direction: 'any',
  });
  if (discovery.kind !== 'candidate') throw new Error('seed discovery failed');
  const record = await recordStructuralCandidate(adapter, discovery.candidate);
  if (!record.ok) throw new Error('seed record failed');
  return record.candidateId;
}

function resolveRequest(conflictId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rehabRequest(conflictId: string, knowledgeItemId: string) {
  return new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/rehabilitate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knowledgeItemId }),
  });
}

function authorizeRequest(candidateId: string) {
  return new NextRequest(`http://localhost/api/learning/structural-candidates/${candidateId}/authorize`, {
    method: 'POST',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.reset();
  harness.context = { userId: ACTOR, companyId: COMPANY_A };
  harness.roleError = null;
  auditMock.fn = null;
});

describe('AUDIT-SIDE-EFFECT-001 — resolve (T1–T4, T13, T15)', () => {
  it('T1+T2+T3: domain resolution succeeds, safeAuditLog rejects, endpoint STILL returns the successful response', async () => {
    const { conflictId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'r1');
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };

    const res = await POST_RESOLVE(resolveRequest(conflictId, { resolutionReason: 'valid reason' }), {
      params: Promise.resolve({ id: conflictId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('RESOLVED');
    expect(body.resolutionId).toBeTruthy();

    // T4: resolution persisted exactly once.
    const resolutions = Array.from(mockDb._store.values()).filter(
      (i) => i.type === 'classification_conflict_resolution',
    );
    expect(resolutions).toHaveLength(1);
  });

  it('T13: audit failure is logged/observable', async () => {
    const { conflictId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'r2');
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };
    await POST_RESOLVE(resolveRequest(conflictId, { resolutionReason: 'valid reason' }), {
      params: Promise.resolve({ id: conflictId }),
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('T14: audit success path remains unchanged (audit still invoked once)', async () => {
    const { conflictId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'r3');
    const res = await POST_RESOLVE(resolveRequest(conflictId, { resolutionReason: 'valid reason' }), {
      params: Promise.resolve({ id: conflictId }),
    });
    expect(res.status).toBe(200);
    expect(safeAuditLog).toHaveBeenCalledTimes(1);
  });

  it('T15: domain failure remains failure — audit handling cannot convert it into success', async () => {
    await seedRealPendingConflict(COMPANY_A, 'entity-1', 'r4');
    // Nonexistent conflict → domain NOT_FOUND → 404 regardless of audit.
    const res = await POST_RESOLVE(resolveRequest('mem_missing', { resolutionReason: 'x' }), {
      params: Promise.resolve({ id: 'mem_missing' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('AUDIT-SIDE-EFFECT-001 — rehabilitate (T5–T8)', () => {
  it('T5+T6+T7: domain rehabilitation succeeds, audit rejects, endpoint STILL returns success', async () => {
    const { conflictId, patternId } = await seedRealPendingConflict(COMPANY_A, 'entity-1', 'h1');
    // Rehabilitation precondition: the conflict must be explicitly resolved first.
    const { resolveClassificationConflict } = await import('@/memory/classification-knowledge');
    const resolution = await resolveClassificationConflict(
      makeAdapter(),
      COMPANY_A,
      conflictId,
      ACTOR,
      'seed resolution for rehabilitation test',
    );
    if (resolution.status !== 'RESOLVED') throw new Error(`seed resolve failed: ${resolution.status}`);
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };

    const res = await POST_REHAB(rehabRequest(conflictId, patternId), {
      params: Promise.resolve({ id: conflictId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('REHABILITATED');

    // T8: rehabilitation persisted exactly once (event + pattern at certain).
    const events = Array.from(mockDb._store.values()).filter(
      (i) => i.type === 'classification_rehabilitation_event',
    );
    expect(events).toHaveLength(1);
    expect(mockDb._store.get(patternId)?.confidence).toBe('certain');
  });
});

describe('AUDIT-SIDE-EFFECT-001 — authorize (T9–T12, T18)', () => {
  it('T9+T10+T11: domain authorization succeeds, audit rejects, endpoint STILL returns AUTHORIZED', async () => {
    const candidateId = await seedPendingCandidate();
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };

    const res = await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('AUTHORIZED');
    expect(body.authorizedPatternId).toBeTruthy();

    // T12: authorized pattern persisted exactly once.
    const patterns = Array.from(mockDb._store.values()).filter(
      (i) => i.type === 'classification_authorized_pattern',
    );
    expect(patterns).toHaveLength(1);

    // T18: ALREADY_AUTHORIZED behavior unchanged under audit failure.
    const second = await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.status).toBe('ALREADY_AUTHORIZED');
  });
});

describe('AUDIT-SIDE-EFFECT-001 — T16+T17 isolation unchanged', () => {
  it('T16: tenant isolation unchanged (foreign candidate still 404 under audit failure)', async () => {
    const foreignCandidateId = 'mem-foreign';
    mockDb._seedRaw({
      id: foreignCandidateId,
      content: JSON.stringify({
        companyId: 'company-b',
        entityId: 'entity-b',
        glAccountId: GL_A,
        direction: 'any',
        segments: [{ kind: 'stable', value: 'abc' }],
        observationIds: ['obs-b-1', 'obs-b-2'],
      }),
      type: 'classification_structural_candidate',
      status: 'active',
      confidence: 'tentative',
      companyId: 'company-b',
      sourceAuthor: 'system',
      sourceName: 'structural_discovery',
    });
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };
    const res = await POST_AUTHORIZE(authorizeRequest(foreignCandidateId), {
      params: Promise.resolve({ id: foreignCandidateId }),
    });
    expect(res.status).toBe(404);
  });

  it('T17: RBAC unchanged (role rejection still happens before any domain/audit work)', async () => {
    harness.roleError = new AppError(403, 'Forbidden', 'FORBIDDEN');
    await expect(
      POST_AUTHORIZE(authorizeRequest('mem_1'), { params: Promise.resolve({ id: 'mem_1' }) }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
