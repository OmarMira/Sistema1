// KE-CONFLICT-UI-001 — API wiring tests (T1–T21)
// GET /api/learning/classification-conflicts
// POST /api/learning/classification-conflicts/[id]/resolve
// POST /api/learning/classification-conflicts/[id]/rehabilitate
//
// REAL domain operations (getPendingConflicts / resolveClassificationConflict /
// rehabilitateClassificationKnowledge) run against the shared in-memory
// MemoryItem harness, so these tests prove the WIRING (context, RBAC, actor
// provenance, outcome→HTTP mapping, audit), not KE-EVOL-004/005 semantics.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AppError } from '@/lib/api-error';
import { createKeMockDb, type KeMockDb } from '../helpers/ke-conflict-mock-db';

// ─── Harness state (per-test configurable) ───────────────────────

import { db as mockDb } from '@/lib/db';

const harness = vi.hoisted(() => ({
  context: { userId: 'user-1', companyId: 'company-a' },
  roleError: null as Error | null,
}));

vi.mock('@/lib/db', () => ({ db: createKeMockDb() }));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
}));

vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(() => {
    if (!harness.context) {
      throw new AppError(403, 'Company context required', 'COMPANY_CONTEXT_REQUIRED');
    }
    return harness.context;
  }),
}));

vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(async (companyId: string, _roles: string[]) => {
    if (harness.roleError) throw harness.roleError;
    return { companyId };
  }),
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
import { safeAuditLog } from '@/lib/services/audit-service';
import { requireCompanyRole } from '@/lib/rbac';
import type { MemoryPrismaClient, TransactionRunner } from '@/memory/prisma-types';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const GL_A = 'gl-a';
const GL_B = 'gl-b';

let requireCompanyRoleMock: ReturnType<typeof vi.fn>;
let safeAuditLogMock: ReturnType<typeof vi.fn>;

function makeAdapter() {
  return createAdapter(mockDb as unknown as MemoryPrismaClient, (fn) => mockDb.$transaction(fn as never));
}

async function seedPendingObservationConflict(
  companyId: string,
  entityId: string,
  suffix: string,
): Promise<{ conflictId: string; patternId: string }> {
  const adapter = makeAdapter();
  const { recordClassificationObservation, discoverStructuralCandidateForGroup, recordStructuralCandidate, authorizeStructuralCandidate, detectConflictingPattern } =
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
  const auth = await authorizeStructuralCandidate(adapter, companyId, rec.candidateId, 'seed-admin');
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
    transactionId: `tx-obsconflict-${suffix}`,
  });
  if (!obs.ok) throw new Error('seed conflicting observation failed');

  const detect = await detectConflictingPattern(adapter, companyId, entityId, 'any');
  if (detect.status !== 'RECORDED') throw new Error(`seed detect failed: ${detect.status}`);
  return { conflictId: detect.conflictId, patternId };
}

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/learning/classification-conflicts', {
    method: 'GET',
  });
}

async function getJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.reset();
  harness.context = { userId: 'user-1', companyId: 'company-a' };
  harness.roleError = null;
  safeAuditLogMock = vi.mocked(safeAuditLog);
  requireCompanyRoleMock = vi.mocked(requireCompanyRole);
});

// ─── GET: listing ────────────────────────────────────────────────

