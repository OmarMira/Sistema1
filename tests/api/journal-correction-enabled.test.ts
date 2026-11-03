import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { verifyJournalChain } from '@/lib/journal-hash';
import { POST as journalPOST } from '../../src/app/api/journal/[id]/route';
import { POST as correctionPOST } from '../../src/app/api/journal/[id]/corregir/route';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
} from '../helpers/factories';

/**
 * S24 — JournalCorrection disposition: the correction flow is ENABLED for
 * company_admin. The original posting is preserved, a real counter-entry
 * reverses it, a replacement entry carries the corrected figures, both new
 * entries are sealed into the per-company journal hash chain, balances are
 * recalculated, and the link record is protected by CORRECTION_DUPLICATE.
 *
 * The route must refuse: non company_admin roles, cross-tenant entry ids,
 * non-posted (draft/void) entries, bank-linked entries (the bank flows own the
 * link), unbalanced or foreign GL lines, and correction dates in closed
 * fiscal periods.
 */

type Seeded = Awaited<ReturnType<typeof seedCompany>>;

async function seedCompany(email: string, role: 'company_admin' | 'employee' | 'viewer' = 'company_admin') {
  const user = await createTestUser(email);
  const company = await createTestCompany(`S24 ${email}`);
  await db.companyMember.create({
    data: { userId: user.id, companyId: company.id, role },
  });
  const token = await createSession(user.id);
  // A second company_admin posts the fixtures for every role, so a viewer or
  // employee test can still start from a legitimately posted entry.
  const admin = await createTestUser(`admin-${email}`);
  await db.companyMember.create({
    data: { userId: admin.id, companyId: company.id, role: 'company_admin' },
  });
  const adminToken = await createSession(admin.id);
  const cash = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const equity = await createTestGlAccount({
    companyId: company.id,
    code: '3000',
    name: 'Equity',
    accountType: 'equity',
    normalBalance: 'credit',
  });
  return { user, admin, company, token, adminToken, cash, equity };
}

function correct(
  entryId: string,
  companyId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return correctionPOST(
    new NextRequest(`http://localhost/api/journal/${entryId}/corregir?companyId=${companyId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: entryId }) },
  );
}

async function createDraft(seed: Seeded, amount = 1000) {
  return db.journalEntry.create({
    data: {
      companyId: seed.company.id,
      date: new Date('2025-06-15'),
      description: 'Venta original',
      reference: 'INV-1',
      status: 'draft',
      lines: {
        create: [
          { glAccountId: seed.cash.id, debit: amount, credit: 0, description: 'Caja' },
          { glAccountId: seed.equity.id, debit: 0, credit: amount, description: 'Ingreso' },
        ],
      },
    },
  });
}

async function createPosted(seed: Seeded, amount = 1000) {
  const draft = await createDraft(seed, amount);
  const res = await journalPOST(
    new NextRequest(
      `http://localhost/api/journal/${draft.id}?companyId=${seed.company.id}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${seed.adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'post' }),
      },
    ),
    { params: Promise.resolve({ id: draft.id }) },
  );
  expect(res.status).toBe(200);
  // Re-read the sealed row: the draft object predates the chain append.
  return db.journalEntry.findUniqueOrThrow({ where: { id: draft.id } });
}

function balanced(seed: Seeded, amount: number) {
  return [
    { glAccountId: seed.cash.id, debit: amount, credit: 0, description: 'Caja corregida' },
    { glAccountId: seed.equity.id, debit: 0, credit: amount, description: 'Ingreso corregido' },
  ];
}

