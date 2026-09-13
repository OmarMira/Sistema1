// ENTITY-CLASSIFY-AUDIT-001 — T1–T6
// An audit failure must NOT convert a successfully persisted domain
// classification (EntityContext + optional active BankRule) into an HTTP
// failure. Pattern published in AUDIT-SIDE-EFFECT-001.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const harness = vi.hoisted(() => ({
  context: { userId: 'user-1', companyId: 'company-a' } as { userId: string; companyId: string } | null,
  roleError: null as Error | null,
}));

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

vi.mock('@/lib/services/entity-classifier', () => ({
  classifyEntity: vi.fn(),
  getEntityCandidates: vi.fn(),
}));

vi.mock('@/lib/services/conversational-service', () => ({
  parseConversationalContext: vi.fn(),
}));

vi.mock('@/lib/server-i18n', () => ({
  serverT: vi.fn((locale: string, key: string) => `${locale}:${key}`),
}));

vi.mock('@/lib/db', () => ({ db: {} }));

// ─── Imports after mocks ─────────────────────────────────────────

import { logger } from '@/lib/logger';
import { safeAuditLog } from '@/lib/services/audit-service';
import { POST } from '../../src/app/api/learning/classify-entity/route';
import { classifyEntity } from '@/lib/services/entity-classifier';

const mockClassify = classifyEntity as ReturnType<typeof vi.fn>;
const COMPANY_A = 'company-a';
const ACTOR = 'user-1';

const CLASSIFY_RESULT = {
  context: {
    id: 'ctx-1',
    companyId: COMPANY_A,
    pattern: 'ACME CORP',
    role: 'PROVEEDOR',
  },
  warning: undefined as string | undefined,
};

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/learning/classify-entity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.context = { userId: ACTOR, companyId: COMPANY_A };
  harness.roleError = null;
  auditMock.fn = null;
  mockClassify.mockReset();
});

describe('ENTITY-CLASSIFY-AUDIT-001 — audit failure must not mask domain success (T1–T6)', () => {
  it('T1: normal POST with successful audit keeps the exact current behavior', async () => {
    mockClassify.mockResolvedValue({ ...CLASSIFY_RESULT });
    const res = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR', glAccountCode: '1.1.1' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('PROVEEDOR');
    expect(safeAuditLog).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('T2: domain success + audit failure → NO 500, same success body, classification persisted', async () => {
    mockClassify.mockResolvedValue({ ...CLASSIFY_RESULT });
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };

    const res = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR', glAccountCode: '1.1.1' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('PROVEEDOR');
    expect(body.data.entityContext.id).toBe('ctx-1');
    // Audit was attempted and its failure is observable.
    expect(safeAuditLog).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('T3: createRule=true with audit failure — rule creation outcome preserved in the response, no revert', async () => {
    // Domain returned a warning ("No rule created") — the response shape must
    // keep reflecting exactly what the domain did, regardless of audit.
    mockClassify.mockResolvedValue({
      ...CLASSIFY_RESULT,
      warning: 'No rule created: intent or GL account not specified',
    });
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };

    const res = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR', glAccountCode: '1.1.1', createRule: true, intent: 'OPERATING_EXPENSE' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.ruleCreated).toBe(false);
    expect(body.requiresReview).toBe(true);

    // Audit details still carried the domain truth.
    const auditPayload = (safeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      details: { ruleCreated: boolean; requiresReview: boolean };
    };
    expect(auditPayload.details.ruleCreated).toBe(false);
    expect(auditPayload.details.requiresReview).toBe(true);
  });

  it('T3b: createRule=true success path (ruleCreated: true) survives audit failure', async () => {
    mockClassify.mockResolvedValue({ ...CLASSIFY_RESULT });
    auditMock.fn = () => {
      throw new Error('AUDIT_DB_DOWN');
    };

    const res = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR', glAccountCode: '1.1.1', createRule: true, intent: 'OPERATING_EXPENSE' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.ruleCreated).toBe(true);
  });

  it('T4: identical retry after the T3 scenario stays idempotent (domain-level, no duplication)', async () => {
    // Domain authority dedup: second identical classifyEntity call resolves
    // via upsert semantics — the route does not add any second write.
    mockClassify.mockResolvedValue({ ...CLASSIFY_RESULT });
    const first = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR', glAccountCode: '1.1.1', createRule: true, intent: 'OPERATING_EXPENSE' }),
      { params: Promise.resolve({}) },
    );
    expect(first.status).toBe(200);
    const second = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR', glAccountCode: '1.1.1', createRule: true, intent: 'OPERATING_EXPENSE' }),
      { params: Promise.resolve({}) },
    );
    expect(second.status).toBe(200);
    // The route called the domain authority exactly once per request — no
    // hidden duplication on retry.
    expect(mockClassify).toHaveBeenCalledTimes(2);
  });

  it('T5: domain failure still propagates as failure — audit handling cannot mask it', async () => {
    mockClassify.mockRejectedValue(new Error('DOMAIN_VALIDATION_FAILED'));
    const res = await POST(
      postRequest({ pattern: 'ACME CORP', role: 'PROVEEDOR' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    // Audit must never have been attempted after a domain failure.
    expect(safeAuditLog).not.toHaveBeenCalled();
  });

  it('T6: tenant/RBAC unchanged — role rejection still happens before any work', async () => {
    harness.roleError = new (await import('@/lib/api-error')).AppError(403, 'Forbidden', 'FORBIDDEN');
    await expect(
      POST(postRequest({ pattern: 'ACME CORP' }), { params: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockClassify).not.toHaveBeenCalled();
    expect(safeAuditLog).not.toHaveBeenCalled();
  });
});