describe('T1–T5 — GET /api/learning/classification-conflicts', () => {
  it('T1: a company sees only its own conflicts', async () => {
    const a = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    await seedPendingObservationConflict(COMPANY_B, 'entity-2', 'b');

    const res = await GET(getRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.success).toBe(true);
    const conflicts = body.conflicts as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictItemId).toBe(a.conflictId);
  });

  it('T2: cross-tenant conflict does not leak existence', async () => {
    const b = await seedPendingObservationConflict(COMPANY_B, 'entity-2', 'b');

    const res = await GET(getRequest(), { params: Promise.resolve({}) });
    const body = await getJson(res);
    const conflicts = body.conflicts as Array<Record<string, unknown>>;
    expect(conflicts.map((c) => c.conflictItemId)).not.toContain(b.conflictId);
    // Resolve route against the foreign conflict id → tenant-safe absence
    const resolveRes = await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${b.conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionReason: 'foreign attempt' }),
      }),
      { params: Promise.resolve({ id: b.conflictId }) },
    );
    expect(resolveRes.status).toBe(404);
  });

  it('T3: unauthenticated (no company context) rejected', async () => {
    harness.context = null;
    await expect(GET(getRequest(), { params: Promise.resolve({}) })).rejects.toBeInstanceOf(AppError);
  });

  it('T4: non-company_admin role rejected', async () => {
    harness.roleError = new AppError(403, 'Forbidden', 'FORBIDDEN');
    await expect(GET(getRequest(), { params: Promise.resolve({}) })).rejects.toBeInstanceOf(AppError);
    expect(requireCompanyRoleMock).toHaveBeenCalledWith(COMPANY_A, ['company_admin']);
  });

  it('T5: company_admin can list pending conflicts', async () => {
    await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    requireCompanyRoleMock.mockClear();
    const res = await GET(getRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(requireCompanyRoleMock).toHaveBeenCalledWith(COMPANY_A, ['company_admin']);
    const body = await getJson(res);
    expect((body.conflicts as unknown[]).length).toBe(1);
  });
});

// ─── POST resolve ────────────────────────────────────────────────

