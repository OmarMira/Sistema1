import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST } from '@/app/api/ai-assistant/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

const { LLM_REPLY } = vi.hoisted(() => ({
  LLM_REPLY: { choices: [{ message: { role: 'assistant', content: 'Respuesta de prueba' } }] },
}));

vi.mock('@/lib/ai-config', () => ({
  getAiConfig: vi.fn().mockResolvedValue({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://api.test.openrouter.ai/v1',
  }),
  clearAiConfigCache: vi.fn(),
}));

vi.mock('@/lib/security/safe-fetch', () => ({
  safeFetch: vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(LLM_REPLY), { status: 200 })),
  ),
}));

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

describe('D2-H13 L2 — ai-assistant enforces active-tenant authority (no first-membership fallback)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it('missing companyId → 400 fail-closed from the gate (no fallback)', async () => {
    const user = await createTestUser('l2-nocid@example.com');
    const company = await createTestCompany('No Cid Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const res = await POST(
      new NextRequest('http://localhost/api/ai-assistant', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ message: 'Hola', mode: 'chat' }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('companyId is required');
  });

  it('multiple memberships without companyId → 400, never silent selection', async () => {
    const user = await createTestUser('l2-multi@example.com');
    const companyA = await createTestCompany('Multi A');
    const companyB = await createTestCompany('Multi B');
    await createTestCompanyMember(user.id, companyA.id);
    await createTestCompanyMember(user.id, companyB.id);
    const token = await createSession(user.id);

    const res = await POST(
      new NextRequest('http://localhost/api/ai-assistant', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ message: 'Hola', mode: 'chat' }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('companyId is required');
  });

  it('foreign companyId → 403', async () => {
    const user = await createTestUser('l2-foreign@example.com');
    const userCompany = await createTestCompany('User Corp');
    await createTestCompanyMember(user.id, userCompany.id);
    const foreignCompany = await createTestCompany('Foreign Corp');
    const token = await createSession(user.id);

    const res = await POST(
      new NextRequest('http://localhost/api/ai-assistant', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ message: 'Hola', mode: 'chat', companyId: foreignCompany.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('inactive company with normal tenant user → 403', async () => {
    const user = await createTestUser('l2-inactive@example.com');
    const company = await createTestCompany('Inactive Corp');
    await createTestCompanyMember(user.id, company.id);
    await db.company.update({ where: { id: company.id }, data: { isActive: false } });
    const token = await createSession(user.id);

    const res = await POST(
      new NextRequest('http://localhost/api/ai-assistant', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ message: 'Hola', mode: 'chat', companyId: company.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Company is deactivated');
  });

  it('owning active tenant member → allowed (200)', async () => {
    const user = await createTestUser('l2-owner@example.com');
    const company = await createTestCompany('Owner Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const res = await POST(
      new NextRequest('http://localhost/api/ai-assistant', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ message: 'Hola', mode: 'chat', companyId: company.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe('Respuesta de prueba');
  });

  it('super_admin without membership row keeps canonical F-6 bypass (200)', async () => {
    const admin = await createTestUser('l2-superadmin@example.com');
    await db.user.update({ where: { id: admin.id }, data: { platformRole: 'super_admin' } });
    const company = await createTestCompany('Super Corp');
    const token = await createSession(admin.id);

    const res = await POST(
      new NextRequest('http://localhost/api/ai-assistant', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ message: 'Hola', mode: 'chat', companyId: company.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe('Respuesta de prueba');
  });
});