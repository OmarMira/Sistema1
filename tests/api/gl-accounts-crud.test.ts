import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET as listGET, POST as createPOST } from '../../src/app/api/accounts/route';
import { GET as getGET, PUT as updatePUT, DELETE as deleteDELETE } from '../../src/app/api/accounts/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('GL Accounts CRUD /api/accounts', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe crear, leer, actualizar y eliminar una cuenta contable', async () => {
    const user = await createTestUser('gl-crud@example.com');
    const company = await createTestCompany('GL CRUD Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    // CREATE
    const createReq = new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: '9999',
        name: 'Test Account CRUD',
        accountType: 'asset',
        normalBalance: 'debit',
      }),
    });
    const createRes = await createPOST(createReq, { params: Promise.resolve({}) });
    expect(createRes.status).toBe(201);

    const createBody = await createRes.json();
    expect(createBody.account.code).toBe('9999');
    expect(createBody.account.name).toBe('Test Account CRUD');
    expect(createBody.account.isActive).toBe(true);
    const accountId = createBody.account.id;

    // READ (list)
    const listReq = new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const listRes = await listGET(listReq, { params: Promise.resolve({}) });
    expect(listRes.status).toBe(200);

    const listBody = await listRes.json();
    const found = listBody.accounts.find((a: { id: string }) => a.id === accountId);
    expect(found).toBeDefined();
    expect(found.code).toBe('9999');

    // READ (by ID)
    const getReq = new NextRequest(`http://localhost/api/accounts/${accountId}?companyId=${company.id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const getRes = await getGET(getReq, { params: Promise.resolve({ id: accountId }) });
    expect(getRes.status).toBe(200);

    const getBody = await getRes.json();
    expect(getBody.account.id).toBe(accountId);
    expect(getBody.account.name).toBe('Test Account CRUD');

    // UPDATE
    const updateReq = new NextRequest(`http://localhost/api/accounts/${accountId}?companyId=${company.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Updated CRUD Account' }),
    });
    const updateRes = await updatePUT(updateReq, { params: Promise.resolve({ id: accountId }) });
    expect(updateRes.status).toBe(200);

    const updateBody = await updateRes.json();
    expect(updateBody.account.name).toBe('Updated CRUD Account');

    // DELETE
    const deleteReq = new NextRequest(`http://localhost/api/accounts/${accountId}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: accountId }) });
    expect(deleteRes.status).toBe(200);

    // Verify it's gone
    const deleted = await db.glAccount.findUnique({ where: { id: accountId } });
    expect(deleted).toBeNull();
  });

  it('debe rechazar codigo duplicado en la misma empresa', async () => {
    const user = await createTestUser('gl-dup@example.com');
    const company = await createTestCompany('GL Dup Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const body = {
      code: '1111',
      name: 'Original',
      accountType: 'asset',
      normalBalance: 'debit' as const,
    };

    const req1 = new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res1 = await createPOST(req1, { params: Promise.resolve({}) });
    expect(res1.status).toBe(201);

    const req2 = new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res2 = await createPOST(req2, { params: Promise.resolve({}) });
    expect(res2.status).toBe(409);
  });

  it('debe devolver 404 al leer cuenta inexistente', async () => {
    const user = await createTestUser('gl-404@example.com');
    const company = await createTestCompany('GL 404 Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/accounts/non-existent-id?companyId=${company.id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const res = await getGET(req, { params: Promise.resolve({ id: 'non-existent-id' }) });
    expect(res.status).toBe(404);
  });

  it('debe aislar cuentas entre empresas', async () => {
    const user = await createTestUser('gl-iso@example.com');
    const companyA = await createTestCompany('Company A');
    const companyB = await createTestCompany('Company B');
    await createTestCompanyMember(user.id, companyA.id);
    await createTestCompanyMember(user.id, companyB.id);
    const token = await createSession(user.id);

    // Create account in company A
    const reqA = new NextRequest(`http://localhost/api/accounts?companyId=${companyA.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'A001', name: 'Company A Account', accountType: 'asset', normalBalance: 'debit' }),
    });
    const resA = await createPOST(reqA, { params: Promise.resolve({}) });
    expect(resA.status).toBe(201);

    // Create account in company B
    const reqB = new NextRequest(`http://localhost/api/accounts?companyId=${companyB.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'B001', name: 'Company B Account', accountType: 'asset', normalBalance: 'debit' }),
    });
    const resB = await createPOST(reqB, { params: Promise.resolve({}) });
    expect(resB.status).toBe(201);

    // List accounts for company A should not include B's account
    const listReq = new NextRequest(`http://localhost/api/accounts?companyId=${companyA.id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const listRes = await listGET(listReq, { params: Promise.resolve({}) });
    const listBody = await listRes.json();
    const codes = listBody.accounts.map((a: { code: string }) => a.code);
    expect(codes).toContain('A001');
    expect(codes).not.toContain('B001');
  });
});
