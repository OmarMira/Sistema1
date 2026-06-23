import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as createBankRule } from '@/app/api/bank-rules/route';
import { PUT } from '@/app/api/bank-rules/[id]/route';
import { POST as applyAll } from '@/app/api/bank-rules/apply-all/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('Bank Rules Consolidation — Integration Tests', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // ─── 4.2 PUT dedup ─────────────────────────────────────────────────

  describe('PUT dedup — same name within company', () => {
    it('debe rechazar con 409 cuando se actualiza una regla con nombre duplicado en la misma compañía', async () => {
      const user = await createTestUser('cpa@example.com');
      const company = await createTestCompany('Audit Corp');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);
      const glAccount = await createTestGlAccount({ companyId: company.id, code: '6000', name: 'Expense' });

      // Create first rule "Intereses"
      const createReq = new NextRequest('http://localhost/api/bank-rules', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companyId: company.id,
          name: 'Intereses',
          transactionDirection: 'debit',
          debitGlAccountId: glAccount.id,
          conditions: [{ field: 'description', operator: 'contains', value: 'INTERES' }],
          priority: 10,
        }),
      });
      const createRes = await createBankRule(createReq, { params: Promise.resolve({}) });
      expect(createRes.status).toBe(201);
      const firstRule = await createRes.json();

      // Create second rule "Other Rule" — capture its id from response.data
      const createReq2 = new NextRequest('http://localhost/api/bank-rules', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companyId: company.id,
          name: 'Other Rule',
          transactionDirection: 'debit',
          debitGlAccountId: glAccount.id,
          conditions: [{ field: 'description', operator: 'contains', value: 'OTHER' }],
          priority: 20,
        }),
      });
      const createRes2 = await createBankRule(createReq2, { params: Promise.resolve({}) });
      expect(createRes2.status).toBe(201);
      const secondRuleData = await createRes2.json();
      const secondRuleId = secondRuleData.data.id;

      // Try to rename second rule to "Intereses" — should conflict
      const putReq = new NextRequest(`http://localhost/api/bank-rules/${secondRuleId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-company-id': company.id,
        },
        body: JSON.stringify({ name: 'Intereses' }),
      });
      const putRes = await PUT(putReq, { params: Promise.resolve({ id: secondRuleId }) });
      expect(putRes.status).toBe(409);
      const putBody = await putRes.json();
      expect(putBody.error).toBe('Ya existe una regla con este nombre.');
    });

    it('debe permitir el mismo nombre en diferentes compañías', async () => {
      const user = await createTestUser('admin@example.com');
      const companyA = await createTestCompany('Company A');
      const companyB = await createTestCompany('Company B');
      await createTestCompanyMember(user.id, companyA.id);
      await createTestCompanyMember(user.id, companyB.id);
      const token = await createSession(user.id);
      const glAccountA = await createTestGlAccount({ companyId: companyA.id, code: '6000', name: 'Expense' });
      const glAccountB = await createTestGlAccount({ companyId: companyB.id, code: '6001', name: 'Expense' });

      // Create rule "Intereses" for company A
      const createReq = new NextRequest('http://localhost/api/bank-rules', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companyId: companyA.id,
          name: 'Intereses',
          transactionDirection: 'debit',
          debitGlAccountId: glAccountA.id,
          conditions: [{ field: 'description', operator: 'contains', value: 'INTERES' }],
          priority: 10,
        }),
      });
      const createRes = await createBankRule(createReq, { params: Promise.resolve({}) });
      expect(createRes.status).toBe(201);

      // Create rule "Other" for company B — capture id from response.data
      const createReq2 = new NextRequest('http://localhost/api/bank-rules', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companyId: companyB.id,
          name: 'Other',
          transactionDirection: 'debit',
          debitGlAccountId: glAccountB.id,
          conditions: [{ field: 'description', operator: 'contains', value: 'OTHER' }],
          priority: 20,
        }),
      });
      const createRes2 = await createBankRule(createReq2, { params: Promise.resolve({}) });
      expect(createRes2.status).toBe(201);
      const ruleBData = await createRes2.json();
      const ruleBId = ruleBData.data.id;

      // Rename company B's rule to "Intereses" — should succeed (different company)
      const putReq = new NextRequest(`http://localhost/api/bank-rules/${ruleBId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-company-id': companyB.id,
        },
        body: JSON.stringify({ name: 'Intereses' }),
      });
      const putRes = await PUT(putReq, { params: Promise.resolve({ id: ruleBId }) });
      expect(putRes.status).toBe(200);
    });
  });

  // ─── 4.3 Apply-all cap ─────────────────────────────────────────────

  describe('Apply-all maxApplyTransactions cap', () => {
    async function setupApplyAllTest(companyId: string, token: string, glAccountId: string) {
      const bankAccount = await createTestBankAccount(companyId, glAccountId, 'Test Bank');
      const statement = await createTestBankStatement(companyId, bankAccount.id);

      // Create a rule that matches "AMAZON" transactions
      await db.bankRule.create({
        data: {
          companyId,
          name: 'Amazon Rule',
          conditionType: 'contains',
          conditionValue: 'AMAZON',
          transactionDirection: 'any',
          glAccountId,
          priority: 10,
        },
      });

      // Create transactions via Prisma directly to control exact count
      const date = new Date('2025-06-01');
      for (let i = 0; i < 12; i++) {
        await db.bankTransaction.create({
          data: {
            statementId: statement.id,
            date,
            amount: -50.0,
            description: `AMAZON PURCHASE ${i + 1}`,
            isReconciled: false,
          },
        });
      }

      return { bankAccount, statement };
    }

    it('maxApplyTransactions=null debe aplicar todas sin warning', async () => {
      const user = await createTestUser('test@example.com');
      const company = await createTestCompany('Unlimited Co');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);
      const glAccount = await createTestGlAccount({ companyId: company.id, code: '5000', name: 'Expense' });

      // maxApplyTransactions defaults to null
      await setupApplyAllTest(company.id, token, glAccount.id);

      const req = new NextRequest('http://localhost/api/bank-rules/apply-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ companyId: company.id }),
      });
      const res = await applyAll(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matched).toBe(12);
      expect(body.total).toBe(12);
      expect(body.warning).toBeUndefined();
    });

    it('maxApplyTransactions=0 debe bloquear todo y retornar warning', async () => {
      const user = await createTestUser('test@example.com');
      const company = await createTestCompany('Blocked Co');
      await createTestCompanyMember(user.id, company.id);
      await db.company.update({
        where: { id: company.id },
        data: { maxApplyTransactions: 0 },
      });
      const token = await createSession(user.id);
      const glAccount = await createTestGlAccount({ companyId: company.id, code: '5001', name: 'Expense' });

      await setupApplyAllTest(company.id, token, glAccount.id);

      const req = new NextRequest('http://localhost/api/bank-rules/apply-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ companyId: company.id }),
      });
      const res = await applyAll(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matched).toBe(0);
      expect(body.total).toBe(12);
      expect(body.warning).toBeDefined();
      expect(body.warning).toContain('0');
      expect(body.warning).toContain('12');
    });

    it('maxApplyTransactions=5 con 12 pendientes debe aplicar 5 con warning', async () => {
      const user = await createTestUser('test@example.com');
      const company = await createTestCompany('Capped Co');
      await createTestCompanyMember(user.id, company.id);
      await db.company.update({
        where: { id: company.id },
        data: { maxApplyTransactions: 5 },
      });
      const token = await createSession(user.id);
      const glAccount = await createTestGlAccount({ companyId: company.id, code: '5002', name: 'Expense' });

      await setupApplyAllTest(company.id, token, glAccount.id);

      const req = new NextRequest('http://localhost/api/bank-rules/apply-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ companyId: company.id }),
      });
      const res = await applyAll(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matched).toBe(5);
      expect(body.total).toBe(12);
      expect(body.warning).toBeDefined();
      expect(body.warning).toContain('5');
      expect(body.warning).toContain('12');
    });

    it('maxApplyTransactions=10 con 10 pendientes debe aplicar todas sin warning (exact match)', async () => {
      const user = await createTestUser('test@example.com');
      const company = await createTestCompany('Exact Co');
      await createTestCompanyMember(user.id, company.id);
      await db.company.update({
        where: { id: company.id },
        data: { maxApplyTransactions: 10 },
      });
      const token = await createSession(user.id);
      const glAccount = await createTestGlAccount({ companyId: company.id, code: '5003', name: 'Expense' });

      await setupApplyAllTest(company.id, token, glAccount.id);

      // Only create 10 transactions instead of 12
      const bankAccount = await db.bankAccount.findFirstOrThrow({
        where: { companyId: company.id },
      });
      const statement = await db.bankStatement.findFirstOrThrow({
        where: { bankAccountId: bankAccount.id },
      });

      // Clean the 12 auto-created and add 10
      await db.bankTransaction.deleteMany({ where: { statementId: statement.id } });
      const date = new Date('2025-06-01');
      for (let i = 0; i < 10; i++) {
        await db.bankTransaction.create({
          data: {
            statementId: statement.id,
            date,
            amount: -50.0,
            description: `AMAZON PURCHASE ${i + 1}`,
            isReconciled: false,
          },
        });
      }

      const req = new NextRequest('http://localhost/api/bank-rules/apply-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ companyId: company.id }),
      });
      const res = await applyAll(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matched).toBe(10);
      expect(body.total).toBe(10);
      expect(body.warning).toBeUndefined();
    });
  });

  // ─── 4.4 Import delegation ─────────────────────────────────────────

  describe('Import delegation preserves autoCategorizedCount', () => {
    it('debe categorizar correctamente usando el engine delegado', async () => {
      const user = await createTestUser('cpa@example.com');
      const company = await createTestCompany('Import Test Co');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAccount1 = await createTestGlAccount({
        companyId: company.id,
        code: '6000',
        name: 'Office Supplies',
      });
      const glAccount2 = await createTestGlAccount({
        companyId: company.id,
        code: '6001',
        name: 'Transit',
      });

      // Create rules matching specific descriptions
      await db.bankRule.create({
        data: {
          companyId: company.id,
          name: 'Amazon',
          conditionType: 'contains',
          conditionValue: 'AMAZON',
          transactionDirection: 'any',
          glAccountId: glAccount1.id,
          priority: 10,
        },
      });

      await db.bankRule.create({
        data: {
          companyId: company.id,
          name: 'Uber',
          conditionType: 'contains',
          conditionValue: 'UBER',
          transactionDirection: 'any',
          glAccountId: glAccount2.id,
          priority: 10,
        },
      });

      // Create a bank account for the import flow
      const bankAccount = await createTestBankAccount(
        company.id,
        glAccount1.id,
        'Test Bank',
      );

      // Import a CSV via the service — this exercises the delegation path
      const { ImportService } = await import('@/lib/services/import.service');
      const csvContent =
        'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99\n2025-06-02,UBER RIDE,-12.50\n2025-06-03,COFFEE SHOP,-5.00';
      const buffer = Buffer.from(csvContent);

      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer,
        content: csvContent,
        userId: user.id,
      });

      // 2 out of 3 should be auto-categorized
      expect(result.autoCategorizedCount).toBe(2);
      expect(result.transactionCount).toBe(3);
    });
  });
});
