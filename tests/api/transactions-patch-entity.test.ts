// BLOQUE3-105 — PATCH endpoint confirmedEntity integration tests
//
// Tests the UNKNOWN → AI → confirmation → KE productive wiring
// through the PATCH /api/transactions/[id] endpoint.
//
// T4: PATCH UNKNOWN + confirmedEntity → identity persisted
// T5: PATCH UNKNOWN + confirmedEntity → treatment learned
// T6: PATCH UNKNOWN without confirmedEntity → identity NOT persisted
// T7: PATCH KNOWN → treatment updated, no duplicate identity
// T9: identity conflict → explicit failure

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mock db ─────────────────────────────────────────────────────────────────

const mockBankTransactionFindFirst = vi.fn();
const mockGlAccountFindFirst = vi.fn();
const mockTransactionFn = vi.fn();
const mockJournalLineFindMany = vi.fn().mockResolvedValue([]);
const mockJournalEntryUpdate = vi.fn().mockResolvedValue({});
const mockBankTransactionUpdate = vi.fn().mockResolvedValue({});

vi.mock('@/lib/db', () => ({
  db: {
    bankTransaction: {
      findFirst: (...args: unknown[]) => mockBankTransactionFindFirst(...args),
      update: (...args: unknown[]) => mockBankTransactionUpdate(...args),
    },
    glAccount: {
      findFirst: (...args: unknown[]) => mockGlAccountFindFirst(...args),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', platformRole: 'company_admin' }),
    },
    $transaction: (...args: unknown[]) => mockTransactionFn(...args),
  },
}));

// ─── Mock sessions (apiHandler auth) ──────────────────────────────────────────

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-1'),
}));

// ─── Mock rbac (apiHandler + route) ───────────────────────────────────────────

vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn().mockResolvedValue(undefined),
  requireActiveTenantAccess: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock rate limiter + client IP (apiHandler) ───────────────────────────────

vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockReturnValue({
    allowed: true,
    limit: 100,
    remaining: 99,
    resetAt: new Date(Date.now() + 60000),
  }),
}));

