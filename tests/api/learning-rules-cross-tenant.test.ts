import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/learning/rules/route';
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

describe('P15 — POST /api/learning/rules (aislamiento cross-tenant de cuentas GL)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  function authRequest(url: string, token: string, body: unknown): NextRequest {
    return new NextRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  it('RED — rechaza debitGlAccountId de otra empresa (400, regla no creada)', async () => {
    const userA = await createTestUser('p15-a@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const glB = await createTestGlAccount({ companyId: companyB.id, code: '2010', name: 'Foreign B account' });

    const res = await POST(
      authRequest(`http://localhost/api/learning/rules?companyId=${companyA.id}`, tokenA, {
        pattern: 'OFFICE',
        debitGlAccountId: glB.id,
        creditGlAccountId: glB.id,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(400);

    const rules = await db.bankRule.findMany({
      where: {
        companyId: companyA.id,
        OR: [
          { glAccountId: glB.id },
          { debitGlAccountId: glB.id },
          { creditGlAccountId: glB.id },
        ],
      },
    });
    expect(rules).toHaveLength(0);
  });

  it('RED — rechaza creditGlAccountId de otra empresa (400, regla no creada)', async () => {
    const userA = await createTestUser('p15-c@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const glB = await createTestGlAccount({ companyId: companyB.id, code: '2020', name: 'Foreign B credit' });

    const res = await POST(
      authRequest(`http://localhost/api/learning/rules?companyId=${companyA.id}`, tokenA, {
        conditions: [{ field: 'description', operator: 'contains', value: 'OFFICE' }],
        creditGlAccountId: glB.id,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(400);

    const rules = await db.bankRule.findMany({
      where: { companyId: companyA.id, creditGlAccountId: glB.id },
    });
    expect(rules).toHaveLength(0);
  });

  it('PASS — acepta cuentas GL propias de la empresa A (A→A sigue funcionando)', async () => {
    const userA = await createTestUser('p15-ok@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const glA = await createTestGlAccount({ companyId: companyA.id, code: '6000', name: 'Office Expenses' });

    const res = await POST(
      authRequest(`http://localhost/api/learning/rules?companyId=${companyA.id}`, tokenA, {
        pattern: 'OFFICE',
        debitGlAccountId: glA.id,
        creditGlAccountId: glA.id,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const rules = await db.bankRule.findMany({
      where: { companyId: companyA.id, debitGlAccountId: glA.id },
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].debitGlAccountId).toBe(glA.id);
    expect(rules[0].creditGlAccountId).toBe(glA.id);
  });

  it('PASS — vector apply cross-tenant cerrado: no se contamina la empresa B', async () => {
    const userA = await createTestUser('p15-apply@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const glB = await createTestGlAccount({ companyId: companyB.id, code: '2010', name: 'Foreign B account' });
    const glBinitial = await db.glAccount.findUnique({ where: { id: glB.id } });

    const glA = await createTestGlAccount({ companyId: companyA.id, code: '1000', name: 'Cash A' });
    const bankAccount = await createTestBankAccount(companyA.id, glA.id, 'Bank A');
    const statement = await createTestBankStatement(companyA.id, bankAccount.id);
    await createTestBankTransaction(companyA.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'OFFICE DEPOT PURCHASE',
    });

    // Attempt to create a rule in A that references B's GL account.
    const createRes = await POST(
      authRequest(`http://localhost/api/learning/rules?companyId=${companyA.id}`, tokenA, {
        pattern: 'OFFICE',
        debitGlAccountId: glB.id,
        creditGlAccountId: glB.id,
      }),
      { params: Promise.resolve({}) },
    );

    // Regardless of whether creation was rejected, the apply path must never
    // write to B's chart of accounts or change B's balance.
    const { POST: applyAll } = await import('@/app/api/bank-rules/apply-all/route');
    const applyRes = await applyAll(
      new NextRequest('http://localhost/api/bank-rules/apply-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ companyId: companyA.id, confirmed: true }),
      }),
      { params: Promise.resolve({}) },
    );

    // The rule pointing at B must not exist (blocked at creation).
    const badRules = await db.bankRule.findMany({
      where: {
        companyId: companyA.id,
        OR: [{ debitGlAccountId: glB.id }, { creditGlAccountId: glB.id }],
      },
    });
    expect(badRules).toHaveLength(0);

    // No JournalLine may reference B's account.
    const linesOnB = await db.journalLine.findMany({ where: { glAccountId: glB.id } });
    expect(linesOnB).toHaveLength(0);

    // B's balance must be unchanged.
    const glBafter = await db.glAccount.findUnique({ where: { id: glB.id } });
    expect(Number(glBafter!.balance)).toBe(Number(glBinitial!.balance));

    // Sanity: apply endpoint still ran and returned a valid response.
    expect([200, 400, 403]).toContain(applyRes.status);
  });
});
