import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apiHandler } from '@/lib/api-handler';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from './helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyContext, getRequestContext } from '@/lib/context-storage';

describe('Multi-Tenant Context and apiHandler Protection', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe rechazar (400) si requireMembership es true y companyId no es provisto', async () => {
    const user = await createTestUser('test-tenant-400@example.com');
    const token = await createSession(user.id);

    const handler = apiHandler(async (request) => {
      return NextResponse.json({ success: true });
    });

    const req = new NextRequest('http://localhost/api/test-route', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await handler(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('companyId is required');
  });

  it('debe rechazar (403) si requireMembership es true y el usuario no pertenece a la compañia', async () => {
    const user = await createTestUser('test-tenant-403@example.com');
    const company = await createTestCompany('Test Company');
    const token = await createSession(user.id);

    const handler = apiHandler(async (request) => {
      return NextResponse.json({ success: true });
    });

    const req = new NextRequest(`http://localhost/api/test-route?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await handler(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Forbidden');
  });

  it('debe permitir (200) y configurar el contexto si el usuario pertenece a la compañia', async () => {
    const user = await createTestUser('test-tenant-200@example.com');
    const company = await createTestCompany('Test Company');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    let capturedContext: any = null;

    const handler = apiHandler(async (request) => {
      capturedContext = requireCompanyContext();
      return NextResponse.json({ success: true });
    });

    const req = new NextRequest(`http://localhost/api/test-route?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await handler(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(capturedContext).not.toBeNull();
    expect(capturedContext.companyId).toBe(company.id);
    expect(capturedContext.userId).toBe(user.id);
  });

  it('debe extraer companyId desde cabeceras HTTP', async () => {
    const user = await createTestUser('test-headers@example.com');
    const company = await createTestCompany('Test Company Headers');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    let capturedContext: any = null;

    const handler = apiHandler(async (request) => {
      capturedContext = requireCompanyContext();
      return NextResponse.json({ success: true });
    });

    const req = new NextRequest('http://localhost/api/test-route', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-company-id': company.id,
      },
    });

    const response = await handler(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(capturedContext?.companyId).toBe(company.id);
  });

  it('debe extraer companyId desde cuerpo JSON en peticiones POST', async () => {
    const user = await createTestUser('test-json@example.com');
    const company = await createTestCompany('Test Company JSON');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    let capturedContext: any = null;

    const handler = apiHandler(async (request) => {
      capturedContext = requireCompanyContext();
      return NextResponse.json({ success: true });
    });

    const req = new NextRequest('http://localhost/api/test-route', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ companyId: company.id }),
    });

    const response = await handler(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(capturedContext?.companyId).toBe(company.id);
  });

  it('debe extraer companyId desde Multipart Form Data en peticiones POST', async () => {
    const user = await createTestUser('test-multipart@example.com');
    const company = await createTestCompany('Test Company Multipart');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    let capturedContext: any = null;

    const handler = apiHandler(async (request) => {
      capturedContext = requireCompanyContext();
      return NextResponse.json({ success: true });
    });

    const formData = new FormData();
    formData.append('companyId', company.id);

    const req = new NextRequest('http://localhost/api/test-route', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });

    const response = await handler(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(capturedContext?.companyId).toBe(company.id);
  });
});
