import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { toCents } from '@/lib/money';
import { POST as journalPOST } from '@/app/api/journal/[id]/route';
import { POST as correctionPOST } from '@/app/api/journal/[id]/corregir/route';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestGlAccount,
} from '../helpers/factories';

/**
 * S3 — the correction flow's balance math compares exact cents.
 *
 * `assertBalancedCorrectionLines` used to accumulate `Math.round(x * 100)`;
 * it now sums `toCents(x)` and compares with `compareCents`, which keeps the
 * accepted/rejected contract and the user-facing message identical for every
 * 2-decimal amount (the only reachable domain: the route validates the same
 * way and the column is Decimal(18,2)).
 */

async function seedCompany(email: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(`W4 ${email}`);
  await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'company_admin' } });
  const token = await createSession(user.id);
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
  // Posted through the production path (draft → POST action=post), so the
  // original is sealed into the journal hash chain like every real posting.
  const draft = await db.journalEntry.create({
    data: {
      companyId: company.id,
      date: new Date('2025-06-15T00:00:00.000Z'),
      description: 'Original',
      reference: 'ORIG-1',
      status: 'draft',
      lines: {
        create: [
          { glAccountId: cash.id, debit: 0.3, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 0.3 },
        ],
      },
    },
  });
  const posted = await journalPOST(
    new NextRequest(`http://localhost/api/journal/${draft.id}?companyId=${company.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'post' }),
    }),
    { params: Promise.resolve({ id: draft.id }) },
  );
  expect(posted.status).toBe(200);
  const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: draft.id } });
  return { user, company, token, cash, equity, entry };
}

function correct(entryId: string, companyId: string, token: string, lines: unknown[]) {
  return correctionPOST(
    new NextRequest(`http://localhost/api/journal/${entryId}/corregir?companyId=${companyId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId,
        correctionDate: '2025-06-20',
        reason: 'W4 exactness',
        correctedLines: lines,
      }),
    }),
    { params: Promise.resolve({ id: entryId }) },
  );
}

describe('S3 — correction balance math is cents-exact', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('accepts a 0.10 + 0.20 debit against a 0.30 credit', async () => {
    const { company, token, cash, equity, entry } = await seedCompany('w4-corr-balanced@example.com');

    const res = await correct(entry.id, company.id, token, [
      { glAccountId: cash.id, debit: 0.1, credit: 0 },
      { glAccountId: cash.id, debit: 0.2, credit: 0 },
      { glAccountId: equity.id, debit: 0, credit: 0.3 },
    ]);

    expect(res.status).toBe(200);

    const replacement = await db.journalEntry.findFirstOrThrow({
      where: { companyId: company.id, reference: `CORR-REPLACEMENT-${entry.id}` },
      include: { lines: true },
    });
    const debitTotal = replacement.lines.reduce((sum, l) => sum + toCents(l.debit), 0);
    const creditTotal = replacement.lines.reduce((sum, l) => sum + toCents(l.credit), 0);
    expect(debitTotal).toBe(30);
    expect(creditTotal).toBe(30);
  });

  it('rejects an entry that is off by exactly one cent', async () => {
    const { company, token, cash, equity, entry } = await seedCompany('w4-corr-unbalanced@example.com');

    const res = await correct(entry.id, company.id, token, [
      { glAccountId: cash.id, debit: 0.3, credit: 0 },
      { glAccountId: equity.id, debit: 0, credit: 0.31 },
    ]);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      'Correction entry must balance. Total debits (0.30) must equal total credits (0.31)',
    );
  });

  it('agrees with the service on half-cent precision (route and service use ROUND_HALF_UP cents)', async () => {
    const { company, token, cash, equity, entry } = await seedCompany('w4-corr-half-cent@example.com');

    // ROUND_HALF_UP cents: debit 1.005 → 101, credits 1.00 + 0.005 → 100 + 1 = 101.
    // The route's previous `Math.round(x * 100)` sums computed 100 vs 101 and
    // rejected a correction whose stored lines balance exactly; the service's
    // own cents check already accepted it (route and service could disagree).
    const res = await correct(entry.id, company.id, token, [
      { glAccountId: cash.id, debit: 1.005, credit: 0 },
      { glAccountId: equity.id, debit: 0, credit: 1.0 },
      { glAccountId: equity.id, debit: 0, credit: 0.005 },
    ]);

    expect(res.status).toBe(200);

    const replacement = await db.journalEntry.findFirstOrThrow({
      where: { companyId: company.id, reference: `CORR-REPLACEMENT-${entry.id}` },
      include: { lines: true },
    });
    const debitTotal = replacement.lines.reduce((sum, l) => sum + toCents(l.debit), 0);
    const creditTotal = replacement.lines.reduce((sum, l) => sum + toCents(l.credit), 0);
    // Decimal(18,2) stores the half-up cent values, so the posted entry balances.
    expect(debitTotal).toBe(101);
    expect(creditTotal).toBe(101);
  });
});
