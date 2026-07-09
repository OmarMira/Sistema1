import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { createTestGlAccount } from '../helpers/factories';

// ─── Route handlers under test ──────────────────────────────────
import { POST as postContext } from '@/app/api/learning/context/route';
import { POST as postClassify } from '@/app/api/learning/classify-entity/route';
import { PATCH as patchEntityContext } from '@/app/api/entity-context/[id]/route';
import { POST as postEntities } from '@/app/api/learning/entities/route';

// ─── Helper: build auth headers + company context ────────────────
async function makeAuthRequest(
  method: string,
  url: string,
  body: unknown,
  token: string,
  companyId: string,
): Promise<NextRequest> {
  return new NextRequest(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-company-id': companyId,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('Role validation — any role string is now accepted', () => {
  let userId: string;
  let companyId: string;
  let token: string;
  let glAccountId: string;
  let entityId: string;

  beforeEach(async () => {
    await clearDatabase();
    const user = await createTestUser('role-val-test@example.com');
    userId = user.id;
    const company = await createTestCompany('Role Validation Co');
    companyId = company.id;
    await createTestCompanyMember(userId, companyId);
    token = await createSession(user.id);

    // Create a GL account for routes that need it
    const gl = await createTestGlAccount({
      companyId,
      code: '4010',
      name: 'Cuentas por Cobrar',
      accountType: 'revenue',
    });
    glAccountId = gl.id;

    // Create a valid entity context for PATCH route
    const postReq = await makeAuthRequest(
      'POST',
      'http://localhost/api/learning/entities',
      { pattern: 'TEST ENTITY', role: 'CLIENTE' },
      token,
      companyId,
    );
    const postRes = await postEntities(postReq, { params: Promise.resolve({}) });
    const postBody = await postRes.json();
    entityId = postBody.data?.id;
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // ── Route 1: POST /api/learning/context ──────────────────────
  it('POST /api/learning/context accepts custom role', async () => {
    const req = await makeAuthRequest(
      'POST',
      'http://localhost/api/learning/context',
      { companyId, pattern: 'SOME PATTERN', role: 'FIDEICOMISO', glAccountId },
      token,
      companyId,
    );
    const res = await postContext(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('FIDEICOMISO');
  });

  // ── Route 2: POST /api/learning/classify-entity ──────────────
  it('POST /api/learning/classify-entity accepts custom role', async () => {
    const req = await makeAuthRequest(
      'POST',
      'http://localhost/api/learning/classify-entity',
      { pattern: 'SOME PATTERN', role: 'PLATAFORMA' },
      token,
      companyId,
    );
    const res = await postClassify(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('PLATAFORMA');
  });

  // ── Route 3: PATCH /api/entity-context/[id] ─────────────────
  it('PATCH /api/entity-context/[id] accepts custom role', async () => {
    const req = await makeAuthRequest(
      'PATCH',
      `http://localhost/api/entity-context/${entityId}`,
      { role: 'INVERSOR' },
      token,
      companyId,
    );
    const res = await patchEntityContext(req, { params: Promise.resolve({ id: entityId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('INVERSOR');
  });

  // ── Route 4: POST /api/learning/entities ────────────────────
  it('POST /api/learning/entities accepts custom role', async () => {
    const req = await makeAuthRequest(
      'POST',
      'http://localhost/api/learning/entities',
      { pattern: 'NEW ENTITY', role: 'CUSTOM_ROLE' },
      token,
      companyId,
    );
    const res = await postEntities(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('CUSTOM_ROLE');
  });
});
