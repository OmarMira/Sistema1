/**
 * S5 (Wave 5) — database-level JournalLine invariants and the fiscal-period
 * overlap race.
 *
 * Contract pinned here:
 *  (4) migration `20261107000000_journal_line_checks` adds CHECK constraints on
 *      "JournalLine": a line is never positive on both sides, and neither side
 *      is ever negative. The shipped migration SQL is applied to the fixture here
 *      (it is idempotent and guarded), then the DATABASE — not the service layer —
 *      is asked to reject the bad rows. `prisma db push` in tests/global-setup.ts
 *      cannot model CHECK constraints, so this file is what proves they exist.
 *  (5) generating fiscal periods checks for overlap AND inserts inside ONE
 *      transaction, so two concurrent generates for the same/overlapping range
 *      cannot both pass the check: exactly one wins, the other answers 409 with
 *      the historical Spanish message. Sequential non-overlapping generates keep
 *      working (PRESERVE).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST as generatePOST } from '@/app/api/fiscal-periods/generate/route';
import es from '@/i18n/locales/es';
import {
  clearDatabase,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestUser,
} from '../helpers/factories';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'prisma/migrations/20261107000000_journal_line_checks/migration.sql',
);

beforeAll(async () => {
  // Deploy the shipped migration to the fixture. Every statement is guarded with
  // a pg_constraint lookup, so re-applying it (after `prisma migrate deploy` or a
  // previous run) is a no-op.
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  await db.$executeRawUnsafe(sql);
});

// ─── (4) JournalLine CHECK constraints ───────────────────────────────

describe('S5 (4) — JournalLine CHECK constraints are enforced by PostgreSQL', () => {
  let entryId: string;
  let glAccountId: string;
  let otherAccountId: string;

  beforeEach(async () => {
    await clearDatabase();
    const company = await createTestCompany('wave5-s5-journal-line-checks');
    glAccountId = (await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' })).id;
    otherAccountId = (await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue' })).id;
    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2026-05-15T12:00:00.000Z'),
        description: 'wave5 s5 constraint probe',
        status: 'posted',
      },
      select: { id: true },
    });
    entryId = entry.id;
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('rejects a line that is positive on BOTH sides', async () => {
    await expect(
      db.journalLine.create({ data: { entryId, glAccountId, debit: 100, credit: 100 } }),
    ).rejects.toThrow(/JournalLine_not_both_positive/);

    expect(await db.journalLine.count({ where: { entryId } })).toBe(0);
  });

  it('rejects a NEGATIVE debit', async () => {
    await expect(
      db.journalLine.create({ data: { entryId, glAccountId, debit: -1, credit: 0 } }),
    ).rejects.toThrow(/JournalLine_debit_non_negative/);

    expect(await db.journalLine.count({ where: { entryId } })).toBe(0);
  });

  it('rejects a NEGATIVE credit', async () => {
    await expect(
      db.journalLine.create({ data: { entryId, glAccountId: otherAccountId, debit: 0, credit: -0.01 } }),
    ).rejects.toThrow(/JournalLine_credit_non_negative/);

    expect(await db.journalLine.count({ where: { entryId } })).toBe(0);
  });

  it('PRESERVE: a normal one-sided line is still accepted', async () => {
    const created = await db.journalLine.create({
      data: { entryId, glAccountId, debit: 100, credit: 0 },
      select: { id: true, debit: true, credit: true },
    });

    expect(created.id).toBeTruthy();
    expect(Number(created.debit)).toBe(100);
    expect(Number(created.credit)).toBe(0);
    expect(await db.journalLine.count({ where: { entryId } })).toBe(1);
  });
});

// ─── (5) fiscal-period overlap race ──────────────────────────────────

type Setup = { companyId: string; token: string; userId: string };

async function setup(): Promise<Setup> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await createTestUser(`wave5-s5-${stamp}@example.com`);
  const company = await createTestCompany(`wave5-s5-race-${stamp}`);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { companyId: company.id, token, userId: user.id };
}

function generateBody(year: number) {
  return {
    year,
    config: { type: 'CALENDAR', startMonth: 1, closingAccountCode: '1111' },
  };
}

async function generate(s: Setup, year: number) {
  const request = new NextRequest(
    `http://localhost/api/fiscal-periods/generate?companyId=${s.companyId}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(generateBody(year)),
    },
  );
  const res = await generatePOST(request, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}

describe('S5 (5) — fiscal-period overlap check + insert are one transaction', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('two concurrent generates for the same range: exactly one 200, the other a 409 in Spanish', async () => {
    const s = await setup();

    const [first, second] = await Promise.all([generate(s, 2041), generate(s, 2041)]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);

    // Never two winners, and never a 500 from the (companyId, name) unique index.
    expect(statuses).toEqual([200, 409]);

    const winner = first.status === 200 ? first : second;
    const loser = first.status === 409 ? first : second;
    expect(winner.body.periods).toHaveLength(12);
    expect(loser.body.error).toBe(es.apiErrors.fiscalPeriods.conflict);

    // Exactly one batch was written, no duplicates from the losing request.
    expect(await db.fiscalPeriod.count({ where: { companyId: s.companyId } })).toBe(12);
    expect(
      await db.auditLog.count({ where: { companyId: s.companyId, action: 'PERIODS_GENERATED' } }),
    ).toBe(1);
  });

  it('PRESERVE: sequential non-overlapping generates still succeed', async () => {
    const s = await setup();

    const firstYear = await generate(s, 2042);
    expect(firstYear.status).toBe(200);
    expect(firstYear.body.periods).toHaveLength(12);

    const secondYear = await generate(s, 2043);
    expect(secondYear.status).toBe(200);
    expect(secondYear.body.periods).toHaveLength(12);

    expect(await db.fiscalPeriod.count({ where: { companyId: s.companyId } })).toBe(24);
  });

  it('PRESERVE: a sequential duplicate is still refused with 409 and writes nothing', async () => {
    const s = await setup();

    expect((await generate(s, 2044)).status).toBe(200);

    const duplicate = await generate(s, 2044);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe(es.apiErrors.fiscalPeriods.conflict);
    expect(await db.fiscalPeriod.count({ where: { companyId: s.companyId } })).toBe(12);
  });
});
