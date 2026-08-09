import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PATCH } from '../../src/app/api/accounting-flow/audit/link/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('P11 — PATCH /api/accounting-flow/audit/link (aislamiento de tenant)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('rechaza que el usuario de A vincule una transacción de la empresa B a una línea propia', async () => {
    const userA = await createTestUser('p11-a@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const glA = await createTestGlAccount({ companyId: companyA.id, code: '1010', name: 'Cash A', accountType: 'asset', normalBalance: 'debit' });
    await createTestJournalEntry(companyA.id, {
      date: '2026-01-10T00:00:00.000Z',
      description: 'A journal entry',
      reference: null,
      lines: [{ glAccountId: glA.id, debit: 100, credit: 0 }],
    });
    const lineA = await db.journalLine.findFirst({
      where: { glAccount: { companyId: companyA.id } },
      orderBy: { id: 'asc' },
    });
    expect(lineA).toBeTruthy();

    const companyB = await createTestCompany('Company B');
    const glB = await createTestGlAccount({ companyId: companyB.id, code: '2010', name: 'Cash B', accountType: 'asset', normalBalance: 'debit' });
    const bankB = await createTestBankAccount(companyB.id, glB.id, 'Bank B');
    const statementB = await createTestBankStatement(companyB.id, bankB.id);
    const txB = await createTestBankTransaction(companyB.id, statementB.id, {
      date: '2026-01-15T00:00:00.000Z',
      amount: 250,
      description: 'Transaction belonging to Company B',
    });

    const res = await PATCH(
      new NextRequest(`http://localhost/api/accounting-flow/audit/link?companyId=${companyA.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankTransactionId: txB.id, journalLineId: lineA.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);

    const after = await db.bankTransaction.findUnique({ where: { id: txB.id } });
    expect(after!.journalLineId).toBeNull();
  });

  it('permite que el usuario de A vincule una transacción propia a una línea propia (200, enlazada)', async () => {
    const userA = await createTestUser('p11-c@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const glA = await createTestGlAccount({ companyId: companyA.id, code: '1010', name: 'Cash A', accountType: 'asset', normalBalance: 'debit' });
    await createTestJournalEntry(companyA.id, {
      date: '2026-01-10T00:00:00.000Z',
      description: 'A journal entry',
      reference: null,
      lines: [{ glAccountId: glA.id, debit: 100, credit: 0 }],
    });
    const lineA = await db.journalLine.findFirst({
      where: { glAccount: { companyId: companyA.id } },
      orderBy: { id: 'asc' },
    });
    expect(lineA).toBeTruthy();

    const bankA = await createTestBankAccount(companyA.id, glA.id, 'Bank A');
    const statementA = await createTestBankStatement(companyA.id, bankA.id);
    const txA = await createTestBankTransaction(companyA.id, statementA.id, {
      date: '2026-01-15T00:00:00.000Z',
      amount: 100,
      description: 'Transaction belonging to Company A',
    });

    const res = await PATCH(
      new NextRequest(`http://localhost/api/accounting-flow/audit/link?companyId=${companyA.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankTransactionId: txA.id, journalLineId: lineA!.id }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const after = await db.bankTransaction.findUnique({ where: { id: txA.id } });
    expect(after!.journalLineId).toBe(lineA!.id);
  });
});