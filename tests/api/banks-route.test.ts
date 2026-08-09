import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '../../src/app/api/banks/route';
import { PUT } from '../../src/app/api/banks/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

async function openingAccountingEffect(companyId: string, glAccountId: string) {
  const lines = await db.journalLine.findMany({
    where: {
      glAccountId,
      entry: { companyId, status: 'posted', transactions: { none: {} } },
    },
  });
  return lines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0);
}

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

describe('H9b — PUT /api/banks/[id] (editar saldo inicial y sincronización GL)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  async function seedCompany() {
    const user = await createTestUser('h9b-banks@example.com');
    const company = await createTestCompany('H9b Banks Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);
    const cashGl = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    return { user, company, token, cashGl };
  }

  it('rechaza cambiar el saldo inicial si ya existe contabilización de apertura (409, sin desync)', async () => {
    const { company, token, cashGl } = await seedCompany();

    const created = await POST(
      new NextRequest(`http://localhost/api/banks?companyId=${company.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountName: 'Checking',
          bankName: 'Test Bank',
          glAccountId: cashGl.id,
          balance: 500,
        }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(created.status).toBe(201);
    const bankAccount = await db.bankAccount.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(bankAccount).toBeTruthy();
    expect(await openingAccountingEffect(company.id, cashGl.id)).toBe(500);

    const jeCountBefore = await db.journalEntry.count({ where: { companyId: company.id } });

    const res = await PUT(
      new NextRequest(`http://localhost/api/banks/${bankAccount!.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: 1000 }),
      }),
      { params: Promise.resolve({ id: bankAccount!.id }) },
    );

    expect(res.status).toBe(409);

    const after = await db.bankAccount.findUnique({ where: { id: bankAccount!.id } });
    expect(Number(after!.initialBalance)).toBe(500);
    expect(Number(after!.balance)).toBe(500);
    expect(await openingAccountingEffect(company.id, cashGl.id)).toBe(500);
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(jeCountBefore);
  });

  it('crea el JE de apertura al fijar un saldo inicial sin contabilización previa', async () => {
    const { company, token, cashGl } = await seedCompany();

    await POST(
      new NextRequest(`http://localhost/api/banks?companyId=${company.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountName: 'Checking',
          bankName: 'Test Bank',
          glAccountId: cashGl.id,
          balance: 0,
        }),
      }),
      { params: Promise.resolve({}) },
    );
    const bankAccount = await db.bankAccount.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(await openingAccountingEffect(company.id, cashGl.id)).toBe(0);

    const res = await PUT(
      new NextRequest(`http://localhost/api/banks/${bankAccount!.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: 1000 }),
      }),
      { params: Promise.resolve({ id: bankAccount!.id }) },
    );

    expect(res.status).toBe(200);
    const after = await db.bankAccount.findUnique({ where: { id: bankAccount!.id } });
    expect(Number(after!.initialBalance)).toBe(1000);
    expect(Number(after!.balance)).toBe(1000);
    expect(await openingAccountingEffect(company.id, cashGl.id)).toBe(1000);
  });

  it('bloquea por período fiscal cerrado al crear el JE de apertura desde PUT', async () => {
    const { company, token, cashGl } = await seedCompany();

    await POST(
      new NextRequest(`http://localhost/api/banks?companyId=${company.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountName: 'Checking',
          bankName: 'Test Bank',
          glAccountId: cashGl.id,
          balance: 0,
        }),
      }),
      { params: Promise.resolve({}) },
    );
    const bankAccount = await db.bankAccount.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'Today (locked)',
        startDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)),
        endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)),
        isLocked: true,
      },
    });

    const res = await PUT(
      new NextRequest(`http://localhost/api/banks/${bankAccount!.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: 1000 }),
      }),
      { params: Promise.resolve({ id: bankAccount!.id }) },
    );

    expect(res.status).toBe(403);
    const after = await db.bankAccount.findUnique({ where: { id: bankAccount!.id } });
    expect(Number(after!.initialBalance)).toBe(0);
    expect(await openingAccountingEffect(company.id, cashGl.id)).toBe(0);
  });

  it('permite editar otros campos sin bloquear si el saldo inicial no cambia', async () => {
    const { company, token, cashGl } = await seedCompany();

    await POST(
      new NextRequest(`http://localhost/api/banks?companyId=${company.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountName: 'Checking',
          bankName: 'Test Bank',
          glAccountId: cashGl.id,
          balance: 500,
        }),
      }),
      { params: Promise.resolve({}) },
    );
    const bankAccount = await db.bankAccount.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });

    const res = await PUT(
      new NextRequest(`http://localhost/api/banks/${bankAccount!.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountName: 'Renamed', balance: 500 }),
      }),
      { params: Promise.resolve({ id: bankAccount!.id }) },
    );

    expect(res.status).toBe(200);
    const after = await db.bankAccount.findUnique({ where: { id: bankAccount!.id } });
    expect(after!.accountName).toBe('Renamed');
    expect(Number(after!.initialBalance)).toBe(500);
    expect(await openingAccountingEffect(company.id, cashGl.id)).toBe(500);
  });
});