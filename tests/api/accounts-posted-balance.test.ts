import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from '../../src/app/api/accounts/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

// S8 — La agregación de saldos de /api/accounts debe contar SOLO asientos
// `posted`, igual que JournalEntryService.recalculateBalance. Las líneas de
// asientos `draft` y `void` no deben mover el saldo reportado.

async function setEntryStatus(entryId: string, status: 'draft' | 'posted' | 'void') {
  await db.journalEntry.update({ where: { id: entryId }, data: { status } });
}

async function listAccounts(companyId: string, token: string) {
  const res = await GET(
    new NextRequest(`http://localhost/api/accounts?companyId=${companyId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    accounts: {
      id: string;
      code: string;
      directBalance: number;
      balance: number;
      _count: { children: number; journalLines: number };
    }[];
  }>;
}

describe('S8 — GET /api/accounts: saldos solo de asientos posted', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('excluye del saldo las líneas de asientos draft y void (posted-only)', async () => {
    const user = await createTestUser('s8-posted-balance@example.com');
    const company = await createTestCompany('S8 Posted Balance Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glDebit = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Caja',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const glCredit = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Ingresos',
      accountType: 'revenue',
      normalBalance: 'credit',
    });

    // POSTED +500 / -500
    await createTestJournalEntry(company.id, {
      date: '2025-06-01',
      description: 'Asiento confirmado',
      lines: [
        { glAccountId: glDebit.id, debit: 500, credit: 0 },
        { glAccountId: glCredit.id, debit: 0, credit: 500 },
      ],
    });

    // DRAFT +1000 / -1000
    const draftEntry = await createTestJournalEntry(company.id, {
      date: '2025-06-02',
      description: 'Borrador que no debe contar',
      lines: [
        { glAccountId: glDebit.id, debit: 1000, credit: 0 },
        { glAccountId: glCredit.id, debit: 0, credit: 1000 },
      ],
    });
    await setEntryStatus(draftEntry.id, 'draft');

    // VOID +200 / -200
    const voidEntry = await createTestJournalEntry(company.id, {
      date: '2025-06-03',
      description: 'Anulado que no debe contar',
      lines: [
        { glAccountId: glDebit.id, debit: 200, credit: 0 },
        { glAccountId: glCredit.id, debit: 0, credit: 200 },
      ],
    });
    await setEntryStatus(voidEntry.id, 'void');

    const body = await listAccounts(company.id, token);

    const debitAccount = body.accounts.find((a) => a.id === glDebit.id);
    expect(debitAccount).toBeDefined();
    // 500 (posted) — y NO 1700 (posted + draft + void)
    expect(debitAccount!.balance).toBe(500);
    expect(debitAccount!.directBalance).toBe(500);

    const creditAccount = body.accounts.find((a) => a.id === glCredit.id);
    expect(creditAccount).toBeDefined();
    expect(creditAccount!.balance).toBe(500);
    expect(creditAccount!.directBalance).toBe(500);
  });

  it('PRESERVE: _count.journalLines sigue contando TODAS las líneas (sin filtrar)', async () => {
    const user = await createTestUser('s8-count@example.com');
    const company = await createTestCompany('S8 Count Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAccount = await createTestGlAccount({
      companyId: company.id,
      code: '1200',
      name: 'Banco',
      accountType: 'asset',
      normalBalance: 'debit',
    });

    await createTestJournalEntry(company.id, {
      date: '2025-06-01',
      description: 'Posted',
      lines: [
        { glAccountId: glAccount.id, debit: 10, credit: 0 },
        { glAccountId: glAccount.id, debit: 0, credit: 10, description: 'offset' },
      ],
    });
    const draftEntry = await createTestJournalEntry(company.id, {
      date: '2025-06-02',
      description: 'Draft',
      lines: [
        { glAccountId: glAccount.id, debit: 30, credit: 0 },
        { glAccountId: glAccount.id, debit: 0, credit: 30, description: 'offset' },
      ],
    });
    await setEntryStatus(draftEntry.id, 'draft');

    const body = await listAccounts(company.id, token);
    const account = body.accounts.find((a) => a.id === glAccount.id);
    expect(account).toBeDefined();
    // El saldo es posted-only...
    expect(account!.balance).toBe(0);
    // ...pero el conteo de líneas no se filtra (4 líneas en total).
    expect(account!._count.journalLines).toBe(4);
  });

  it('el saldo acumulado del padre ignora las líneas draft de sus hijos', async () => {
    const user = await createTestUser('s8-hierarchy@example.com');
    const company = await createTestCompany('S8 Hierarchy Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const parent = await createTestGlAccount({
      companyId: company.id,
      code: '1300',
      name: 'Activo corriente',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const child = await createTestGlAccount({
      companyId: company.id,
      code: '1301',
      name: 'Activo corriente detalle',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    await db.glAccount.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const counter = await createTestGlAccount({
      companyId: company.id,
      code: '4300',
      name: 'Aportes',
      accountType: 'revenue',
      normalBalance: 'credit',
    });

    // Hijo: posted 40 (cuenta), draft 400 (no cuenta)
    await createTestJournalEntry(company.id, {
      date: '2025-06-01',
      description: 'Posted en hijo',
      lines: [
        { glAccountId: child.id, debit: 40, credit: 0 },
        { glAccountId: counter.id, debit: 0, credit: 40 },
      ],
    });
    const draftEntry = await createTestJournalEntry(company.id, {
      date: '2025-06-02',
      description: 'Draft en hijo',
      lines: [
        { glAccountId: child.id, debit: 400, credit: 0 },
        { glAccountId: counter.id, debit: 0, credit: 400 },
      ],
    });
    await setEntryStatus(draftEntry.id, 'draft');

    const body = await listAccounts(company.id, token);
    const parentAccount = body.accounts.find((a) => a.id === parent.id);
    expect(parentAccount).toBeDefined();
    expect(parentAccount!.directBalance).toBe(0);
    expect(parentAccount!.balance).toBe(40);
  });
});
