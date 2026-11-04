import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/banks/route';
import { GET, PUT } from '../../src/app/api/banks/[id]/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { db } from '@/lib/db';

// S17a — La agregación de saldo de apertura de /api/banks/[id] (PUT con
// `balance`) debe contar SOLO asientos `posted`, igual que la agregación de
// /api/accounts (S8, commit 999be49). Las líneas `draft` y `void` del asiento
// contable de la cuenta bancaria no deben mover el saldo ni disparar el
// conflicto de saldo de apertura.

async function setEntryStatus(entryId: string, status: 'draft' | 'posted' | 'void') {
  await db.journalEntry.update({ where: { id: entryId }, data: { status } });
}

async function setupBankAccount(email: string, companyName: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(companyName);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1110',
    name: 'Banco',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const incomeGl = await createTestGlAccount({
    companyId: company.id,
    code: '4110',
    name: 'Ingresos',
    accountType: 'revenue',
    normalBalance: 'credit',
  });

  // Cuenta bancaria sin saldo inicial: no genera asiento de apertura, así que la
  // única contabilidad de la cuenta GL es la que cada test crea explícitamente.
  const createRes = await POST(
    new NextRequest(`http://localhost/api/banks?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountName: 'Cuenta Corriente',
        bankName: 'Banco Test',
        glAccountId: bankGl.id,
      }),
    }),
    { params: Promise.resolve({}) },
  );
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { account: { id: string; balance: number } };

  return { user, company, token, bankGl, incomeGl, account: created.account };
}

describe('S17a — PUT /api/banks/[id]: saldo de apertura solo desde asientos posted', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('ignora las líneas draft y void al comparar el saldo de apertura pedido', async () => {
    const { company, token, account, bankGl, incomeGl } = await setupBankAccount(
      's17a-posted-bank@example.com',
      'S17a Posted Bank Co',
    );

    // POSTED +500 / -500
    await createTestJournalEntry(company.id, {
      date: '2025-06-01',
      description: 'Cobro confirmado',
      lines: [
        { glAccountId: bankGl.id, debit: 500, credit: 0 },
        { glAccountId: incomeGl.id, debit: 0, credit: 500 },
      ],
    });

    // DRAFT +1000 / -1000 (no debe contar)
    const draftEntry = await createTestJournalEntry(company.id, {
      date: '2025-06-02',
      description: 'Borrador que no debe contar',
      lines: [
        { glAccountId: bankGl.id, debit: 1000, credit: 0 },
        { glAccountId: incomeGl.id, debit: 0, credit: 1000 },
      ],
    });
    await setEntryStatus(draftEntry.id, 'draft');

    // VOID +250 / -250 (no debe contar)
    const voidEntry = await createTestJournalEntry(company.id, {
      date: '2025-06-03',
      description: 'Anulado que no debe contar',
      lines: [
        { glAccountId: bankGl.id, debit: 250, credit: 0 },
        { glAccountId: incomeGl.id, debit: 0, credit: 250 },
      ],
    });
    await setEntryStatus(voidEntry.id, 'void');

    // El saldo pedido (500) coincide con la contabilidad POSTED (500).
    // Si la agregación contara draft/void el efecto sería 1750 y la ruta
    // respondería 409 por divergencia.
    const res = await PUT(
      new NextRequest(`http://localhost/api/banks/${account.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ balance: 500 }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { balance: number } };
    expect(Number(body.account.balance)).toBe(500);

    // La lectura detallada reporta el mismo saldo posted-only.
    const getRes = await GET(
      new NextRequest(`http://localhost/api/banks/${account.id}?companyId=${company.id}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { account: { balance: number } };
    expect(Number(getBody.account.balance)).toBe(500);
  });

  it('PRESERVE: un saldo divergente de la contabilidad posted sigue bloqueado con 409', async () => {
    const { company, token, account, bankGl, incomeGl } = await setupBankAccount(
      's17a-conflict-bank@example.com',
      'S17a Conflict Bank Co',
    );

    await createTestJournalEntry(company.id, {
      date: '2025-06-01',
      description: 'Cobro confirmado',
      lines: [
        { glAccountId: bankGl.id, debit: 500, credit: 0 },
        { glAccountId: incomeGl.id, debit: 0, credit: 500 },
      ],
    });

    const res = await PUT(
      new NextRequest(`http://localhost/api/banks/${account.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ balance: 400 }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('CONFLICT');
    expect(body.error).toBe(
      'Cannot change the opening balance: it would diverge from the posted opening journal entry. Delete and recreate the bank account to change its opening balance.',
    );

    // Rechazo sin efectos: el saldo guardado queda intacto.
    const stored = await db.bankAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(Number(stored.balance)).toBe(0);
  });
});
