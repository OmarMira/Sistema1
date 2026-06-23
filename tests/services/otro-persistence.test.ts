import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { clearDatabase, createTestCompany, createTestUser, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

// ─── Route-level test helpers ───────────────────────────────────
function makeGetRequest(
  url: string,
  token: string,
  companyId: string,
): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-company-id': companyId,
    },
  });
}

describe('OTRO Persistence', () => {
  let token: string;
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    await clearDatabase();
    const user = await createTestUser('otro-test@example.com');
    userId = user.id;
    const company = await createTestCompany('OTRO Test Co');
    companyId = company.id;
    await createTestCompanyMember(user.id, companyId);
    token = await createSession(user.id);
  });

  afterAll(async () => {
    await clearDatabase();
  });

  // ─── Service-layer tests (direct DB verification) ────────────

  it('saves OTRO entity with userDescription via classifyEntity', async () => {
    const { classifyEntity } = await import('@/lib/services/entity-classifier');
    const { saveContext } = await import('@/lib/services/entity-context-service');

    await classifyEntity({
      companyId,
      pattern: 'PAPELERA XYZ',
      role: 'OTRO',
      source: 'user',
      userId,
      userDescription: 'pagos varios de oficina',
    });

    // Verify the record was saved correctly
    const saved = await db.entityContext.findFirst({
      where: { companyId, pattern: 'papelera xyz' },
    });
    expect(saved).not.toBeNull();
    expect(saved!.role).toBe('OTRO');
    expect(saved!.userDescription).toBe('pagos varios de oficina');
    expect(saved!.source).toBe('user');
  });

  it('retrieves OTRO entities via includeOtro GET param', async () => {
    const { GET } = await import('@/app/api/learning/classify-entity/route');

    const req = makeGetRequest(
      `http://localhost/api/learning/classify-entity?companyId=${companyId}&includeOtro=true`,
      token,
      companyId,
    );

    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    const papeleras = body.data.filter(
      (e: { pattern: string }) => e.pattern === 'papelera xyz',
    );
    expect(papeleras.length).toBeGreaterThanOrEqual(1);

    const papelera = papeleras[0];
    expect(papelera.role).toBe('OTRO');
    expect(papelera.userDescription).toBe('pagos varios de oficina');
  });

  it('excludes OTRO entities from pending candidates', async () => {
    const { getEntityCandidates } = await import('@/lib/services/entity-classifier');
    const { classifyEntity } = await import('@/lib/services/entity-classifier');

    // Use a unique entity name not used in other tests
    const txnDesc = 'Zelle payment from NUEVA EMPRESA SRL for services rendered';

    // Create a bank account + 2 transactions (minOccurrences=2 threshold)
    const gl = await createTestGlAccount({ companyId, code: '1101', name: 'Cash 2' });
    const ba = await createTestBankAccount(companyId, gl.id, 'OTRO Test Bank 2');
    const stmt = await createTestBankStatement(companyId, ba.id);
    await createTestBankTransaction(companyId, stmt.id, {
      date: '2025-02-01',
      amount: 500,
      description: txnDesc,
    });
    await createTestBankTransaction(companyId, stmt.id, {
      date: '2025-02-10',
      amount: 300,
      description: txnDesc,
    });

    // First try: candidate should appear (not yet classified)
    const before = await getEntityCandidates(companyId);
    const hasNuevaBefore = before.some(
      (c: { canonicalName: string }) =>
        c.canonicalName.toLowerCase().includes('nueva empresa'),
    );
    expect(hasNuevaBefore).toBe(true);

    // Now classify it as OTRO
    await classifyEntity({
      companyId,
      pattern: 'NUEVA EMPRESA SRL',
      role: 'OTRO',
      source: 'user',
      userId,
      userDescription: 'services vendor',
    });

    // Second try: candidate should NOT appear (already classified as OTRO)
    const after = await getEntityCandidates(companyId);
    const hasNuevaAfter = after.some(
      (c: { canonicalName: string }) =>
        c.canonicalName.toLowerCase().includes('nueva empresa'),
    );
    expect(hasNuevaAfter).toBe(false);
  });

  it('blocks saving OTRO without userDescription', async () => {
    const { classifyEntity } = await import('@/lib/services/entity-classifier');

    await expect(
      classifyEntity({
        companyId,
        pattern: 'SIN DESCRIPCION',
        role: 'OTRO',
        source: 'user',
        userId,
        // No userDescription
      }),
    ).rejects.toThrow();
  });

  it('allows saving a second OTRO entity with userDescription', async () => {
    const { classifyEntity } = await import('@/lib/services/entity-classifier');

    await classifyEntity({
      companyId,
      pattern: 'SERVICIOS MENSUALES',
      role: 'OTRO',
      source: 'user',
      userId,
      userDescription: 'servicios mensuales de oficina',
    });

    const saved = await db.entityContext.findFirst({
      where: { companyId, pattern: 'servicios mensuales' },
    });
    expect(saved).not.toBeNull();
    expect(saved!.role).toBe('OTRO');
    expect(saved!.userDescription).toBe('servicios mensuales de oficina');
  });
});
