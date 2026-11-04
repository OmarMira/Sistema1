import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PUT } from '../../src/app/api/journal/[id]/route';
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

// S7 — La actualización de borradores (PUT /api/journal/[id]) debe exigir
// debits === credits en centavos exactos, sin la tolerancia de ±0.005 que
// permitía guardar un asiento desbalanceado en 0.004 y que Postgres redondeara
// a Decimal(18,2) dejando un asiento posteado descuadrado.

async function createDraftEntry(companyId: string, debitGl: string, creditGl: string) {
  return db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2025-06-15'),
      description: 'Borrador balanceado',
      status: 'draft',
      lines: {
        create: [
          { glAccountId: debitGl, debit: 100, credit: 0 },
          { glAccountId: creditGl, debit: 0, credit: 100 },
        ],
      },
    },
  });
}

function putLines(
  entryId: string,
  companyId: string,
  token: string,
  lines: { glAccountId: string; debit: number; credit: number }[],
) {
  return PUT(
    new NextRequest(`http://localhost/api/journal/${entryId}?companyId=${companyId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lines }),
    }),
    { params: Promise.resolve({ id: entryId }) },
  );
}

describe('S7 — PUT /api/journal/[id]: balance exacto en centavos', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it.each([
    ['0.004 (dentro de la vieja tolerancia ±0.005)', 100.002, 100.006],
    ['0.01 (desbalance real)', 100.0, 100.01],
  ])('rechaza con 400 un asiento desbalanceado en %s', async (_label, debit, credit) => {
    const user = await createTestUser('s7-exact@example.com');
    const company = await createTestCompany('S7 Exact Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAsset = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Caja',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const glEquity = await createTestGlAccount({
      companyId: company.id,
      code: '3100',
      name: 'Capital',
      accountType: 'equity',
      normalBalance: 'credit',
    });
    const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

    const res = await putLines(entry.id, company.id, token, [
      { glAccountId: glAsset.id, debit, credit: 0 },
      { glAccountId: glEquity.id, debit: 0, credit },
    ]);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('must balance');

    // El asiento rechazado no se modifica: siguen las 2 líneas originales
    const lines = await db.journalLine.findMany({ where: { entryId: entry.id } });
    expect(lines).toHaveLength(2);
    const totalDebits = lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredits = lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(totalDebits).toBe(100);
    expect(totalCredits).toBe(100);
  });

  it('PRESERVE: acepta con 200 un asiento exactamente balanceado', async () => {
    const user = await createTestUser('s7-balanced@example.com');
    const company = await createTestCompany('S7 Balanced Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAsset = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Caja',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const glEquity = await createTestGlAccount({
      companyId: company.id,
      code: '3100',
      name: 'Capital',
      accountType: 'equity',
      normalBalance: 'credit',
    });
    const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

    const res = await putLines(entry.id, company.id, token, [
      { glAccountId: glAsset.id, debit: 250.5, credit: 0 },
      { glAccountId: glEquity.id, debit: 0, credit: 250.5 },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(entry.id);
    expect(body.status).toBe('draft');

    const lines = await db.journalLine.findMany({ where: { entryId: entry.id } });
    expect(lines).toHaveLength(2);
    expect(lines.reduce((sum, l) => sum + Number(l.debit), 0)).toBe(250.5);
  });

  it('PRESERVE: acepta con 200 un asiento balanceado con artefactos de coma flotante', async () => {
    const user = await createTestUser('s7-float@example.com');
    const company = await createTestCompany('S7 Float Co');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const glAsset = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Caja',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const glEquity = await createTestGlAccount({
      companyId: company.id,
      code: '3100',
      name: 'Capital',
      accountType: 'equity',
      normalBalance: 'credit',
    });
    const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

    // 33.33 + 33.33 + 33.34 = 99.99999999999999 en IEEE-754
    const res = await putLines(entry.id, company.id, token, [
      { glAccountId: glAsset.id, debit: 33.33, credit: 0 },
      { glAccountId: glAsset.id, debit: 33.33, credit: 0 },
      { glAccountId: glAsset.id, debit: 33.34, credit: 0 },
      { glAccountId: glEquity.id, debit: 0, credit: 100 },
    ]);

    expect(res.status).toBe(200);
    const lines = await db.journalLine.findMany({ where: { entryId: entry.id } });
    expect(lines).toHaveLength(4);
  });
});