vi.mock('@/lib/security/client-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

// ─── Mock context storage (requestContext + requireCompanyContext) ────────────

vi.mock('@/lib/context-storage', () => {
  const { AsyncLocalStorage } = require('async_hooks') as typeof import('async_hooks');
  const storage = new AsyncLocalStorage<{ userId: string; companyId: string }>();
  return {
    requestContext: storage,
    requireCompanyContext: () => {
      const ctx = storage.getStore();
      if (!ctx?.companyId) {
        throw new Error('Company context required');
      }
      return ctx;
    },
    requireCurrentUserId: () => {
      const ctx = storage.getStore();
      if (!ctx?.userId) throw new Error('Auth required');
      return ctx.userId;
    },
  };
});

// ─── Mock fiscal period ───────────────────────────────────────────────────────

vi.mock('@/lib/fiscal-period-guard', () => ({
  assertActiveFiscalPeriod: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock JournalEntryService ─────────────────────────────────────────────────

const mockRecalculateBalance = vi.fn().mockResolvedValue(undefined);
const mockCreateFromBankTransaction = vi.fn().mockResolvedValue('je-1');

vi.mock('@/lib/services/journal-entry.service', () => ({
  JournalEntryService: {
    createFromBankTransaction: (...args: unknown[]) => mockCreateFromBankTransaction(...args),
    recalculateBalance: (...args: unknown[]) => mockRecalculateBalance(...args),
  },
}));

// ─── Mock entity resolution + KE ──────────────────────────────────────────────

const mockResolveEntity = vi.fn();
const mockConfirmEntityIdentity = vi.fn();
const mockLearnEntityTreatment = vi.fn();
const mockCreateAdapter = vi.fn();
const mockRecordClassificationObservation = vi.fn();
const mockDetectConflictingPattern = vi.fn();
const mockEvolveClassificationConfidence = vi.fn();
const mockDegradeKnowledgeOnConflict = vi.fn();
const mockIsKnowledgeImplicatedByPendingConflict = vi.fn();
const mockIsConflictResolved = vi.fn();

vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: (...args: unknown[]) => mockResolveEntity(...args),
}));

vi.mock('@/internal/company-knowledge/entity/service', () => ({
  confirmEntityIdentity: (...args: unknown[]) => mockConfirmEntityIdentity(...args),
}));

vi.mock('@/memory/classification-knowledge', () => ({
  createAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
  learnEntityTreatment: (...args: unknown[]) => mockLearnEntityTreatment(...args),
  recordClassificationObservation: (...args: unknown[]) =>
    mockRecordClassificationObservation(...args),
  detectConflictingPattern: (...args: unknown[]) =>
    mockDetectConflictingPattern(...args),
  evolveClassificationConfidence: (...args: unknown[]) =>
    mockEvolveClassificationConfidence(...args),
  degradeKnowledgeOnConflict: (...args: unknown[]) =>
    mockDegradeKnowledgeOnConflict(...args),
  // KE-EVOL-005 read-only gating helpers (same read ops family; default:
  // no pending conflict implicates the item, no resolved conflict present)
  isKnowledgeImplicatedByPendingConflict: (...args: unknown[]) =>
    mockIsKnowledgeImplicatedByPendingConflict(...args),
  isConflictResolved: (...args: unknown[]) =>
    mockIsConflictResolved(...args),
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { PATCH } from '../../../src/app/api/transactions/[id]/route';
import { logger } from '@/lib/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/transactions/tx-1?companyId=${COMPANY_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TX_ID = 'tx-1';
const GL_ACCOUNT_ID = 'gl-1';
const COMPANY_ID = 'company-1';

const MOCK_TRANSACTION = {
  id: TX_ID,
  date: new Date('2026-01-15'),
  amount: -100,
  description: 'AMAZON MARKETPLACE',
  glAccountId: null,
  journalEntryId: null,
  statement: {
    bankAccount: {
      id: 'bank-1',
      glAccountId: 'bank-gl-1',
    },
  },
};

const MOCK_GL_ACCOUNT = {
  id: GL_ACCOUNT_ID,
  companyId: COMPANY_ID,
  code: '5000',
  name: 'Cost of Goods Sold',
  isActive: true,
};

function setupMocks(overrides: {
  entityResolution?: { status: string; entityId?: string; reason?: string };
  confirmResult?: { id: string; companyId: string; canonicalName: string; aliases: string[]; status: string };
  learnResult?: { status: string; itemId?: string; reason?: string };
  transaction?: typeof MOCK_TRANSACTION;
} = {}) {
  const tx = overrides.transaction ?? MOCK_TRANSACTION;
  const entityRes = overrides.entityResolution ?? { status: 'UNKNOWN' };

  mockBankTransactionFindFirst.mockResolvedValue(tx);
  mockGlAccountFindFirst.mockResolvedValue(MOCK_GL_ACCOUNT);
  mockResolveEntity.mockResolvedValue(entityRes);
  mockConfirmEntityIdentity.mockResolvedValue(
    overrides.confirmResult ?? {
      id: 'entity-1',
      companyId: COMPANY_ID,
      canonicalName: 'Amazon',
      aliases: ['AMAZON MARKETPLACE'],
      status: 'active',
    },
  );
  mockLearnEntityTreatment.mockResolvedValue(
    overrides.learnResult ?? { status: 'CREATED', itemId: 'mem-1' },
  );
  mockCreateAdapter.mockReturnValue({ getByType: vi.fn() });
  // Default success per real contract: { ok: true, observationId: string }
  mockRecordClassificationObservation.mockResolvedValue({ ok: true, observationId: 'obs-1' });
  // Real contract defaults for the KE-EVOL-001/002 sekundary KE operations
  mockDetectConflictingPattern.mockResolvedValue({ status: 'NO_CONFLICT' });
  mockEvolveClassificationConfidence.mockResolvedValue({
    status: 'UNCHANGED',
    itemId: 'mem-1',
    confidence: 'tentative',
  });
  mockDegradeKnowledgeOnConflict.mockResolvedValue({ status: 'UNCHANGED' });
  mockIsKnowledgeImplicatedByPendingConflict.mockResolvedValue({ implicated: false });
  mockIsConflictResolved.mockResolvedValue({ resolved: false });

  // $transaction executes the callback with a mock tx
  mockTransactionFn.mockImplementation(
    async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const tx = {
        bankTransaction: {
          update: mockBankTransactionUpdate.mockResolvedValue({
            id: TX_ID,
            date: new Date('2026-01-15'),
            amount: -100,
            description: 'AMAZON MARKETPLACE',
            glAccountId: GL_ACCOUNT_ID,
            journalEntryId: 'je-1',
          }),
        },
        journalLine: { findMany: mockJournalLineFindMany },
        journalEntry: { update: mockJournalEntryUpdate },
      };
      return fn(tx);
    },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH /api/transactions/[id] — confirmedEntity KE wiring (BLOQUE3-105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // T4: UNKNOWN + confirmedEntity → identity persisted
  it('T4: UNKNOWN + confirmedEntity → confirmEntityIdentity called', async () => {
    setupMocks({
      entityResolution: { status: 'UNKNOWN' },
      confirmResult: {
        id: 'entity-new',
        companyId: COMPANY_ID,
        canonicalName: 'Amazon',
        aliases: ['AMAZON MARKETPLACE'],
        status: 'active',
      },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // resolveEntity was called with the transaction description
    expect(mockResolveEntity).toHaveBeenCalledWith(COMPANY_ID, 'AMAZON MARKETPLACE');

    // confirmEntityIdentity was called with the correct inputs
    expect(mockConfirmEntityIdentity).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      canonicalName: 'Amazon',
      observedAlias: 'AMAZON MARKETPLACE',
      entityType: 'company',
    });
  });

  // T5: UNKNOWN + confirmedEntity → treatment learned
  it('T5: UNKNOWN + confirmedEntity → learnEntityTreatment called with confirmed entity id', async () => {
    setupMocks({
      entityResolution: { status: 'UNKNOWN' },
      confirmResult: {
        id: 'entity-new',
        companyId: COMPANY_ID,
        canonicalName: 'Amazon',
        aliases: ['AMAZON MARKETPLACE'],
        status: 'active',
      },
      learnResult: { status: 'CREATED', itemId: 'mem-1' },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // learnEntityTreatment was called with the confirmed entity id
    expect(mockLearnEntityTreatment).toHaveBeenCalledWith(
      expect.anything(), // adapter
      COMPANY_ID,
      'entity-new', // the id returned by confirmEntityIdentity
      GL_ACCOUNT_ID,
      'any',
      'user_correction',
      TX_ID,
    );

    // Observation evidence attached to the newly confirmed identity
    expect(mockRecordClassificationObservation).toHaveBeenCalledWith(
      expect.anything(), // adapter
      COMPANY_ID,
      {
        entityId: 'entity-new',
        originalDescription: 'AMAZON MARKETPLACE',
        glAccountId: GL_ACCOUNT_ID,
        direction: 'any',
        source: 'user_correction',
        transactionId: TX_ID,
      },
    );
  });

  // T6: UNKNOWN without confirmedEntity → identity NOT persisted
  it('T6: UNKNOWN without confirmedEntity → confirmEntityIdentity NOT called', async () => {
    setupMocks({
      entityResolution: { status: 'UNKNOWN' },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      // no confirmedEntity
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // confirmEntityIdentity was NOT called
    expect(mockConfirmEntityIdentity).not.toHaveBeenCalled();

    // learnEntityTreatment was NOT called (UNKNOWN without confirmation = skip)
    expect(mockLearnEntityTreatment).not.toHaveBeenCalled();

    // No valid identity → no observation evidence may be attached
    expect(mockRecordClassificationObservation).not.toHaveBeenCalled();
  });

  // T7: KNOWN → treatment updated, no duplicate identity
  it('T7: KNOWN + confirmedEntity → learnEntityTreatment with existing entityId, NO confirmEntityIdentity', async () => {
    setupMocks({
      entityResolution: { status: 'KNOWN', entityId: 'entity-existing' },
      learnResult: { status: 'UPDATED', itemId: 'mem-2' },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // resolveEntity was called
    expect(mockResolveEntity).toHaveBeenCalledWith(COMPANY_ID, 'AMAZON MARKETPLACE');

    // confirmEntityIdentity was NOT called (entity already KNOWN)
    expect(mockConfirmEntityIdentity).not.toHaveBeenCalled();

    // learnEntityTreatment was called with the existing entity id
    expect(mockLearnEntityTreatment).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'entity-existing',
      GL_ACCOUNT_ID,
      'any',
      'user_correction',
      TX_ID,
    );

    // Observation evidence recorded for the known entity (independent of treatment status)
    expect(mockRecordClassificationObservation).toHaveBeenCalledWith(
      expect.anything(), // adapter
      COMPANY_ID,
      {
        entityId: 'entity-existing',
        originalDescription: 'AMAZON MARKETPLACE',
        glAccountId: GL_ACCOUNT_ID,
        direction: 'any',
        source: 'user_correction',
        transactionId: TX_ID,
      },
    );
  });

  // T9: identity conflict → explicit failure (confirmEntityIdentity throws)
  // Accounting correction stands; KE failure is caught and logged; HTTP 200.
  it('T9: confirmEntityIdentity throws on alias conflict → HTTP 200, learnEntityTreatment NOT called', async () => {
    setupMocks({
      entityResolution: { status: 'UNKNOWN' },
    });

    // confirmEntityIdentity throws on alias conflict
    mockConfirmEntityIdentity.mockRejectedValue(
      new Error('Alias conflict: "AMAZON MARKETPLACE" is already assigned to entity "Different Entity"'),
    );

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    // confirmEntityIdentity throws → caught by try-catch → accounting stands → HTTP 200
    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // confirmEntityIdentity was called (and failed)
    expect(mockConfirmEntityIdentity).toHaveBeenCalled();

    // learnEntityTreatment was NOT called (confirmEntityIdentity failed first)
    expect(mockLearnEntityTreatment).not.toHaveBeenCalled();
  });

  // T1: accounting failure → no identity persistence attempt
  it('T1: accounting $transaction throws → HTTP 500, no KE learning attempted', async () => {
    setupMocks();
    mockTransactionFn.mockRejectedValue(new Error('Accounting failure'));

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(500);

    // No KE learning attempted when accounting fails
    expect(mockResolveEntity).not.toHaveBeenCalled();
    expect(mockConfirmEntityIdentity).not.toHaveBeenCalled();
    expect(mockLearnEntityTreatment).not.toHaveBeenCalled();

    // No observation evidence when accounting failed
    expect(mockRecordClassificationObservation).not.toHaveBeenCalled();
  });

  // T2: accounting success + identity success → treatment learning attempted
  it('T2: accounting success + identity success → identity persisted, treatment learning attempted', async () => {
    setupMocks({
      entityResolution: { status: 'UNKNOWN' },
      confirmResult: {
        id: 'entity-new',
        companyId: COMPANY_ID,
        canonicalName: 'Amazon',
        aliases: ['AMAZON MARKETPLACE'],
        status: 'active',
      },
      learnResult: { status: 'CREATED', itemId: 'mem-1' },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // Identity persisted and treatment learned
    expect(mockConfirmEntityIdentity).toHaveBeenCalled();
    expect(mockLearnEntityTreatment).toHaveBeenCalled();
  });

  // T3: accounting success + identity conflict/failure → HTTP 200, treatment NOT called
  it('T3: accounting success + confirmEntityIdentity throws → HTTP 200, treatment NOT called', async () => {
    setupMocks({
      entityResolution: { status: 'UNKNOWN' },
    });
    mockConfirmEntityIdentity.mockRejectedValue(new Error('Alias conflict'));

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    // Accounting succeeded → HTTP 200 despite KE failure
    expect(res.status).toBe(200);

    // confirmEntityIdentity was called and failed
    expect(mockConfirmEntityIdentity).toHaveBeenCalled();

    // learnEntityTreatment was NOT called (identity failed)
    expect(mockLearnEntityTreatment).not.toHaveBeenCalled();
  });

  // T4b: accounting success + resolveEntity ERROR → HTTP 200, no identity, no treatment
  it('T4b: accounting success + resolveEntity ERROR → HTTP 200, identity NOT persisted, treatment NOT learned', async () => {
    setupMocks({
      entityResolution: { status: 'ERROR', reason: 'Ambiguous entity' },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
      confirmedEntity: { canonicalName: 'Amazon', entityType: 'company' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // resolveEntity was called
    expect(mockResolveEntity).toHaveBeenCalled();

    // confirmEntityIdentity was NOT called (ERROR, not UNKNOWN)
    expect(mockConfirmEntityIdentity).not.toHaveBeenCalled();

    // learnEntityTreatment was NOT called
    expect(mockLearnEntityTreatment).not.toHaveBeenCalled();

    // ERROR must not become evidence — observation NOT attached
    expect(mockRecordClassificationObservation).not.toHaveBeenCalled();
  });

  // T5b: accounting success + treatment learning failure → HTTP 200, explicit log
  it('T5b: accounting success + learnEntityTreatment ERROR → HTTP 200, explicit log', async () => {
    setupMocks({
      entityResolution: { status: 'KNOWN', entityId: 'entity-existing' },
      learnResult: { status: 'ERROR', reason: 'DB connection lost' },
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // learnEntityTreatment was called (and failed)
    expect(mockLearnEntityTreatment).toHaveBeenCalled();
  });

  // T10: accounting success + evidence write failure → HTTP 200, explicit log,
  // accounting correction stands. Uses the REAL failure contract of
  // recordClassificationObservation: { ok: false, error: string }.
  it('T10: accounting success + recordClassificationObservation failure → HTTP 200, explicit warn, accounting result stands', async () => {
    setupMocks({
      entityResolution: { status: 'KNOWN', entityId: 'entity-existing' },
    });
    mockRecordClassificationObservation.mockResolvedValue({
      ok: false,
      error: 'Evidence write failed',
    });

    const req = makeRequest({
      glAccountId: GL_ACCOUNT_ID,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TX_ID }) });
    expect(res.status).toBe(200);

    // Accounting correction result stands in the response
    const body = (await res.json()) as { transaction: { id: string } };
    expect(body.transaction.id).toBe(TX_ID);

    // Evidence write attempted exactly once with the real observation payload
    expect(mockRecordClassificationObservation).toHaveBeenCalledTimes(1);
    expect(mockRecordClassificationObservation).toHaveBeenCalledWith(
      expect.anything(), // adapter
      COMPANY_ID,
      {
        entityId: 'entity-existing',
        originalDescription: 'AMAZON MARKETPLACE',
        glAccountId: GL_ACCOUNT_ID,
        direction: 'any',
        source: 'user_correction',
        transactionId: TX_ID,
      },
    );

    // Failure explicitly logged — KE secondary failure only
    expect(logger.warn).toHaveBeenCalledWith(
      '[KE] Observation record failed — treatment stands',
      expect.objectContaining({
        transactionId: TX_ID,
        companyId: COMPANY_ID,
        entityId: 'entity-existing',
        stage: 'observation_recording',
        error: 'Evidence write failed',
      }),
    );
  });
});
