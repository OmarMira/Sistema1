import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PATCH as feedbackPatch } from '@/app/api/learning/feedback/route';
import { POST as assistantPost } from '@/app/api/ai-assistant/route';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';

describe('Multi-Tenant Protection - RBAC Isolation', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe permitir acceso a feedback si el usuario pertenece a la compañía', async () => {
    const user = await createTestUser('authorized@example.com');
    const company = await createTestCompany('Authorized Corp');
    await createTestCompanyMember(user.id, company.id);

    const token = await createSession(user.id);

    const req = new NextRequest('http://localhost/api/learning/feedback', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        companyId: company.id,
        bankDescription: 'Zelle payment',
        glAccountCode: '4010',
        confidence: 0.95,
      }),
    });

    const response = await feedbackPatch(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it('debe bloquear acceso (403) a feedback si el usuario NO pertenece a la compañía', async () => {
    const user = await createTestUser('unauthorized@example.com');
    const company = await createTestCompany('Other Corp');

    const token = await createSession(user.id);

    const req = new NextRequest('http://localhost/api/learning/feedback', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        companyId: company.id,
        bankDescription: 'Zelle payment',
        glAccountCode: '4010',
        confidence: 0.95,
      }),
    });

    const response = await feedbackPatch(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Forbidden');
  });

  it('debe bloquear acceso (403) a ai-assistant si el usuario NO pertenece a la compañía', async () => {
    const user = await createTestUser('unauthorized_assistant@example.com');
    const company = await createTestCompany('Other Corp');

    const token = await createSession(user.id);

    const req = new NextRequest('http://localhost/api/ai-assistant', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: 'Hola asistente',
        companyId: company.id,
      }),
    });

    const response = await assistantPost(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Forbidden');
  });
});
