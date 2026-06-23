import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as scanPOST } from '../../src/app/api/ai-rules/scan/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('POST /api/ai-rules/scan - Role Hierarchy Resolution', () => {
  beforeEach(async () => {
    await clearDatabase();
    await db.entityContext.deleteMany().catch(() => {});
  });

  afterEach(async () => {
    await clearDatabase();
    await db.entityContext.deleteMany().catch(() => {});
  });

  it('debe aplicar la jerarquía de roles cuando hay múltiples contextos coincidentes', async () => {
    const user = await createTestUser('scan-admin@example.com');
    const company = await createTestCompany('Scan Company');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    // Create GL Accounts
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id, 'Main Bank Account');
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    // Accounts for suggestions
    const providerAccount = await createTestGlAccount({ companyId: company.id, code: '5010', name: 'Provider Expense', accountType: 'expense' });
    const socioAccount = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Socio Equity', accountType: 'equity', normalBalance: 'credit' });

    // Create entity contexts
    // 1. Toyota as PROVEEDOR (high priority index 1 -> value 2 in entity-roles.json)
    await db.entityContext.create({
      data: {
        companyId: company.id,
        pattern: 'toyota',
        role: 'PROVEEDOR',
        roles: JSON.stringify(['PROVEEDOR']),
        source: 'user',
        glAccountId: providerAccount.id,
      },
    });

    // 2. Laura as SOCIO (lower priority index 2 -> value 3 in entity-roles.json)
    await db.entityContext.create({
      data: {
        companyId: company.id,
        pattern: 'laura',
        role: 'SOCIO',
        roles: JSON.stringify(['SOCIO']),
        source: 'user',
        glAccountId: socioAccount.id,
      },
    });

    // Create at least 3 transactions to trigger MIN_OCCURRENCES = 3 in the scanner
    // The description matches BOTH "toyota" and "laura": "TOYOTA DES:ACH PMT INFO INDN:LAURA QUIJANO"
    await createTestBankTransaction(company.id, statement.id, {
      date: '2026-06-01',
      amount: -150.0,
      description: 'TOYOTA DES:ACH PMT INFO INDN:LAURA QUIJANO 01',
    });
    await createTestBankTransaction(company.id, statement.id, {
      date: '2026-06-02',
      amount: -150.0,
      description: 'TOYOTA DES:ACH PMT INFO INDN:LAURA QUIJANO 02',
    });
    await createTestBankTransaction(company.id, statement.id, {
      date: '2026-06-03',
      amount: -150.0,
      description: 'TOYOTA DES:ACH PMT INFO INDN:LAURA QUIJANO 03',
    });

    // Invoke scanner API
    const req = new NextRequest(`http://localhost/api/ai-rules/scan?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await scanPOST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.patterns).toHaveLength(1);

    // The pattern should suggest the provider account (Toyota) rather than the socio account (Laura)
    // because PROVEEDOR (Toyota) has higher priority.
    const pattern = body.patterns[0];
    expect(pattern.contextRole).toBe('PROVEEDOR');
    expect(pattern.suggestedAccountId).toBe(providerAccount.id);
    expect(pattern.suggestedAccountCode).toBe('5010');
  });
});
