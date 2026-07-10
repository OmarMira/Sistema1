import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/bank-rules/route';
import { GET as getTopAccounts } from '@/app/api/bank-rules/top-accounts/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('Bank Rules Phase 3 Integration Tests', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe detectar un duplicado exacto y retornar 409', async () => {
    const user = await createTestUser('cpa@example.com');
    const company = await createTestCompany('Audit Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '6000', name: 'Rent Expense' });

    // Create the first rule
    const rule1Payload = {
      companyId: company.id,
      name: 'First Rule',
      transactionDirection: 'debit',
      debitGlAccountId: glAccount.id,
      conditions: [
        { field: 'description', operator: 'contains', value: 'Uber' }
      ],
      priority: 10,
    };

    const req1 = new NextRequest('http://localhost/api/bank-rules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rule1Payload),
    });

    const res1 = await POST(req1, { params: Promise.resolve({}) });
    expect(res1.status).toBe(201);

    // Try to create the exact duplicate rule
    const req2 = new NextRequest('http://localhost/api/bank-rules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyId: company.id,
        name: 'Duplicate Rule',
        transactionDirection: 'debit',
        debitGlAccountId: glAccount.id,
        conditions: [
          { field: 'description', operator: 'contains', value: 'Uber' }
        ],
        priority: 10,
      }),
    });

    const res2 = await POST(req2, { params: Promise.resolve({}) });
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error).toContain('identical conditions');
  });

  it('debe crear la regla y retornar advertencia de solapamiento si hay coincidencia parcial con mayor prioridad', async () => {
    const user = await createTestUser('cpa@example.com');
    const company = await createTestCompany('Audit Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '6000', name: 'Rent Expense' });

    // Create broad rule first with higher priority (priority = 5)
    const ruleBroadPayload = {
      companyId: company.id,
      name: 'Broad Uber Rule',
      transactionDirection: 'debit',
      debitGlAccountId: glAccount.id,
      conditions: [
        { field: 'description', operator: 'contains', value: 'Uber' }
      ],
      priority: 5,
    };

    const req1 = new NextRequest('http://localhost/api/bank-rules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ruleBroadPayload),
    });
    const res1 = await POST(req1, { params: Promise.resolve({}) });
    expect(res1.status).toBe(201);

    // Create specific rule with lower priority (priority = 10)
    const ruleSpecificPayload = {
      companyId: company.id,
      name: 'Specific Uber Eats Rule',
      transactionDirection: 'debit',
      debitGlAccountId: glAccount.id,
      conditions: [
        { field: 'description', operator: 'contains', value: 'Uber Eats' }
      ],
      priority: 10,
    };

    const req2 = new NextRequest('http://localhost/api/bank-rules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ruleSpecificPayload),
    });
    const res2 = await POST(req2, { params: Promise.resolve({}) });
    expect(res2.status).toBe(201);

    const body2 = await res2.json();
    expect(body2).toHaveProperty('warnings');
    expect(body2.warnings[0].message).toContain("pattern is broader than rule 'Broad Uber Rule'");
  });

  it('debe obtener las cuentas GL más utilizadas a través de /api/bank-rules/top-accounts', async () => {
    const user = await createTestUser('cpa@example.com');
    const company = await createTestCompany('Audit Corp');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const account1 = await createTestGlAccount({ companyId: company.id, code: '6001', name: 'Meals & Entertainment' });
    const account2 = await createTestGlAccount({ companyId: company.id, code: '6002', name: 'Software Subscription' });

    // Create rules associated with these accounts to accumulate usage
    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Meals Rule 1',
        conditionType: 'contains',
        conditionValue: 'restaurant',
        transactionDirection: 'debit',
        glAccountId: account1.id,
        conditions: [],
        priority: 10,
      }
    });

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Meals Rule 2',
        conditionType: 'contains',
        conditionValue: 'cafe',
        transactionDirection: 'debit',
        glAccountId: account1.id,
        conditions: [],
        priority: 10,
      }
    });

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Software Rule',
        conditionType: 'contains',
        conditionValue: 'github',
        transactionDirection: 'debit',
        glAccountId: account2.id,
        conditions: [],
        priority: 10,
      }
    });

    const req = new NextRequest(`http://localhost/api/bank-rules/top-accounts?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await getTopAccounts(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.length).toBe(2);

    // Verify ordering by useCount descending
    expect(body.data[0].code).toBe('6001'); // 2 uses
    expect(body.data[0].useCount).toBe(2);
    expect(body.data[1].code).toBe('6002'); // 1 use
    expect(body.data[1].useCount).toBe(1);
  });
});
