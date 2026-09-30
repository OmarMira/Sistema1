import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
