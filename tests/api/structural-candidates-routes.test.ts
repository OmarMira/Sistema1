// KE-GENERALIZATION-UI-001 — API wiring tests (T1–T17)
// Structural candidate surface: discovery, listing, explicit authorization.
// Real domain operations run against the shared in-memory MemoryItem harness.

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

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn(async () => ({})),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports after mocks ─────────────────────────────────────────

import { GET, POST } from '../../src/app/api/learning/structural-candidates/route';
import { POST as POST_AUTHORIZE } from '../../src/app/api/learning/structural-candidates/[id]/authorize/route';
import {
  createAdapter,
  recordClassificationObservation,
} from '@/memory/classification-knowledge';
import type { MemoryPrismaClient } from '@/memory/prisma-types';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const GL_A = 'gl-a';
const ACTOR = 'user-1';

function makeAdapter() {
  return createAdapter(mockDb as unknown as MemoryPrismaClient, (fn) => mockDb.$transaction(fn as never));
}

async function seedObservations(companyId: string, entityId: string, count: number, suffix: string) {
  const adapter = makeAdapter();
  for (let i = 1; i <= count; i++) {
    const obs = await recordClassificationObservation(adapter, companyId, {
      entityId,
      originalDescription: `ABC ${i * 111} ${entityId} ${suffix}`,
      glAccountId: GL_A,
      direction: 'any',
      source: 'user_correction',
      transactionId: `tx-${companyId}-${entityId}-${i}-${suffix}`,
    });
    if (!obs.ok) throw new Error('seed observation failed');
  }
}

function listRequest() {
  return new NextRequest('http://localhost/api/learning/structural-candidates', { method: 'GET' });
}

function discoverRequest() {
  return new NextRequest('http://localhost/api/learning/structural-candidates', { method: 'POST' });
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
});

describe('T1–T10 — discovery + listing', () => {
  it('T1: authenticated authorized user can list own candidates', async () => {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    const discoverRes = await POST(discoverRequest(), { params: Promise.resolve({}) });
    expect(discoverRes.status).toBe(200);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.success).toBe(true);
    expect(discoverBody.candidatesFound).toBeGreaterThanOrEqual(1);

    const listRes = await GET(listRequest(), { params: Promise.resolve({}) });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.success).toBe(true);
    expect(listBody.candidates.length).toBeGreaterThanOrEqual(1);
    expect(listBody.candidates[0]).toMatchObject({
      entityId: 'entity-1',
      glAccountId: GL_A,
    });
  });

  it('T2: unauthenticated list rejected', async () => {
    harness.context = null;
    await expect(GET(listRequest(), { params: Promise.resolve({}) })).rejects.toBeInstanceOf(AppError);
  });

  it('T3: unauthorized role rejected according to current RBAC', async () => {
    harness.roleError = new AppError(403, 'Forbidden', 'FORBIDDEN');
    await expect(GET(listRequest(), { params: Promise.resolve({}) })).rejects.toBeInstanceOf(AppError);
    await expect(POST(discoverRequest(), { params: Promise.resolve({}) })).rejects.toBeInstanceOf(AppError);
  });

  it('T4: Company A cannot see Company B candidates', async () => {
    await seedObservations(COMPANY_B, 'entity-b', 2, 'b');
    await POST(discoverRequest(), { params: Promise.resolve({}) });
    const listRes = await GET(listRequest(), { params: Promise.resolve({}) });
    const listBody = await listRes.json();
    expect(listBody.candidates).toEqual([]);
  });

  it('T5: discovery uses the session company (client companyId is irrelevant)', async () => {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    const res = await POST(
      new NextRequest('http://localhost/api/learning/structural-candidates?companyId=company-b', { method: 'POST' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groupsExamined).toBeGreaterThanOrEqual(1);
    expect(body.candidatesFound).toBeGreaterThanOrEqual(1);
  });

  it('T6: discovery cannot consume Company B observations', async () => {
    await seedObservations(COMPANY_B, 'entity-b', 2, 'b');
    const res = await POST(discoverRequest(), { params: Promise.resolve({}) });
    const body = await res.json();
    expect(body.groupsExamined).toBe(0);
    expect(body.candidatesFound).toBe(0);
  });

  it('T7: discovery invokes the existing discovery authority (candidate produced by domain algorithm)', async () => {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    const res = await POST(discoverRequest(), { params: Promise.resolve({}) });
    const body = await res.json();
    // The domain algorithm decided a candidate exists — the route did not
    // invent one: groupsExamined reflects real observation groups and
    // candidatesFound comes from discoverStructuralCandidateForGroup.
    expect(body.groupsExamined).toBe(1);
    expect(body.candidatesFound).toBe(1);
  });

  it('T8: discovered candidate persisted through the existing record authority', async () => {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    await POST(discoverRequest(), { params: Promise.resolve({}) });
    const adapter = makeAdapter();
    const items = await adapter.getByType(COMPANY_A, 'classification_structural_candidate');
    expect(items.length).toBe(1);
    const parsed = JSON.parse(items[0]!.content) as Record<string, unknown>;
    expect(parsed.entityId).toBe('entity-1');
    expect(parsed.glAccountId).toBe(GL_A);
  });

  it('T9: repeated discovery does not create a duplicate logical candidate', async () => {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    const first = await POST(discoverRequest(), { params: Promise.resolve({}) });
    const firstBody = await first.json();
    expect(firstBody.candidatesRecorded).toBe(1);

    const second = await POST(discoverRequest(), { params: Promise.resolve({}) });
    const secondBody = await second.json();
    expect(secondBody.candidatesRecorded).toBe(0);
    expect(secondBody.duplicatesSkipped).toBe(1);

    const adapter = makeAdapter();
    const items = await adapter.getByType(COMPANY_A, 'classification_structural_candidate');
    expect(items.length).toBe(1);
  });

  it('T10: discovery DOES NOT authorize the candidate', async () => {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    await POST(discoverRequest(), { params: Promise.resolve({}) });
    const adapter = makeAdapter();
    const authorized = await adapter.getByType(COMPANY_A, 'classification_authorized_pattern');
    expect(authorized).toEqual([]);
  });
});