describe('T6–T11 — resolve endpoint', () => {
  async function sendResolve(conflictId: string, body: unknown): Promise<Response> {
    return POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: conflictId }) },
    );
  }

  function storedItems(type: string) {
    return Array.from(mockDb._store.values()).filter(
      (i) => i.type === type && i.companyId === COMPANY_A,
    );
  }

  it('T6: resolve requires a non-empty resolutionReason', async () => {
    const { conflictId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    const missing = await sendResolve(conflictId, {});
    expect(missing.status).toBe(400);
    const empty = await sendResolve(conflictId, { resolutionReason: '   ' });
    expect(empty.status).toBe(400);
  });

  it('T7: resolvedBy comes from the session, never from the client body', async () => {
    const { conflictId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    const res = await sendResolve(conflictId, {
      resolutionReason: 'kept GL-B per supervisor email',
      resolvedBy: 'attacker-override',
    });
    expect(res.status).toBe(200);
    const stored = storedItems('classification_conflict_resolution');
    expect(stored).toHaveLength(1);
    const parsed = JSON.parse(stored[0].content) as { resolvedBy: string };
    expect(parsed.resolvedBy).toBe('user-1');
    expect(parsed.resolvedBy).not.toBe('attacker-override');
  });

  it('T8: resolve invokes the EXISTING domain operation (persisted resolution record)', async () => {
    const { conflictId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    const res = await sendResolve(conflictId, { resolutionReason: 'valid reason' });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.status).toBe('RESOLVED');
    expect(storedItems('classification_conflict_resolution')).toHaveLength(1);
    expect(safeAuditLogMock).toHaveBeenCalledTimes(1);
  });

  it('T9: successful resolve does NOT change any confidence', async () => {
    const { conflictId, patternId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    const beforeConfidence = mockDb._store.get(patternId)?.confidence;
    const res = await sendResolve(conflictId, { resolutionReason: 'valid reason' });
    expect(res.status).toBe(200);
    expect(mockDb._store.get(patternId)?.confidence).toBe(beforeConfidence);
  });

  it('T10: successful resolve does NOT rehabilitate anything', async () => {
    const { conflictId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    const res = await sendResolve(conflictId, { resolutionReason: 'valid reason' });
    expect(res.status).toBe(200);
    expect(storedItems('classification_rehabilitation_event')).toHaveLength(0);
  });

  it('T11: idempotent resolution exposed as ALREADY_RESOLVED with same resolutionId', async () => {
    const { conflictId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    const first = await sendResolve(conflictId, { resolutionReason: 'valid reason' });
    expect(first.status).toBe(200);
    const firstBody = await getJson(first);
    const second = await sendResolve(conflictId, { resolutionReason: 'valid reason again' });
    expect(second.status).toBe(200);
    const secondBody = await getJson(second);
    expect(secondBody.status).toBe('ALREADY_RESOLVED');
    expect(secondBody.resolutionId).toBe(firstBody.resolutionId);
  });
});

// ─── POST rehabilitate ───────────────────────────────────────────

describe('T12–T21 — rehabilitate endpoint', () => {
  function storedItems(type: string) {
    return Array.from(mockDb._store.values()).filter(
      (i) => i.type === type && i.companyId === COMPANY_A,
    );
  }

  async function sendRehab(conflictId: string, body: unknown): Promise<Response> {
    return POST_REHAB(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/rehabilitate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: conflictId }) },
    );
  }

  async function resolvedConflictWithUncertainPattern(entityId: string, suffix: string) {
    const { conflictId, patternId } = await seedPendingObservationConflict(COMPANY_A, entityId, suffix);
    mockDb._store.get(patternId)!.confidence = 'uncertain';
    const resolveRes = await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionReason: 'valid reason' }),
      }),
      { params: Promise.resolve({ id: conflictId }) },
    );
    expect(resolveRes.status).toBe(200);
    return { conflictId, patternId };
  }

  it('T12: rehabilitate requires conflictItemId (param) AND knowledgeItemId (body)', async () => {
    const missingBody = await POST_REHAB(
      new NextRequest('http://localhost/api/learning/classification-conflicts/c1/rehabilitate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(missingBody.status).toBe(400);
  });

  it('T13: rehabilitatedBy comes from the session, never from the client body', async () => {
    const { conflictId, patternId } = await resolvedConflictWithUncertainPattern('entity-1', 'a');
    const res = await sendRehab(conflictId, { knowledgeItemId: patternId, rehabilitatedBy: 'attacker-override' });
    expect(res.status).toBe(200);
    const events = storedItems('classification_rehabilitation_event');
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0].content) as { rehabilitatedBy: string };
    expect(parsed.rehabilitatedBy).toBe('user-1');
    expect(parsed.rehabilitatedBy).not.toBe('attacker-override');
  });

  it('T14: REHABILITATED correctly exposed (confidence → certain via existing path)', async () => {
    const { conflictId, patternId } = await resolvedConflictWithUncertainPattern('entity-1', 'a');
    const res = await sendRehab(conflictId, { knowledgeItemId: patternId });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body).toEqual({
      success: true,
      status: 'REHABILITATED',
      knowledgeItemId: patternId,
      conflictItemId: conflictId,
      rehabilitationEventId: expect.any(String),
    });
    expect(mockDb._store.get(patternId)?.confidence).toBe('certain');
    // resolve (done by the helper) + rehabilitate: both are productive audits
    expect(safeAuditLogMock).toHaveBeenCalledTimes(2);
    const rehabAudit = vi.mocked(safeAuditLog).mock.calls.find(
      (c) => (c[0] as { action: string }).action === 'CLASSIFICATION_KNOWLEDGE_REHABILITATED',
    );
    expect(rehabAudit).toBeTruthy();
  });

  it('T15: ALREADY_CERTAIN correctly exposed', async () => {
    const { conflictId, patternId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    // Resolve WITHOUT degrading: the implicated pattern stays certain.
    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionReason: 'valid reason' }),
      }),
      { params: Promise.resolve({ id: conflictId }) },
    );
    const res = await sendRehab(conflictId, { knowledgeItemId: patternId });
    expect(res.status).toBe(200);
    expect((await getJson(res)).status).toBe('ALREADY_CERTAIN');
  });

  it('T16: CONFLICT_NOT_RESOLVED correctly exposed as business refusal (409)', async () => {
    const { conflictId, patternId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    mockDb._store.get(patternId)!.confidence = 'uncertain';
    const res = await sendRehab(conflictId, { knowledgeItemId: patternId });
    expect(res.status).toBe(409);
    expect((await getJson(res)).status).toBe('CONFLICT_NOT_RESOLVED');
  });

  it('T17: OTHER_PENDING_CONFLICT correctly exposed as business refusal (409)', async () => {
    // Two distinct pending conflicts implicating the same pattern.
    const adapter = makeAdapter();
    const { recordClassificationObservation, detectConflictingPattern, degradeKnowledgeOnConflict } =
      await import('@/memory/classification-knowledge');

    const { conflictId: conflictA, patternId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    // Second contradiction with a different GL (different observation → different identity)
    const obs = await recordClassificationObservation(adapter, COMPANY_A, {
      entityId: 'entity-1',
      originalDescription: `ABC 888 entity-1`,
      glAccountId: 'gl-c',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'tx-obsconflict-second',
    });
    if (!obs.ok) throw new Error('seed obs 2 failed');
    const second = await detectConflictingPattern(adapter, COMPANY_A, 'entity-1', 'any');
    if (second.status !== 'RECORDED') throw new Error(`second detect: ${second.status}`);
    const degraded = await degradeKnowledgeOnConflict(adapter, COMPANY_A, conflictA);
    if (degraded.status !== 'UPDATED') throw new Error(`degrade: ${degraded.status}`);

    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictA}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionReason: 'valid reason' }),
      }),
      { params: Promise.resolve({ id: conflictA }) },
    );

    const res = await sendRehab(conflictA, { knowledgeItemId: patternId });
    expect(res.status).toBe(409);
    const body = await getJson(res);
    expect(body.status).toBe('OTHER_PENDING_CONFLICT');
    expect(body.blockingConflictItemIds).toEqual([second.conflictId]);
  });

  it('T18: NOT_IMPLICATED correctly exposed as business refusal (409)', async () => {
    const { conflictId } = await resolvedConflictWithUncertainPattern('entity-1', 'a');
    // A knowledge item that is NOT implicated by this conflict
    const adapter = makeAdapter();
    const created = await adapter.record({
      content: JSON.stringify({ companyId: COMPANY_A, entityId: 'entity-9', glAccountId: GL_A, direction: 'any', source: 'user_correction' }),
      type: 'classification',
      companyId: COMPANY_A,
      sourceAuthor: 'seed',
      sourceName: 'classification',
    });
    const res = await sendRehab(conflictId, { knowledgeItemId: created.id });
    expect(res.status).toBe(409);
    expect((await getJson(res)).status).toBe('NOT_IMPLICATED');
  });

  it('T19: NOT_UNCERTAIN correctly exposed as business refusal (409)', async () => {
    const { conflictId, patternId } = await seedPendingObservationConflict(COMPANY_A, 'entity-1', 'a');
    // Implicated but neither uncertain nor certain
    mockDb._store.get(patternId)!.confidence = 'tentative';
    await POST_RESOLVE(
      new NextRequest(`http://localhost/api/learning/classification-conflicts/${conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionReason: 'valid reason' }),
      }),
      { params: Promise.resolve({ id: conflictId }) },
    );
    const res = await sendRehab(conflictId, { knowledgeItemId: patternId });
    expect(res.status).toBe(409);
    expect((await getJson(res)).status).toBe('NOT_UNCERTAIN');
  });

  it('T20: NOT_FOUND is tenant-safe (foreign/unknown conflict → 404, no existence leak)', async () => {
    const resUnknown = await sendRehab('mem_does_not_exist', { knowledgeItemId: 'k1' });
    expect(resUnknown.status).toBe(404);
  });

  it('T21 — domain ERROR is never converted into success (500)', async () => {
    // Malformed conflict content under the tenant → domain ERROR path
    mockDb._seedRaw({
      id: 'mem_broken',
      content: 'not-json',
      type: 'classification_conflicting_pattern',
      status: 'active',
      confidence: 'certain',
      companyId: COMPANY_A,
      sourceAuthor: 'seed',
      sourceName: 'seed',
    });
    const res = await sendRehab('mem_broken', { knowledgeItemId: 'k1' });
    expect(res.status).toBe(500);
    const body = await getJson(res);
    expect(body.success).toBeUndefined();
  });

});
