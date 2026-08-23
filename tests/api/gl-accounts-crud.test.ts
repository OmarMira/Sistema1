import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as listGET, POST as createPOST } from '../../src/app/api/accounts/route';
import { GET as getGET, PUT as updatePUT, DELETE as deleteDELETE } from '../../src/app/api/accounts/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestJournalEntry, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { journalAccountsCache } from '@/lib/cache';

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

  // ─── D2-H7: DELETE atomicity (ON DELETE SET NULL via FK) ────────────────

  it('D2-H7: delete con hijos sin movimientos → hijos quedan parentId=null', async () => {
    const user = await createTestUser('gl-d2h7-children@example.com');
    const company = await createTestCompany('D2-H7 Children Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const parent = await createTestGlAccount({ companyId: company.id, code: 'P100', name: 'Parent' });
    const child1 = await createTestGlAccount({ companyId: company.id, code: 'C101', name: 'Child 1' });
    const child2 = await createTestGlAccount({ companyId: company.id, code: 'C102', name: 'Child 2' });

    await db.glAccount.update({ where: { id: child1.id }, data: { parentId: parent.id } });
    await db.glAccount.update({ where: { id: child2.id }, data: { parentId: parent.id } });

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${parent.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: parent.id }) });
    expect(deleteRes.status).toBe(200);

    const deletedParent = await db.glAccount.findUnique({ where: { id: parent.id } });
    expect(deletedParent).toBeNull();

    const survivingChild1 = await db.glAccount.findUnique({ where: { id: child1.id } });
    expect(survivingChild1).not.toBeNull();
    expect(survivingChild1!.parentId).toBeNull();

    const survivingChild2 = await db.glAccount.findUnique({ where: { id: child2.id } });
    expect(survivingChild2).not.toBeNull();
    expect(survivingChild2!.parentId).toBeNull();
  });

  it('D2-H7: delete con BankTransactions → transacciones sobreviven con glAccountId=null', async () => {
    const user = await createTestUser('gl-d2h7-bt@example.com');
    const company = await createTestCompany('D2-H7 BT Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const targetGlAccount = await createTestGlAccount({ companyId: company.id, code: 'B100', name: 'Target to delete' });
    const bankGlAccount = await createTestGlAccount({ companyId: company.id, code: 'B200', name: 'Bank GL' });
    const bankAccount = await createTestBankAccount(company.id, bankGlAccount.id, 'Test Bank');
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bt = await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-03-15'),
        amount: 500,
        description: 'Test transaction',
        glAccountId: targetGlAccount.id,
      },
    });

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${targetGlAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: targetGlAccount.id }) });
    expect(deleteRes.status).toBe(200);

    const deletedAccount = await db.glAccount.findUnique({ where: { id: targetGlAccount.id } });
    expect(deletedAccount).toBeNull();

    const survivingBt = await db.bankTransaction.findUnique({ where: { id: bt.id } });
    expect(survivingBt).not.toBeNull();
    expect(survivingBt!.glAccountId).toBeNull();
  });

  it('D2-H7: delete con JournalLine propia → 409, cuenta permanece', async () => {
    const user = await createTestUser('gl-d2h7-jl@example.com');
    const company = await createTestCompany('D2-H7 JL Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'J100', name: 'With Journal' });
    const entry = await createTestJournalEntry(company.id, {
      date: '2025-03-15',
      description: 'Test entry',
      lines: [
        { glAccountId: glAccount.id, debit: 100, credit: 0 },
        { glAccountId: glAccount.id, debit: 0, credit: 100, description: 'offset' },
      ],
    });

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(deleteRes.status).toBe(409);

    const body = await deleteRes.json();
    expect(body.error).toContain('asiento');

    const accountStillExists = await db.glAccount.findUnique({ where: { id: glAccount.id } });
    expect(accountStillExists).not.toBeNull();
  });

  it('D2-H7: delete de padre cuyo descendiente tiene JournalLines → 409, jerarquía intacta', async () => {
    const user = await createTestUser('gl-d2h7-hier@example.com');
    const company = await createTestCompany('D2-H7 Hier Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const parent = await createTestGlAccount({ companyId: company.id, code: 'H100', name: 'Parent' });
    const child = await createTestGlAccount({ companyId: company.id, code: 'H101', name: 'Child' });
    await db.glAccount.update({ where: { id: child.id }, data: { parentId: parent.id } });

    await createTestJournalEntry(company.id, {
      date: '2025-03-15',
      description: 'Entry on child',
      lines: [
        { glAccountId: child.id, debit: 200, credit: 0 },
        { glAccountId: child.id, debit: 0, credit: 200, description: 'offset' },
      ],
    });

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${parent.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: parent.id }) });
    expect(deleteRes.status).toBe(409);

    const body = await deleteRes.json();
    expect(body.error).toContain('asiento');

    const parentStillExists = await db.glAccount.findUnique({ where: { id: parent.id } });
    expect(parentStillExists).not.toBeNull();
    expect(parentStillExists!.parentId).toBeNull();

    const childStillExists = await db.glAccount.findUnique({ where: { id: child.id } });
    expect(childStillExists).not.toBeNull();
    expect(childStillExists!.parentId).toBe(parent.id);
  });

  it('D2-H7: delete con BankAccount vinculada → 409, cuenta permanece', async () => {
    const user = await createTestUser('gl-d2h7-ba@example.com');
    const company = await createTestCompany('D2-H7 BA Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'BA100', name: 'With Bank' });
    await createTestBankAccount(company.id, glAccount.id, 'My Bank');

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(deleteRes.status).toBe(409);

    const body = await deleteRes.json();
    expect(body.error).toContain('cuenta(s) bancaria(s)');

    const accountStillExists = await db.glAccount.findUnique({ where: { id: glAccount.id } });
    expect(accountStillExists).not.toBeNull();
  });

  it('D2-H7: delete exitoso → cache invalidada', async () => {
    const user = await createTestUser('gl-d2h7-cache@example.com');
    const company = await createTestCompany('D2-H7 Cache Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'CA100', name: 'Cache Test' });

    const spy = vi.spyOn(journalAccountsCache, 'invalidate');

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(deleteRes.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(company.id);

    spy.mockRestore();
  });

  it('D2-H7: delete fallido → cache NO se invalida', async () => {
    const user = await createTestUser('gl-d2h7-nocache@example.com');
    const company = await createTestCompany('D2-H7 NoCache Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'NC100', name: 'No Cache' });
    const entry = await createTestJournalEntry(company.id, {
      date: '2025-03-15',
      description: 'Blocks delete',
      lines: [
        { glAccountId: glAccount.id, debit: 50, credit: 0 },
        { glAccountId: glAccount.id, debit: 0, credit: 50, description: 'offset' },
      ],
    });

    const spy = vi.spyOn(journalAccountsCache, 'invalidate');

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(deleteRes.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