describe('S24 — POST /api/journal/[id]/corregir (enabled, company_admin)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('applies counter + replacement entries, seals the chain and recalculates balances', async () => {
    const seed = await seedCompany('s24-happy@example.com');
    const original = await createPosted(seed, 1000);

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Importe incorrecto',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.originalEntryId).toBe(original.id);
    expect(body.counterEntryId).toBeTruthy();
    expect(body.replacementEntryId).toBeTruthy();
    expect(body.correctionId).toBeTruthy();
    expect(body.counterEntryId).not.toBe(body.replacementEntryId);

    // 1) Counter-entry really reverses the original lines.
    const counter = await db.journalEntry.findUniqueOrThrow({
      where: { id: body.counterEntryId },
      include: { lines: true },
    });
    expect(counter.status).toBe('posted');
    expect(counter.companyId).toBe(seed.company.id);
    const counterCash = counter.lines.find((l) => l.glAccountId === seed.cash.id);
    const counterEquity = counter.lines.find((l) => l.glAccountId === seed.equity.id);
    expect(Number(counterCash?.debit)).toBe(0);
    expect(Number(counterCash?.credit)).toBe(1000);
    expect(Number(counterEquity?.debit)).toBe(1000);
    expect(Number(counterEquity?.credit)).toBe(0);

    // 2) Replacement entry carries the corrected figures.
    const replacement = await db.journalEntry.findUniqueOrThrow({
      where: { id: body.replacementEntryId },
      include: { lines: true },
    });
    expect(replacement.status).toBe('posted');
    const replacementCash = replacement.lines.find((l) => l.glAccountId === seed.cash.id);
    expect(Number(replacementCash?.debit)).toBe(800);

    // 3) Both new entries are sealed members of the company chain.
    expect(counter.hash).toBeTruthy();
    expect(counter.hashVersion).toBe('v2');
    expect(replacement.hash).toBeTruthy();
    expect(replacement.hashVersion).toBe('v2');
    expect(counter.previousHash).toBe(original.hash);

    const chain = await verifyJournalChain(seed.company.id);
    expect(chain.reasonCode).toBeUndefined();
    expect(chain.firstBreak).toBeNull();
    expect(chain.valid).toBe(true);
    expect(chain.totalChecked).toBe(3);
    expect(chain.v2Members).toBe(3);
    expect(chain.headConsistent).toBe(true);

    // 4) The original posting stays exactly as it was (never edited/deleted).
    const untouched = await db.journalEntry.findUniqueOrThrow({
      where: { id: original.id },
      include: { lines: true },
    });
    expect(untouched.status).toBe('posted');
    expect(untouched.hash).toBe(original.hash);
    expect(untouched.lines).toHaveLength(2);
    expect(Number(untouched.lines.find((l) => l.glAccountId === seed.cash.id)?.debit)).toBe(1000);

    // 5) Link record with the audit reason and the acting admin.
    const link = await db.journalCorrection.findUniqueOrThrow({
      where: {
        companyId_originalEntryId: {
          companyId: seed.company.id,
          originalEntryId: original.id,
        },
      },
    });
    expect(link.counterEntryId).toBe(body.counterEntryId);
    expect(link.replacementEntryId).toBe(body.replacementEntryId);
    expect(link.reason).toBe('Importe incorrecto');
    expect(link.correctedByUserId).toBe(seed.user.id);

    // 6) Balances reflect original + counter + replacement = corrected amount.
    const cashAfter = await db.glAccount.findUniqueOrThrow({ where: { id: seed.cash.id } });
    const equityAfter = await db.glAccount.findUniqueOrThrow({ where: { id: seed.equity.id } });
    expect(Number(cashAfter.balance)).toBe(800);
    expect(Number(equityAfter.balance)).toBe(800);

    // 7) The correction is audited inside the same transaction.
    const audit = await db.auditLog.findFirst({
      where: { companyId: seed.company.id, action: 'correction', entityId: original.id },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses a second correction of the same entry with CORRECTION_DUPLICATE', async () => {
    const seed = await seedCompany('s24-duplicate@example.com');
    const original = await createPosted(seed, 1000);

    const first = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Primera corrección',
      correctedLines: balanced(seed, 800),
    });
    expect(first.status).toBe(200);

    const second = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-21',
      reason: 'Segunda corrección',
      correctedLines: balanced(seed, 700),
    });

    expect(second.status).toBe(409);
    const body = await second.json();
    expect(String(body.error)).toContain('CORRECTION_DUPLICATE');

    // Nothing was written by the refused attempt.
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(1);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(3);
    const cashAfter = await db.glAccount.findUniqueOrThrow({ where: { id: seed.cash.id } });
    expect(Number(cashAfter.balance)).toBe(800);
    expect((await verifyJournalChain(seed.company.id)).valid).toBe(true);
  });

  it.each(['viewer', 'employee'] as const)('refuses %s with 403 and writes nothing', async (role) => {
    const seed = await seedCompany(`s24-${role}@example.com`, role);
    const original = await createPosted(seed, 1000);

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'No autorizado',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(403);
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
    const cashAfter = await db.glAccount.findUniqueOrThrow({ where: { id: seed.cash.id } });
    expect(Number(cashAfter.balance)).toBe(1000);
  });

  it('refuses a cross-tenant entry id belonging to another company', async () => {
    const victim = await seedCompany('s24-victim@example.com');
    const attacker = await seedCompany('s24-attacker@example.com');
    const victimEntry = await createPosted(victim, 1000);

    const res = await correct(victimEntry.id, attacker.company.id, attacker.token, {
      correctionDate: '2025-06-20',
      reason: 'Cross tenant',
      correctedLines: balanced(attacker, 800),
    });

    expect(res.status).toBe(403);
    expect(await db.journalCorrection.count({ where: { companyId: victim.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: victim.company.id } })).toBe(1);
    const victimCash = await db.glAccount.findUniqueOrThrow({ where: { id: victim.cash.id } });
    expect(Number(victimCash.balance)).toBe(1000);
  });

  it('refuses to correct a void entry', async () => {
    const seed = await seedCompany('s24-void@example.com');
    const original = await createPosted(seed, 1000);

    const voidRes = await journalPOST(
      new NextRequest(`http://localhost/api/journal/${original.id}?companyId=${seed.company.id}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${seed.adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'void' }),
      }),
      { params: Promise.resolve({ id: original.id }) },
    );
    expect(voidRes.status).toBe(200);

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Asiento anulado',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('Only posted entries can be corrected');
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
  });

  it('refuses to correct a draft entry', async () => {
    const seed = await seedCompany('s24-draft@example.com');
    const draft = await createDraft(seed, 1000);

    const res = await correct(draft.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Borrador',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('Only posted entries can be corrected');
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
  });

  it('refuses a bank-linked entry (the bank flows own that link)', async () => {
    const seed = await seedCompany('s24-bank-linked@example.com');
    const original = await createPosted(seed, 1000);
    const bankAccount = await createTestBankAccount(seed.company.id, seed.cash.id);
    const statement = await createTestBankStatement(seed.company.id, bankAccount.id);
    await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-06-15'),
        amount: 1000,
        description: 'Cobro vinculado',
        isReconciled: false,
        journalEntryId: original.id,
      },
    });

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Asiento bancario',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(400);
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
  });

  it('refuses an unbalanced replacement (exact cents, no tolerance)', async () => {
    const seed = await seedCompany('s24-unbalanced@example.com');
    const original = await createPosted(seed, 1000);

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Desbalanceado',
      correctedLines: [
        { glAccountId: seed.cash.id, debit: 800, credit: 0 },
        { glAccountId: seed.equity.id, debit: 0, credit: 799.99 },
      ],
    });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('balance');
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
    const cashAfter = await db.glAccount.findUniqueOrThrow({ where: { id: seed.cash.id } });
    expect(Number(cashAfter.balance)).toBe(1000);
  });

  it('refuses corrected lines pointing at another company GL account', async () => {
    const victim = await seedCompany('s24-glvictim@example.com');
    const attacker = await seedCompany('s24-glattacker@example.com');
    const original = await createPosted(victim, 1000);

    const res = await correct(original.id, victim.company.id, victim.token, {
      correctionDate: '2025-06-20',
      reason: 'Cuenta ajena',
      correctedLines: [
        { glAccountId: attacker.cash.id, debit: 800, credit: 0 },
        { glAccountId: victim.equity.id, debit: 0, credit: 800 },
      ],
    });

    expect(res.status).toBe(400);
    expect(await db.journalCorrection.count({ where: { companyId: victim.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: victim.company.id } })).toBe(1);
    const attackerCash = await db.glAccount.findUniqueOrThrow({ where: { id: attacker.cash.id } });
    expect(Number(attackerCash.balance)).toBe(0);
  });

  it('refuses negative line amounts', async () => {
    const seed = await seedCompany('s24-negative@example.com');
    const original = await createPosted(seed, 1000);

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Negativo',
      correctedLines: [
        { glAccountId: seed.cash.id, debit: -800, credit: 0 },
        { glAccountId: seed.equity.id, debit: 0, credit: -800 },
      ],
    });

    expect(res.status).toBe(400);
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
  });

  it('refuses a correction date inside a locked fiscal period', async () => {
    const seed = await seedCompany('s24-locked@example.com');
    const original = await createPosted(seed, 1000);
    await db.fiscalPeriod.create({
      data: {
        companyId: seed.company.id,
        name: 'Mayo 2025',
        startDate: new Date('2025-05-01T00:00:00.000Z'),
        endDate: new Date('2025-05-31T00:00:00.000Z'),
        isLocked: true,
      },
    });

    const res = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-05-20',
      reason: 'Período cerrado',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(403);
    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
  });

  it('keeps the required-field contract for the request body', async () => {
    const seed = await seedCompany('s24-validation@example.com');
    const original = await createPosted(seed, 1000);

    const missingDate = await correct(original.id, seed.company.id, seed.token, {
      reason: 'Sin fecha',
      correctedLines: balanced(seed, 800),
    });
    expect(missingDate.status).toBe(400);
    expect(String((await missingDate.json()).error)).toContain('correctionDate');

    const badDate = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: 'not-a-date',
      reason: 'Fecha inválida',
      correctedLines: balanced(seed, 800),
    });
    expect(badDate.status).toBe(400);
    expect(String((await badDate.json()).error)).toContain('correctionDate');

    const missingReason = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      correctedLines: balanced(seed, 800),
    });
    expect(missingReason.status).toBe(400);
    expect(String((await missingReason.json()).error)).toContain('reason');

    const shortLines = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Una sola línea',
      correctedLines: [{ glAccountId: seed.cash.id, debit: 800, credit: 0 }],
    });
    expect(shortLines.status).toBe(400);
    expect(String((await shortLines.json()).error)).toContain('At least 2 corrected journal lines');

    const missingAccount = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Sin cuenta',
      correctedLines: [{ debit: 800, credit: 0 }, { glAccountId: seed.equity.id, debit: 0, credit: 800 }],
    });
    expect(missingAccount.status).toBe(400);
    expect(String((await missingAccount.json()).error)).toContain('glAccountId');

    const nonNumeric = await correct(original.id, seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'No numérico',
      correctedLines: [
        { glAccountId: seed.cash.id, debit: '800', credit: 0 },
        { glAccountId: seed.equity.id, debit: 0, credit: 800 },
      ],
    });
    expect(nonNumeric.status).toBe(400);

    expect(await db.journalCorrection.count({ where: { companyId: seed.company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(1);
  });

  it('answers 404 for an unknown entry id', async () => {
    const seed = await seedCompany('s24-missing@example.com');

    const res = await correct('entry-that-does-not-exist', seed.company.id, seed.token, {
      correctionDate: '2025-06-20',
      reason: 'Inexistente',
      correctedLines: balanced(seed, 800),
    });

    expect(res.status).toBe(404);
  });
});
