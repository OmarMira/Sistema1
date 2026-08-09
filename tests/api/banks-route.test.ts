import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '../../src/app/api/banks/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('H9 — POST /api/banks (saldo inicial y período fiscal)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('rechaza crear cuenta con saldo inicial si el período actual está bloqueado (sin JE ni estado parcial)', async () => {
    const user = await createTestUser('h9-banks@example.com');
    const company = await createTestCompany('H9 Banks Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' });

    const now = new Date();
    const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const endToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'Today (locked)',
        startDate: startToday,
        endDate: endToday,
        isLocked: true,
      },
    });

    const bankCountBefore = await db.bankAccount.count({ where: { companyId: company.id } });
    const jeCountBefore = await db.journalEntry.count({ where: { companyId: company.id } });

    const res = await POST(
      new NextRequest(`http://localhost/api/banks?companyId=${company.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accountName: 'Checking',
          bankName: 'Test Bank',
          glAccountId: cashGl.id,
          balance: 500,
        }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);

    const bankCountAfter = await db.bankAccount.count({ where: { companyId: company.id } });
    expect(bankCountAfter).toBe(bankCountBefore);

    const jeCountAfter = await db.journalEntry.count({ where: { companyId: company.id } });
    expect(jeCountAfter).toBe(jeCountBefore);
  });
});