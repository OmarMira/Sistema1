/**
 * Wave 6 — T2 (S4 + S7).
 *
 * S4 — POST /api/companies is a platform-level operation: creating a company
 *      also creates its membership, chart of accounts and module entitlements,
 *      so only a `super_admin` may do it. The single-user owner IS super_admin
 *      (no functional change for them); any other authenticated user gets
 *      403 FORBIDDEN and NOTHING is written (no company, no membership, no
 *      entitlements, no audit row).
 *
 * S7 — voiding a posted journal entry is no longer silent:
 *      (1) the action body REQUIRES `reason` (Zod: min 5, max 500 chars);
 *      (2) a chained `JOURNAL_VOIDED` audit row records the reason plus the
 *          entry description and its totals;
 *      (3) a missing/short/long reason answers 400 and leaves the entry posted;
 *      (4) the pre-existing refusals are preserved: bank-linked entries and
 *          non-posted entries are still refused with their historical messages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  clearDatabase,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestUser,
} from '../helpers/factories';
import { POST as companiesPOST } from '@/app/api/companies/route';
import { POST as journalPOST } from '@/app/api/journal/[id]/route';
import { translateApiError } from '@/i18n/errors';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';

/** Minimal dotted-key translator over a locale catalog (same shape as the store). */
function translatorFor(locale: unknown) {
  return (key: string): string => {
    const value = key
      .split('.')
      .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], locale);
    return typeof value === 'string' ? value : key;
  };
}

const REASON = 'Duplicate invoice captured twice';

