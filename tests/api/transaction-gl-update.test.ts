import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PATCH } from '../../src/app/api/transactions/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction, createTestJournalEntry, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import * as JournalEntryServiceModule from '@/lib/services/journal-entry.service';

describe('H1 — PATCH /api/transactions/[id] (verificación de mitigación)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('prova H1 eliminado: el unlink y la creación del JE son atómicos — si falla la creación, el journalEntryId original permanece intacto', async () => {
    const user = await createTestUser('h1-rollback@example.com');
    const company = await createTestCompany('H1 Rollback Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Bank Account' });
    const counterpartyGl = await createTestGlAccount({ companyId: company.id, code: '2000', name: 'Counterparty' });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Test transaction',
    });

    const oldJournalEntry = await createTestJournalEntry(company.id, {
      date: '2025-03-15',
      description: 'Old entry',
      lines: [
        { glAccountId: glAccount.id, debit: 500, credit: 0 },
        { glAccountId: counterpartyGl.id, debit: 0, credit: 500 },
      ],
    });

    await db.bankTransaction.update({
      where: { id: tx.id },
      data: { journalEntryId: oldJournalEntry.id, glAccountId: counterpartyGl.id },
    });

    const spy = vi.spyOn(JournalEntryServiceModule.JournalEntryService, 'createFromBankTransaction')
      .mockRejectedValueOnce(new Error('Simulated failure inside $transaction'));

    const req = new NextRequest(`http://localhost/api/transactions/${tx.id}?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ glAccountId: counterpartyGl.id }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(500);

    const reloadedTx = await db.bankTransaction.findUnique({
      where: { id: tx.id },
      select: { journalEntryId: true, glAccountId: true },
    });

    expect(reloadedTx?.journalEntryId).toBe(oldJournalEntry.id);
    expect(reloadedTx?.glAccountId).toBe(counterpartyGl.id);

    const oldJe = await db.journalEntry.findUnique({
      where: { id: oldJournalEntry.id },
    });
    expect(oldJe).not.toBeNull();

    spy.mockRestore();
  });

  it('prova H1 eliminado: con JE previo, el unlink ocurre dentro del $transaction y el resultado es correcto', async () => {
    const user = await createTestUser('h1-mitigated@example.com');
    const company = await createTestCompany('H1 Mitigated Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Bank Account 2' });
    const counterpartyGl = await createTestGlAccount({ companyId: company.id, code: '2010', name: 'Counterparty 2' });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Test transaction',
    });

    const oldJournalEntry = await createTestJournalEntry(company.id, {
      date: '2025-03-15',
      description: 'Old entry',
      lines: [
        { glAccountId: glAccount.id, debit: 500, credit: 0 },
        { glAccountId: counterpartyGl.id, debit: 0, credit: 500 },
      ],
    });

    await db.bankTransaction.update({
      where: { id: tx.id },
      data: { journalEntryId: oldJournalEntry.id, glAccountId: counterpartyGl.id },
    });

    const req = new NextRequest(`http://localhost/api/transactions/${tx.id}?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ glAccountId: counterpartyGl.id }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(200);

    const updatedTx = await db.bankTransaction.findUnique({
      where: { id: tx.id },
      select: { journalEntryId: true, glAccountId: true },
    });

    expect(updatedTx?.glAccountId).toBe(counterpartyGl.id);
    expect(updatedTx?.journalEntryId).not.toBeNull();
    expect(updatedTx?.journalEntryId).not.toBe(oldJournalEntry.id);

    const oldJe = await db.journalEntry.findUnique({
      where: { id: oldJournalEntry.id },
    });
    expect(oldJe).not.toBeNull();
  });

  it('prova H1 eliminado: sin JE previo no hay unlink y se crea uno nuevo', async () => {
    const user = await createTestUser('h1-no-je@example.com');
    const company = await createTestCompany('H1 NoJE Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1011', name: 'Bank Account 3' });
    const counterpartyGl = await createTestGlAccount({ companyId: company.id, code: '2011', name: 'Counterparty 3' });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-16',
      amount: 250.0,
      description: 'No JE yet',
    });

    const req = new NextRequest(`http://localhost/api/transactions/${tx.id}?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ glAccountId: counterpartyGl.id }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.transaction.glAccountId).toBe(counterpartyGl.id);
    expect(body.transaction.journalEntryId).not.toBeNull();
  });

  it('prova H1 eliminado: el contrato HTTP de respuesta se mantiene', async () => {
    const user = await createTestUser('h1-contract@example.com');
    const company = await createTestCompany('H1 Contract Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1012', name: 'Bank Account 4' });
    const counterpartyGl = await createTestGlAccount({ companyId: company.id, code: '2012', name: 'Counterparty 4' });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-17',
      amount: 100.0,
      description: 'Contract test',
    });

    const req = new NextRequest(`http://localhost/api/transactions/${tx.id}?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ glAccountId: counterpartyGl.id }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('transaction');
    expect(body.transaction).toHaveProperty('id');
    expect(body.transaction).toHaveProperty('date');
    expect(body.transaction).toHaveProperty('amount');
    expect(body.transaction).toHaveProperty('description');
    expect(body.transaction).toHaveProperty('glAccountId');
    expect(body.transaction).toHaveProperty('journalEntryId');
  });
});

describe('H1 — PATCH /api/transactions/[id] (caracterización de validaciones)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('glAccountId requerido devuelve 400', async () => {
    const user = await createTestUser('h1-400@example.com');
    const company = await createTestCompany('H1 400 Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1020', name: 'Bank Account 5' });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-18',
      amount: 75.0,
      description: 'Missing glAccountId',
    });

    const req = new NextRequest(`http://localhost/api/transactions/${tx.id}?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('glAccountId is required');
  });

  it('transacción inexistente devuelve 404', async () => {
    const user = await createTestUser('h1-404@example.com');
    const company = await createTestCompany('H1 404 Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/transactions/nonexistent?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ glAccountId: 'some-id' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });

  it('glAccount inactivo devuelve 404', async () => {
    const user = await createTestUser('h1-inactive@example.com');
    const company = await createTestCompany('H1 Inactive Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '1021', name: 'Bank Account 6' });
    const inactiveGl = await db.glAccount.create({
      data: { companyId: company.id, code: '9998', name: 'Inactive GL', accountType: 'liability', normalBalance: 'credit', isActive: false },
    });
    const bankAccount = await createTestBankAccount(company.id, glAccount.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-19',
      amount: 50.0,
      description: 'Inactive GL test',
    });

    const req = new NextRequest(`http://localhost/api/transactions/${tx.id}?companyId=${company.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ glAccountId: inactiveGl.id }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(404);
  });
});
