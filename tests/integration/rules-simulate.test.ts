import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/learning/rules/simulate/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('Rules Simulation API Integration Tests', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe denegar acceso a usuarios no autorizados (sin token)', async () => {
    const company = await createTestCompany('Sim Corp');
    const req = new NextRequest('http://localhost/api/learning/rules/simulate', {
      method: 'POST',
      body: JSON.stringify({
        companyId: company.id,
        conditions: [],
      }),
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
  });

  it('debe denegar acceso si el usuario no es miembro de la empresa', async () => {
    const user = await createTestUser('other@example.com');
    const company = await createTestCompany('Sim Corp');
    const token = await createSession(user.id);

    const req = new NextRequest('http://localhost/api/learning/rules/simulate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyId: company.id,
        conditions: [],
      }),
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
  });

  it('debe rechazar payloads malformados o inválidos (Zod validation)', async () => {
    const user = await createTestUser('member@example.com');
    const company = await createTestCompany('Sim Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const req = new NextRequest('http://localhost/api/learning/rules/simulate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyId: company.id,
        conditions: [
          {
            field: 'invalid_field', // invalid field name
            operator: 'contains',
            value: '',
          },
        ],
      }),
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(400);
  });

  it('debe evaluar correctamente múltiples condiciones (AND) y retornar un máximo de 5 muestras', async () => {
    const user = await createTestUser('member@example.com');
    const company = await createTestCompany('Sim Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    // Create 7 matching transactions (to test limit of 5 samples)
    for (let i = 1; i <= 7; i++) {
      await createTestBankTransaction(company.id, statement.id, {
        date: `2025-03-0${i}`,
        amount: -100.0 - i, // amount matches greater_than 50
        description: `Zelle Payment from John Doe #${i}`,
        reference: `REF00${i}`,
      });
    }

    // Create 1 non-matching transaction (different description)
    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-10',
      amount: -200.0,
      description: `Monthly Bank Fee`,
      reference: 'FEE123',
    });

    // Create 1 non-matching transaction (already reconciled)
    const reconciledTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-11',
      amount: -150.0,
      description: `Zelle Payment from Jane Doe`,
      reference: 'REF100',
    });
    await db.bankTransaction.update({
      where: { id: reconciledTx.id },
      data: { isReconciled: true },
    });

    const req = new NextRequest('http://localhost/api/learning/rules/simulate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyId: company.id,
        conditions: [
          {
            field: 'description',
            operator: 'contains',
            value: 'Zelle',
          },
          {
            field: 'amount',
            operator: 'greater_than',
            value: '50',
          },
        ],
      }),
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(7); // Matches the 7 unreconciled Zelle txs, skips fee and reconciled tx
    expect(result.samples.length).toBe(5); // Limited to 5 samples
    
    // Verify first sample content
    expect(result.samples[0]).toHaveProperty('date');
    expect(result.samples[0]).toHaveProperty('description');
    expect(result.samples[0]).toHaveProperty('amount');
    expect(result.samples[0]).toHaveProperty('reference');
    expect(result.samples[0].description).toContain('Zelle');
  });
});