function journalRequest(entryId: string, companyId: string, token: string, body: unknown) {
  return journalPOST(
    new NextRequest(`http://localhost/api/journal/${entryId}?companyId=${companyId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: entryId }) },
  );
}

function companiesRequest(token: string, body: Record<string, unknown>) {
  return companiesPOST(
    new NextRequest('http://localhost/api/companies', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

async function seedCompanyWithAdmin(email: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(`Wave6 ${email}`);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

async function seedPostedEntry(companyId: string, debitGlId: string, creditGlId: string) {
  return db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2025-06-15'),
      description: 'Posted entry pending void',
      status: 'posted',
      lines: {
        create: [
          { glAccountId: debitGlId, debit: 1200, credit: 0 },
          { glAccountId: creditGlId, debit: 0, credit: 1200 },
        ],
      },
    },
  });
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

// ═══════════════════════════════════════════════════════════════════
// S4 — companies creation gate
// ═══════════════════════════════════════════════════════════════════
describe('S4 — POST /api/companies requires a platform super_admin', () => {
  it('a verified non-super_admin member gets 403 FORBIDDEN and nothing is created', async () => {
    const user = await createTestUser('s4-regular@example.com');
    const token = await createSession(user.id);

    // Counters are read BEFORE the call: the fixture DB can still hold rows from
    // other suites, so the assertion is "nothing changed", not "nothing exists".
    const companiesBefore = await db.company.count();
    const membersBefore = await db.companyMember.count();
    const entitlementsBefore = await db.companyModuleEntitlement.count();
    const createCompanyAuditsBefore = await db.auditLog.count({ where: { action: 'create_company' } });

    const res = await companiesRequest(token, { legalName: 'Forbidden Co', taxId: '30-111111' });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');

    expect(await db.company.count({ where: { legalName: 'Forbidden Co' } })).toBe(0);
    expect(await db.company.count()).toBe(companiesBefore);
    expect(await db.companyMember.count()).toBe(membersBefore);
    expect(await db.companyMember.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.companyModuleEntitlement.count()).toBe(entitlementsBefore);
    expect(await db.auditLog.count({ where: { action: 'create_company' } })).toBe(createCompanyAuditsBefore);
  });

  it('a super_admin creates the company with membership, entitlements and audit row (201)', async () => {
    const user = await createTestUser('s4-owner@example.com');
    await db.user.update({ where: { id: user.id }, data: { platformRole: 'super_admin' } });
    const token = await createSession(user.id);

    const res = await companiesRequest(token, { legalName: 'Owner Co', taxId: '30-222222' });

    expect(res.status).toBe(201);
    const body = await res.json();
    const companyId = body.company.id as string;
    expect(body.company.legalName).toBe('Owner Co');

    const membership = await db.companyMember.findFirst({ where: { companyId, userId: user.id } });
    expect(membership?.role).toBe('company_admin');
    expect(await db.companyModuleEntitlement.count({ where: { companyId } })).toBe(5);
    expect(await db.glAccount.count({ where: { companyId } })).toBeGreaterThan(0);

    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'create_company', entity: 'Company', entityId: companyId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(user.id);
  });
});

// ═══════════════════════════════════════════════════════════════════
// S7 — void requires a reason and writes JOURNAL_VOIDED
// ═══════════════════════════════════════════════════════════════════
describe('S7 — POST /api/journal/[id] action=void requires a reason', () => {
  it('refuses a void with no reason (400) and keeps the entry posted with no audit row', async () => {
    const { company, token } = await seedCompanyWithAdmin('s7-noreason@example.com');
    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4000', name: 'Revenue', normalBalance: 'credit' });
    const entry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);

    const res = await journalRequest(entry.id, company.id, token, { action: 'void' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error).toLowerCase()).toContain('reason');
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.code).toBe('VOID_REASON_REQUIRED');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('posted');
    expect(await db.auditLog.count({ where: { entityId: entry.id } })).toBe(0);
  });

  it('refuses a reason shorter than 5 characters and one longer than 500 (400)', async () => {
    const { company, token } = await seedCompanyWithAdmin('s7-bounds@example.com');
    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1001', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4001', name: 'Revenue', normalBalance: 'credit' });
    const entry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);

    const short = await journalRequest(entry.id, company.id, token, { action: 'void', reason: 'oops' });
    expect(short.status).toBe(400);
    expect(String((await short.json()).error).toLowerCase()).toContain('reason');

    const long = await journalRequest(entry.id, company.id, token, {
      action: 'void',
      reason: 'x'.repeat(501),
    });
    expect(long.status).toBe(400);
    expect(String((await long.json()).error).toLowerCase()).toContain('reason');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('posted');
    expect(await db.auditLog.count({ where: { entityId: entry.id } })).toBe(0);
  });

  it('surfaces the reason rule through a localizable code (es/en), not a raw English string', async () => {
    const { company, token } = await seedCompanyWithAdmin('s7-i18n@example.com');
    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1007', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4007', name: 'Revenue', normalBalance: 'credit' });
    const entry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);

    const res = await journalRequest(entry.id, company.id, token, { action: 'void' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(translateApiError(body, translatorFor(es))).toBe(es.errors.VOID_REASON_REQUIRED);
    expect(translateApiError(body, translatorFor(en))).toBe(en.errors.VOID_REASON_REQUIRED);
    expect(es.errors.VOID_REASON_REQUIRED).not.toBe(en.errors.VOID_REASON_REQUIRED);
  });

  it('voids with a reason (200) and writes one JOURNAL_VOIDED audit row carrying the reason and totals', async () => {
    const { user, company, token } = await seedCompanyWithAdmin('s7-audit@example.com');
    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1002', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4002', name: 'Revenue', normalBalance: 'credit' });
    const entry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);

    const res = await journalRequest(entry.id, company.id, token, { action: 'void', reason: REASON });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('void');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('void');

    const audits = await db.auditLog.findMany({ where: { entityId: entry.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('JOURNAL_VOIDED');
    expect(audits[0].entity).toBe('journalEntry');
    expect(audits[0].companyId).toBe(company.id);
    expect(audits[0].userId).toBe(user.id);

    const details = JSON.parse(String(audits[0].details));
    expect(details.reason).toBe(REASON);
    expect(details.entryDescription).toBe('Posted entry pending void');
    expect(details.totalDebits).toBe(1200);
    expect(details.totalCredits).toBe(1200);
  });

  it('accepts the exact boundaries: a 5-character and a 500-character reason (200)', async () => {
    const { company, token } = await seedCompanyWithAdmin('s7-edgeok@example.com');
    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1003', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4003', name: 'Revenue', normalBalance: 'credit' });

    const minEntry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);
    const minRes = await journalRequest(minEntry.id, company.id, token, { action: 'void', reason: 'abcde' });
    expect(minRes.status).toBe(200);

    const maxEntry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);
    const maxRes = await journalRequest(maxEntry.id, company.id, token, {
      action: 'void',
      reason: 'y'.repeat(500),
    });
    expect(maxRes.status).toBe(200);
  });

  it('still refuses to void a bank-linked entry (400, bank message) and leaves it posted', async () => {
    const { company, token } = await seedCompanyWithAdmin('s7-bank@example.com');
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1004', name: 'Cash' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4004', name: 'Revenue', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 1200,
      description: 'CLIENT PAYMENT',
    });
    const entry = await seedPostedEntry(company.id, cashGl.id, revenueGl.id);
    await db.bankTransaction.update({
      where: { id: bankTx.id },
      data: { journalEntryId: entry.id },
    });

    const res = await journalRequest(entry.id, company.id, token, { action: 'void', reason: REASON });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('transacción bancaria');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('posted');
    expect(await db.auditLog.count({ where: { entityId: entry.id } })).toBe(0);
  });

  it('still refuses to void a draft entry (400, "Only posted entries")', async () => {
    const { company, token } = await seedCompanyWithAdmin('s7-draft@example.com');
    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1005', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4005', name: 'Revenue', normalBalance: 'credit' });
    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Draft entry',
        status: 'draft',
        lines: {
          create: [
            { glAccountId: debitGl.id, debit: 1200, credit: 0 },
            { glAccountId: creditGl.id, debit: 0, credit: 1200 },
          ],
        },
      },
    });

    const res = await journalRequest(entry.id, company.id, token, { action: 'void', reason: REASON });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toBe('Only posted entries can be voided');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('draft');
    expect(await db.auditLog.count({ where: { entityId: entry.id } })).toBe(0);
  });

  it('refuses a non-admin member (403) even with a valid reason', async () => {
    const { company } = await seedCompanyWithAdmin('s7-admin-owner@example.com');
    const employee = await createTestUser('s7-employee@example.com');
    await db.companyMember.create({
      data: { userId: employee.id, companyId: company.id, role: 'employee' },
    });
    const employeeToken = await createSession(employee.id);

    const debitGl = await createTestGlAccount({ companyId: company.id, code: '1006', name: 'Cash' });
    const creditGl = await createTestGlAccount({ companyId: company.id, code: '4006', name: 'Revenue', normalBalance: 'credit' });
    const entry = await seedPostedEntry(company.id, debitGl.id, creditGl.id);

    const res = await journalRequest(entry.id, company.id, employeeToken, {
      action: 'void',
      reason: REASON,
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('posted');
    expect(await db.auditLog.count({ where: { entityId: entry.id } })).toBe(0);
  });
});
