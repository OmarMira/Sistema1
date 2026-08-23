import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as listGET, POST as createPOST } from '../../src/app/api/accounts/route';
import { GET as getGET, PUT as updatePUT, DELETE as deleteDELETE } from '../../src/app/api/accounts/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestJournalEntry, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { journalAccountsCache } from '@/lib/cache';

const mockCreateAuditLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/audit')>();
  mockCreateAuditLog.mockImplementation(mod.createAuditLogWithRetry);
  return {
    ...mod,
    createAuditLogWithRetry: mockCreateAuditLog,
  };
});

describe('GL Accounts CRUD /api/accounts', () => {
  beforeEach(async () => {
    const actualAudit = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit');
    mockCreateAuditLog.mockImplementation(actualAudit.createAuditLogWithRetry);
    mockCreateAuditLog.mockClear();
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

  // ─── D2-H6: AuditLog atómico en CRUD de accounts ──────────────────────

  it('D2-H6: POST exitoso → ACCOUNT_CREATED con datos correctos', async () => {
    const user = await createTestUser('gl-d2h6-post-audit@example.com');
    const company = await createTestCompany('D2-H6 Post Audit Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const createReq = new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: 'D2H6',
        name: 'Audit Test Account',
        accountType: 'asset',
        normalBalance: 'debit',
      }),
    });
    const createRes = await createPOST(createReq, { params: Promise.resolve({}) });
    expect(createRes.status).toBe(201);

    const createBody = await createRes.json();
    const accountId = createBody.account.id;

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', entityId: accountId },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('ACCOUNT_CREATED');
    expect(auditLogs[0].companyId).toBe(company.id);
    expect(auditLogs[0].userId).toBe(user.id);

    const details = JSON.parse(auditLogs[0].details!);
    expect(details.code).toBe('D2H6');
    expect(details.name).toBe('Audit Test Account');
    expect(details.accountType).toBe('asset');
    expect(details.normalBalance).toBe('debit');
  });

  it('D2-H6: POST rollback si AuditLog falla → cuenta no persiste', async () => {
    const user = await createTestUser('gl-d2h6-post-rollback@example.com');
    const company = await createTestCompany('D2-H6 Post Rollback Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit failure'));

    const createReq = new NextRequest(`http://localhost/api/accounts?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: 'D2RB',
        name: 'Rollback Test',
        accountType: 'asset',
        normalBalance: 'debit',
      }),
    });
    const createRes = await createPOST(createReq, { params: Promise.resolve({}) });
    expect(createRes.status).toBe(500);

    const created = await db.glAccount.findFirst({
      where: { companyId: company.id, code: 'D2RB' },
    });
    expect(created).toBeNull();

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', action: 'ACCOUNT_CREATED', companyId: company.id },
    });
    expect(auditLogs).toHaveLength(0);
  });

  it('D2-H6: PUT exitoso → ACCOUNT_UPDATED con datos correctos', async () => {
    const user = await createTestUser('gl-d2h6-put-audit@example.com');
    const company = await createTestCompany('D2-H6 Put Audit Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'U100', name: 'Original Name' });

    const updateReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    const updateRes = await updatePUT(updateReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(updateRes.status).toBe(200);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', entityId: glAccount.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('ACCOUNT_UPDATED');
    expect(auditLogs[0].companyId).toBe(company.id);
    expect(auditLogs[0].userId).toBe(user.id);

    const details = JSON.parse(auditLogs[0].details!);
    expect(details.name).toBe('Updated Name');
  });

  it('D2-H6: PUT rollback si AuditLog falla → cuenta conserva valores anteriores', async () => {
    const user = await createTestUser('gl-d2h6-put-rollback@example.com');
    const company = await createTestCompany('D2-H6 Put Rollback Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'R100', name: 'Keep Original' });

    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit failure'));

    const updateReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Should Not Persist' }),
    });
    const updateRes = await updatePUT(updateReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(updateRes.status).toBe(500);

    const reloaded = await db.glAccount.findUnique({ where: { id: glAccount.id } });
    expect(reloaded!.name).toBe('Keep Original');

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', entityId: glAccount.id },
    });
    expect(auditLogs).toHaveLength(0);
  });

  it('D2-H6: DELETE exitoso → ACCOUNT_DELETED con datos correctos', async () => {
    const user = await createTestUser('gl-d2h6-delete-audit@example.com');
    const company = await createTestCompany('D2-H6 Delete Audit Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'D100', name: 'To Delete' });

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(deleteRes.status).toBe(200);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', entityId: glAccount.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('ACCOUNT_DELETED');
    expect(auditLogs[0].companyId).toBe(company.id);
    expect(auditLogs[0].userId).toBe(user.id);

    const details = JSON.parse(auditLogs[0].details!);
    expect(details.code).toBe('D100');
    expect(details.name).toBe('To Delete');
    expect(details.accountType).toBeDefined();
    expect(details.normalBalance).toBeDefined();
  });

  it('D2-H6: DELETE exitoso con hijo + BankTransaction → preserva D2-H7', async () => {
    const user = await createTestUser('gl-d2h6-delete-d2h7@example.com');
    const company = await createTestCompany('D2-H6 Delete D2H7 Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const parent = await createTestGlAccount({ companyId: company.id, code: 'DP10', name: 'Parent' });
    const child = await createTestGlAccount({ companyId: company.id, code: 'DC10', name: 'Child' });
    await db.glAccount.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const bankGl = await createTestGlAccount({ companyId: company.id, code: 'DB10', name: 'Bank GL' });
    const bankAccount = await createTestBankAccount(company.id, bankGl.id, 'Test Bank');
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bt = await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-03-15'),
        amount: 300,
        description: 'BT for D2-H6',
        glAccountId: parent.id,
      },
    });

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${parent.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: parent.id }) });
    expect(deleteRes.status).toBe(200);

    const deletedParent = await db.glAccount.findUnique({ where: { id: parent.id } });
    expect(deletedParent).toBeNull();

    const survivingChild = await db.glAccount.findUnique({ where: { id: child.id } });
    expect(survivingChild).not.toBeNull();
    expect(survivingChild!.parentId).toBeNull();

    const survivingBt = await db.bankTransaction.findUnique({ where: { id: bt.id } });
    expect(survivingBt).not.toBeNull();
    expect(survivingBt!.glAccountId).toBeNull();

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', entityId: parent.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('ACCOUNT_DELETED');
  });

  it('D2-H6: DELETE rollback si AuditLog falla → cuenta y relaciones se conservan', async () => {
    const user = await createTestUser('gl-d2h6-delete-rollback@example.com');
    const company = await createTestCompany('D2-H6 Delete Rollback Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const parent = await createTestGlAccount({ companyId: company.id, code: 'RP10', name: 'Rollback Parent' });
    const child = await createTestGlAccount({ companyId: company.id, code: 'RC10', name: 'Rollback Child' });
    await db.glAccount.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const bankGl = await createTestGlAccount({ companyId: company.id, code: 'RB10', name: 'Bank GL RB' });
    const bankAccount = await createTestBankAccount(company.id, bankGl.id, 'Test Bank RB');
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bt = await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-03-15'),
        amount: 200,
        description: 'BT for rollback',
        glAccountId: parent.id,
      },
    });

    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit failure'));

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${parent.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: parent.id }) });
    expect(deleteRes.status).toBe(500);

    const accountStillExists = await db.glAccount.findUnique({ where: { id: parent.id } });
    expect(accountStillExists).not.toBeNull();
    expect(accountStillExists!.code).toBe('RP10');

    const childStillHasParent = await db.glAccount.findUnique({ where: { id: child.id } });
    expect(childStillHasParent).not.toBeNull();
    expect(childStillHasParent!.parentId).toBe(parent.id);

    const btStillLinked = await db.bankTransaction.findUnique({ where: { id: bt.id } });
    expect(btStillLinked).not.toBeNull();
    expect(btStillLinked!.glAccountId).toBe(parent.id);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'GlAccount', entityId: parent.id },
    });
    expect(auditLogs).toHaveLength(0);
  });

  it('D2-H6: DELETE rollback → cache NO invalidada', async () => {
    const user = await createTestUser('gl-d2h6-delete-cache@example.com');
    const company = await createTestCompany('D2-H6 Delete Cache Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'CC10', name: 'Cache Check' });

    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit failure'));
    const cacheSpy = vi.spyOn(journalAccountsCache, 'invalidate');

    const deleteReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const deleteRes = await deleteDELETE(deleteReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(deleteRes.status).toBe(500);
    expect(cacheSpy).not.toHaveBeenCalled();

    cacheSpy.mockRestore();
  });

  it('D2-H6: GET no genera eventos AuditLog', async () => {
    const user = await createTestUser('gl-d2h6-get-no-audit@example.com');
    const company = await createTestCompany('D2-H6 Get No Audit Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: 'GA10', name: 'No Audit' });

    const beforeCount = await db.auditLog.count({
      where: { entity: 'GlAccount' },
    });

    const getReq = new NextRequest(`http://localhost/api/accounts/${glAccount.id}?companyId=${company.id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const getRes = await getGET(getReq, { params: Promise.resolve({ id: glAccount.id }) });
    expect(getRes.status).toBe(200);

    const afterCount = await db.auditLog.count({
      where: { entity: 'GlAccount' },
    });
    expect(afterCount).toBe(beforeCount);
  });
});