describe('T11–T17 — explicit human authorization', () => {
  async function seedOneCandidate() {
    await seedObservations(COMPANY_A, 'entity-1', 2, 'a');
    await POST(discoverRequest(), { params: Promise.resolve({}) });
    const adapter = makeAdapter();
    const items = await adapter.getByType(COMPANY_A, 'classification_structural_candidate');
    return items[0]!.id;
  }

  it('T11: authorize requires an authenticated authorized user', async () => {
    harness.context = null;
    await expect(
      POST_AUTHORIZE(authorizeRequest('mem_1'), { params: Promise.resolve({ id: 'mem_1' }) }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('T12: unauthorized role cannot authorize', async () => {
    harness.roleError = new AppError(403, 'Forbidden', 'FORBIDDEN');
    await expect(
      POST_AUTHORIZE(authorizeRequest('mem_1'), { params: Promise.resolve({ id: 'mem_1' }) }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('T13: Company A cannot authorize a Company B candidate (tenant-safe 404)', async () => {
    await seedObservations(COMPANY_B, 'entity-b', 2, 'b');
    const bAdapter = makeAdapter();
    // Create the candidate under COMPANY_B directly via the domain authority.
    const { recordStructuralCandidate } = await import('@/memory/classification-knowledge');
    const record = await recordStructuralCandidate(bAdapter, {
      companyId: COMPANY_B,
      entityId: 'entity-b',
      glAccountId: GL_A,
      direction: 'any',
      segments: [{ kind: 'stable', value: 'abc' }],
      observationIds: ['obs-b-1', 'obs-b-2'],
    });
    expect(record.ok).toBe(true);

    const res = await POST_AUTHORIZE(
      authorizeRequest((record as { candidateId: string }).candidateId),
      { params: Promise.resolve({ id: (record as { candidateId: string }).candidateId }) },
    );
    expect(res.status).toBe(404);
  });

  it('T14: nonexistent candidate rejected (404)', async () => {
    const res = await POST_AUTHORIZE(authorizeRequest('mem_missing'), {
      params: Promise.resolve({ id: 'mem_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('T15+T16: authorizedBy derives from the session actor and the existing authorize authority runs', async () => {
    const candidateId = await seedOneCandidate();
    const res = await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('AUTHORIZED');
    expect(body.authorizedPatternId).toBeTruthy();

    // The authorized pattern was written by the DOMAIN authority with the
    // session actor as authorizedBy — never a client-supplied identity.
    const adapter = makeAdapter();
    const authorized = await adapter.getByType(COMPANY_A, 'classification_authorized_pattern');
    expect(authorized.length).toBe(1);
    const parsed = JSON.parse(authorized[0]!.content) as Record<string, unknown>;
    expect(parsed.authorizedBy).toBe(ACTOR);
    expect(parsed.sourceCandidateId).toBe(candidateId);
  });

  it('T16b: second authorization of the same candidate is idempotent (ALREADY_AUTHORIZED)', async () => {
    const candidateId = await seedOneCandidate();
    const first = await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    expect(first.status).toBe(200);
    const second = await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.status).toBe('ALREADY_AUTHORIZED');
  });

  it('T17: API does not write MemoryItem directly (all writes flow through domain authorities)', async () => {
    const candidateId = await seedOneCandidate();
    mockDb.memoryItem.create.mockClear();
    await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    // The ONLY memoryItem.create calls come from inside the domain operation
    // (the authorized pattern record) — exactly one, via the authority.
    expect(mockDb.memoryItem.create).toHaveBeenCalledTimes(1);
    const created = mockDb.memoryItem.create.mock.calls[0]![0] as { data: { sourceName: string } };
    expect(created.data.sourceName).toBe('pattern_authorization');
  });
});
