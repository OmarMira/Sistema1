// KE-GENERALIZATION-UI-001 — Productive integration tests (T34–T46)
// REAL pipeline end-to-end against the shared in-memory MemoryItem harness:
//
//   real observations → discovery API → candidate (domain authority)
//   → explicit human authorization API → authorized structural pattern
//   → new compatible occurrence through the EXISTING structural matcher
//   → existing conflict detector becomes reachable (RECORDED, not NO_CONFLICT)
//
// No BankRule, no AI, no direct MemoryItem writes from API/UI.

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

import { GET, POST as POST_DISCOVER } from '../../src/app/api/learning/structural-candidates/route';
import { POST as POST_AUTHORIZE } from '../../src/app/api/learning/structural-candidates/[id]/authorize/route';
import {
  createAdapter,
  recordClassificationObservation,
  detectConflictingPattern,
  getPendingConflicts,
  matchAuthorizedPattern,
} from '@/memory/classification-knowledge';
import type { MemoryPrismaClient } from '@/memory/prisma-types';

const COMPANY_A = 'company-a';
const GL_A = 'gl-a';
const GL_B = 'gl-b';
const ACTOR = 'user-1';

function makeAdapter() {
  return createAdapter(mockDb as unknown as MemoryPrismaClient, (fn) => mockDb.$transaction(fn as never));
}

async function seedObservation(companyId: string, entityId: string, description: string, glAccountId: string, txId: string) {
  const adapter = makeAdapter();
  const obs = await recordClassificationObservation(adapter, companyId, {
    entityId,
    originalDescription: description,
    glAccountId,
    direction: 'any',
    source: 'user_correction',
    transactionId: txId,
  });
  if (!obs.ok) throw new Error('seed observation failed');
}

function discoverRequest() {
  return new NextRequest('http://localhost/api/learning/structural-candidates', { method: 'POST' });
}

function listRequest() {
  return new NextRequest('http://localhost/api/learning/structural-candidates', { method: 'GET' });
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

describe('T34–T46 — real observation → discovery → authorization → matcher → conflict detector', () => {
  it('full productive cycle with the REAL domain authorities', async () => {
    // T34: real classification observations exist for Company A (two
    // structurally compatible descriptions, same treatment).
    await seedObservation(COMPANY_A, 'entity-1', 'ABC 111 entity-1 a', GL_A, 'tx-1');
    await seedObservation(COMPANY_A, 'entity-1', 'ABC 222 entity-1 a', GL_A, 'tx-2');

    // Before any pattern exists, the conflict detector returns NO_CONFLICT
    // (structural pre-condition of the published guard).
    const detectBefore = await detectConflictingPattern(makeAdapter(), COMPANY_A, 'entity-1', 'any');
    expect(detectBefore.status).toBe('NO_CONFLICT');

    // T35: discovery consumes those observations through the API.
    const discoverRes = await POST_DISCOVER(discoverRequest(), { params: Promise.resolve({}) });
    expect(discoverRes.status).toBe(200);
    const discoverBody = await discoverRes.json();
    expect(discoverBody.groupsExamined).toBe(1);
    expect(discoverBody.candidatesFound).toBe(1);
    expect(discoverBody.candidatesRecorded).toBe(1);

    // T36: the candidate was created through the existing domain authority.
    const adapter = makeAdapter();
    const candidateItems = await adapter.getByType(COMPANY_A, 'classification_structural_candidate');
    expect(candidateItems.length).toBe(1);
    const candidateId = candidateItems[0]!.id;
    const candidateContent = JSON.parse(candidateItems[0]!.content) as Record<string, unknown>;
    expect(candidateContent.entityId).toBe('entity-1');
    expect(candidateContent.glAccountId).toBe(GL_A);

    // T37: the candidate remains unauthorized before any human action.
    const authorizedBefore = await adapter.getByType(COMPANY_A, 'classification_authorized_pattern');
    expect(authorizedBefore).toEqual([]);

    // T38: explicit human authorization creates the authorized structural
    // pattern through the existing domain authority.
    const authRes = await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });
    expect(authRes.status).toBe(200);
    const authBody = await authRes.json();
    expect(authBody.status).toBe('AUTHORIZED');
    const authorizedPatternId = authBody.authorizedPatternId as string;

    // T39: authorizedBy corresponds to the human actor from the session.
    const authorizedItems = await adapter.getByType(COMPANY_A, 'classification_authorized_pattern');
    expect(authorizedItems.length).toBe(1);
    expect(authorizedItems[0]!.id).toBe(authorizedPatternId);
    const authorizedContent = JSON.parse(authorizedItems[0]!.content) as Record<string, unknown>;
    expect(authorizedContent.authorizedBy).toBe(ACTOR);
    expect(authorizedContent.sourceCandidateId).toBe(candidateId);

    // T40+T41: a later compatible occurrence goes through the EXISTING
    // structural matcher and resolves to the authorized pattern's treatment.
    const match = await matchAuthorizedPattern(
      makeAdapter(),
      COMPANY_A,
      'entity-1',
      'ABC 777 entity-1 a',
      'any',
    );
    expect(match.kind).toBe('match');
    if (match.kind === 'match') {
      expect(match.glAccountId).toBe(GL_A);
      expect(match.authorizedPatternId).toBe(authorizedPatternId);
    }

    // T42: no BankRule is created by authorization — the only writes in the
    // whole flow are MemoryItem records (observations, candidate, pattern).
    const allItems = Array.from(mockDb._store.values());
    const types = new Set(allItems.map((i) => i.type));
    expect(types.has('classification_observation')).toBe(true);
    expect(types.has('classification_structural_candidate')).toBe(true);
    expect(types.has('classification_authorized_pattern')).toBe(true);
    // The harness has no bankRule model at all — any BankRule write attempt
    // would have thrown. The flow completing proves none occurred.

    // T43: no AI invocation is required — discovery/authorization routes
    // complete without any AI provider, config or prompt being involved.

    // T44+T45: incompatible later evidence reaches the EXISTING conflict
    // detector — it no longer returns NO_CONFLICT merely because patterns
    // were absent; now a pattern exists and the divergent observation fires.
    await seedObservation(COMPANY_A, 'entity-1', 'ABC 999 entity-1 a', GL_B, 'tx-3');
    const detectAfter = await detectConflictingPattern(makeAdapter(), COMPANY_A, 'entity-1', 'any');
    expect(detectAfter.status).toBe('RECORDED');

    // T46: the resulting conflict is persisted and observable through the
    // EXISTING pending-conflicts contract (the surface published in
    // KE-CONFLICT-UI-001 can now actually show something).
    const pending = await getPendingConflicts(makeAdapter(), COMPANY_A);
    expect(pending.status).toBe('FOUND');
    if (pending.status === 'FOUND') {
      expect(pending.conflicts.length).toBe(1);
      expect(pending.conflicts[0]!.content.kind).toBe('OBSERVATION_VS_AUTHORIZED');
      expect(pending.conflicts[0]!.content.authorizedPatternIds).toContain(authorizedPatternId);
    }
  });

  it('T37b: listing excludes authorized candidates after authorization', async () => {
    await seedObservation(COMPANY_A, 'entity-1', 'ABC 111 entity-1 a', GL_A, 'tx-1');
    await seedObservation(COMPANY_A, 'entity-1', 'ABC 222 entity-1 a', GL_A, 'tx-2');
    await POST_DISCOVER(discoverRequest(), { params: Promise.resolve({}) });

    const before = await GET(listRequest(), { params: Promise.resolve({}) });
    const beforeBody = await before.json();
    expect(beforeBody.candidates.length).toBe(1);
    const candidateId = beforeBody.candidates[0].candidateItemId as string;

    await POST_AUTHORIZE(authorizeRequest(candidateId), {
      params: Promise.resolve({ id: candidateId }),
    });

    const after = await GET(listRequest(), { params: Promise.resolve({}) });
    const afterBody = await after.json();
    expect(afterBody.candidates).toEqual([]);
  });
});
