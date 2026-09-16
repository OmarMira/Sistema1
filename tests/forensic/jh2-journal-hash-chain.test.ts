/**
 * JH2.8 — Journal Hash Chain certification battery (T0–T20 + duplicate-hash
 * structural test) against the real TEST PostgreSQL database.
 *
 * Ground rules:
 *  - No mocks of the chain / primitive / Prisma for any test.
 *  - Every append happens inside a real db.$transaction boundary
 *    (the SAME boundary that creates/POSTs the entry).
 *  - Tamper tests mutate the test database directly — never production.
 *  - Zero-vacuous: each case asserts concrete row/property evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import {
  computeEntryHash,
  computeEntryHashV2,
  verifyJournalChain,
} from '@/lib/journal-hash';
import {
  appendEntryToJournalChain,
  JournalChainError,
  type ChainTx,
} from '@/lib/journal-chain';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

// ─── DB safety guard: tests must never point at a non-test DB ──────────────
function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  let dbName = '(unset)';
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    /* default fallback below */
  }
  if (dbName !== 'accountexpress_test') {
    throw new Error(
      `[JH2 TEST SAFETY] DATABASE_URL does not point at accountexpress_test ` +
        `(got "${dbName}"). STOP — JH2_TEST_DATABASE_SAFETY_VIOLATION`,
    );
  }
}

// ─── Test scaffolding ────────────────────────────────────────────────────────
type Seeded = {
  companyId: string;
  gl1: { id: string };
  gl2: { id: string };
};

let seq = 0;

async function seedCompany(label: string): Promise<Seeded> {
  seq += 1;
  const user = await createTestUser(`jh2-${label}-${seq}-${Date.now()}@example.com`);
  const company = await createTestCompany(`JH2 ${label}`);
  await createTestCompanyMember(user.id, company.id);
  const gl1 = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const gl2 = await createTestGlAccount({
    companyId: company.id,
    code: '4000',
    name: 'Sales',
    accountType: 'revenue',
    normalBalance: 'credit',
  });
  return { companyId: company.id, gl1, gl2 };
}

/** REAL production-shaped POSTED creation: entry + append in ONE tx. */
async function createPostedAppended(
  companyId: string,
  description: string,
  gl1: { id: string },
  gl2: { id: string },
  amount = 100,
) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const entry = await tx.journalEntry.create({
      data: {
        companyId,
        date: new Date('2026-03-15T10:00:00.000Z'),
        description,
        status: 'posted',
        lines: {
          create: [
            { glAccountId: gl1.id, debit: amount, credit: 0, description: 'dr' },
            { glAccountId: gl2.id, debit: 0, credit: amount, description: 'cr' },
          ],
        },
      },
    });
    await appendEntryToJournalChain(tx as unknown as ChainTx, {
      companyId,
      entryId: entry.id,
    });
    const stored = await tx.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { id: true, hash: true, previousHash: true, hashVersion: true, status: true },
    });
    return stored;
  });
}

async function createPendingReview(p: Seeded, description: string) {
  return db.journalEntry.create({
    data: {
      companyId: p.companyId,
      date: new Date('2026-03-15T10:00:00.000Z'),
      description,
      status: 'pending_review',
    },
    select: { id: true, status: true },
  });
}

async function promoteViaTxPending(id: string, companyId: string) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.journalEntry.update({
      where: { id },
      data: { status: 'posted' },
    });
    await appendEntryToJournalChain(tx as unknown as ChainTx, { companyId, entryId: id });
  });
}

async function voidViaTx(id: string) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.journalEntry.update({
      where: { id },
      data: { status: 'void' },
    });
  });
}

async function headOf(companyId: string) {
  return db.journalChainHead.findUnique({ where: { companyId } });
}

async function membersOf(companyId: string) {
  return db.journalEntry.findMany({
    where: { companyId, hash: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
}

// ─── The battery ────────────────────────────────────────────────────────────
describe('JH2.8 — journal hash chain (T0–T20 + structural extra)', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // ── T0 — canonicalization invariant ──
  it('T0: same lines, different input order → identical V2 hash (line order NOT in HMAC)', () => {
    const linesA = [
      { glAccountId: 'gl-cash', debit: 123.45, credit: 0, description: 'dn' },
      { glAccountId: 'gl-sales', debit: 0, credit: 123.45, description: 'cn' },
      { glAccountId: 'gl-other', debit: 10, credit: 10, description: 'mm' },
    ];
    const linesB = [...linesA].reverse();
    const base = {
      id: 'entry-x',
      companyId: 'company-x',
      date: new Date('2026-01-01T00:00:00.000Z'),
      description: 'd',
      reference: null,
      previousHash: null,
    };
    const hA = computeEntryHashV2({ ...base, lines: linesA });
    const hB = computeEntryHashV2({ ...base, lines: linesB });
    expect(hA).toBe(hB);
    // And a value difference IS detected
    const hC = computeEntryHashV2({
      ...base,
      lines: [linesA[0], { glAccountId: 'gl-sales', debit: 0, credit: 123.44, description: 'cn' }, linesA[2]],
    });
    expect(hC).not.toBe(hA);
  });

  // ── T1 — first posted ──
  it('T1: first posted → sealed, head seeded, verify PASS (totalChecked=1)', async () => {
    const p = await seedCompany('first');
    const first = await createPostedAppended(p.companyId, 'First', p.gl1, p.gl2);

    expect(first.hash).not.toBeNull();
    expect(first.hashVersion).toBe('v2');
    expect(first.previousHash).toBeNull();

    const head = await headOf(p.companyId);
    expect(head).not.toBeNull();
    expect(head!.lastHash).toBe(first.hash);
    expect(head!.lastEntryId).toBe(first.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1);
    expect(result.members).toBe(1);
    expect(result.v2Members).toBe(1);
  });

  // ── T2 — second posted chains ──
  it('T2: second posted → previousHash = first.hash; head advanced; verify PASS (2)', async () => {
    const p = await seedCompany('second');
    const first = await createPostedAppended(p.companyId, 'First', p.gl1, p.gl2);
    const second = await createPostedAppended(p.companyId, 'Second', p.gl1, p.gl2);

    expect(second.previousHash).toBe(first.hash);
    expect(second.id).not.toBe(first.id);

    const head = await headOf(p.companyId);
    expect(head!.lastHash).toBe(second.hash);
    expect(head!.lastEntryId).toBe(second.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(2);
    // second must be the unique TAIL: its hash is not referenced by any member
    const referenced = await db.journalEntry.findFirst({
      where: { companyId: p.companyId, previousHash: second.hash },
    });
    expect(referenced).toBeNull();
  });

  // ── T3 — draft creates nothing in the chain ──
  it('T3: draft → hash null, no head row, no members', async () => {
    const p = await seedCompany('draft');
    const draft = await db.journalEntry.create({
      data: {
        companyId: p.companyId,
        date: new Date('2026-03-15T10:00:00.000Z'),
        description: 'Draft entry',
        status: 'draft',
      },
      select: { id: true, hash: true, previousHash: true, hashVersion: true },
    });

    expect(draft.hash).toBeNull();
    expect(draft.previousHash).toBeNull();
    expect(draft.hashVersion).toBeNull();
    expect(await headOf(p.companyId)).toBeNull();

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(0);
  });

  // ── T4 — editing a draft never creates a hash ──
  it('T4: edit draft → still hashless, head unchanged', async () => {
    const p = await seedCompany('draft-edit');
    const draft = await db.journalEntry.create({
      data: {
        companyId: p.companyId,
        date: new Date('2026-03-15T10:00:00.000Z'),
        description: 'Before edit',
        status: 'draft',
      },
    });
    await db.journalEntry.update({
      where: { id: draft.id },
      data: { description: 'After edit', date: new Date('2026-03-20T10:00:00.000Z') },
    });

    const after = await db.journalEntry.findUniqueOrThrow({
      where: { id: draft.id },
      select: { hash: true, previousHash: true, hashVersion: true },
    });
    expect(after.hash).toBeNull();
    expect(await headOf(p.companyId)).toBeNull();
  });

  // ── T5 — draft → posted appends EXACTLY once ──
  it('T5: draft → posted via transactional promotion appends once (double refused)', async () => {
    const p = await seedCompany('promo');
    const draft = await db.journalEntry.create({
      data: {
        companyId: p.companyId,
        date: new Date('2026-03-15T10:00:00.000Z'),
        description: 'Will be posted',
        status: 'draft',
        lines: {
          create: [
            { glAccountId: p.gl1.id, debit: 50, credit: 0 },
            { glAccountId: p.gl2.id, debit: 0, credit: 50 },
          ],
        },
      },
    });

    // Productive path mirror of POST /api/journal/[id] {action:'post'}
    await promoteViaTxPending(draft.id, p.companyId);

    const posted = await db.journalEntry.findUniqueOrThrow({
      where: { id: draft.id },
      select: { status: true, hash: true, previousHash: true, hashVersion: true },
    });
    expect(posted.status).toBe('posted');
    expect(posted.hash).not.toBeNull();
    expect(posted.hashVersion).toBe('v2');
    expect(posted.previousHash).toBeNull();

    const head = await headOf(p.companyId);
    expect(head!.lastEntryId).toBe(draft.id);
    expect(head!.lastHash).toBe(posted.hash);

    // A second append attempt must be refused structurally.
    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: draft.id,
        });
      }),
    ).rejects.toThrow();

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1);
  });

  // ── T6 — pending_review → posted appends once ──
  it('T6: pending_review → posted appends exactly once', async () => {
    const p = await seedCompany('pending');
    const pending = await createPendingReview(p, 'Pending entry');
    await promoteViaTxPending(pending.id, p.companyId);

    const stored = await db.journalEntry.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, hash: true, hashVersion: true },
    });
    expect(stored.status).toBe('posted');
    expect(stored.hash).not.toBeNull();
    expect(stored.hashVersion).toBe('v2');

    const head = await headOf(p.companyId);
    expect(head!.lastEntryId).toBe(pending.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1);
  });

  // ── T7 — pending_review → void never joins the chain ──
  it('T7: rejected pending_review stays void, hashless, NOT a member', async () => {
    const p = await seedCompany('rejected');
    // Chain already has one member so membership counting is non-trivial.
    const member = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const pending = await createPendingReview(p, 'Rejected');
    await voidViaTx(pending.id);

    const stored = await db.journalEntry.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, hash: true, previousHash: true, hashVersion: true },
    });
    expect(stored.status).toBe('void');
    expect(stored.hash).toBeNull();
    expect(stored.previousHash).toBeNull();
    expect(stored.hashVersion).toBeNull();

    const head = await headOf(p.companyId);
    expect(head!.lastEntryId).toBe(member.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1); // rejected void NOT counted
    expect(result.members).toBe(1);
  });

  // ── T8 — posted → void preserves the sealed accounting substance ──
  it('T8: posted→void keeps hash/previousHash/hashVersion and head; verifier PASS', async () => {
    const p = await seedCompany('void');
    const first = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const headBefore = await headOf(p.companyId);

    await voidViaTx(first.id);

    const after = await db.journalEntry.findUniqueOrThrow({
      where: { id: first.id },
      select: { status: true, hash: true, previousHash: true, hashVersion: true },
    });
    expect(after.status).toBe('void');
    expect(after.hash).toBe(first.hash);
    expect(after.previousHash).toBe(first.previousHash);
    expect(after.hashVersion).toBe('v2');

    const headAfter = await headOf(p.companyId);
    expect(headAfter!.lastHash).toBe(headBefore!.lastHash);
    expect(headAfter!.lastEntryId).toBe(headBefore!.lastEntryId);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1); // void member still in chain
  });

  // ── Tamper detection (T9–T13) — prove PASS → mutate once → assert FAIL ──
  // Each tamper mutates the TEST DB directly (post-POST mutation).
  it('T9: glAccount redistribution with identical totals → verifier FAIL', async () => {
    const p = await seedCompany('tamper-account');
    const gl3 = await createTestGlAccount({
      companyId: p.companyId,
      code: '5000',
      name: 'Other Expense',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    const entry = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    expect((await verifyJournalChain(p.companyId)).valid).toBe(true);

    await db.journalLine.updateMany({
      where: { entryId: entry.id, glAccountId: p.gl2.id },
      data: { glAccountId: gl3.id },
    });

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('HASH_MISMATCH');
  });

  it('T10: amount redistribution with equal sums → verifier FAIL', async () => {
    const p = await seedCompany('tamper-redist');
    const gl3 = await createTestGlAccount({
      companyId: p.companyId,
      code: '5000',
      name: 'Other',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    // Dr Cash 100 / Cr Sales 100  →  Dr Cash 60 + Other 40 / Cr Sales 100
    const entry = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2, 100);
    const cashLine = await db.journalLine.findFirstOrThrow({ where: { entryId: entry.id, glAccountId: p.gl1.id } });
    await db.journalLine.create({
      data: { entryId: entry.id, glAccountId: gl3.id, debit: 40, credit: 0 },
    });
    await db.journalLine.update({
      where: { id: cashLine.id },
      data: { debit: 60 },
    });
    // totals unchanged: debit 100, credit 100
    const totals = await db.journalLine.aggregate({
      where: { entryId: entry.id },
      _sum: { debit: true, credit: true },
    });
    expect(Number(totals._sum.debit)).toBe(100);
    expect(Number(totals._sum.credit)).toBe(100);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('HASH_MISMATCH');
  });

  it('T11: description/reference tamper → verifier FAIL', async () => {
    const p = await seedCompany('tamper-desc');
    const entry = await createPostedAppended(p.companyId, 'Original', p.gl1, p.gl2);
    expect((await verifyJournalChain(p.companyId)).valid).toBe(true);

    await db.journalEntry.update({
      where: { id: entry.id },
      data: { description: 'Forged', reference: 'FAKED' },
    });

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('HASH_MISMATCH');
  });

  it('T12: stored previousHash tamper → verifier FAIL', async () => {
    const p = await seedCompany('tamper-prev');
    await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const second = await createPostedAppended(p.companyId, 'B', p.gl1, p.gl2);
    expect((await verifyJournalChain(p.companyId)).valid).toBe(true);

    await db.journalEntry.update({
      where: { id: second.id },
      data: { previousHash: 'aa'.repeat(32) },
    });

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    // A forged ROOT hash breaks the stored link to its successor: the verifier
    // reaches an orphan before any recompute mismatch.
    expect(['HASH_MISMATCH', 'CHAIN_ORPHAN']).toContain(result.reasonCode);
  });

  it('T13: stored hash tamper → verifier FAIL', async () => {
    const p = await seedCompany('tamper-hash');
    const first = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const second = await createPostedAppended(p.companyId, 'B', p.gl1, p.gl2);
    expect((await verifyJournalChain(p.companyId)).valid).toBe(true);

    await db.journalEntry.update({
      where: { id: first.id },
      data: { hash: 'bb'.repeat(32) },
    });

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    // A forged ROOT hash breaks the stored link to its successor: the walk
    // reaches an orphan before any recompute mismatch. Both outcomes are
    // a legitimate detected-tamper FAIL.
    expect(['HASH_MISMATCH', 'CHAIN_ORPHAN']).toContain(result.reasonCode);
  });

  // ── T14 — concurrent same-company appends ──
  it('T14: 8 concurrent independent transactions → single linear chain, verifier PASS(8)', async () => {
    const p = await seedCompany('concurrent-same');
    const K = 8;
    await Promise.all(
      Array.from({ length: K }, (_, i) =>
        db.$transaction(async (tx: Prisma.TransactionClient) => {
          const entry = await tx.journalEntry.create({
            data: {
              companyId: p.companyId,
              date: new Date('2026-03-15T10:00:00.000Z'),
              description: `Concurrent ${i}`,
              status: 'posted',
              lines: {
                create: [
                  { glAccountId: p.gl1.id, debit: 10 + i, credit: 0 },
                  { glAccountId: p.gl2.id, debit: 0, credit: 10 + i },
                ],
              },
            },
          });
          await appendEntryToJournalChain(tx as unknown as ChainTx, {
            companyId: p.companyId,
            entryId: entry.id,
          });
          return entry.id;
        }),
      ),
    );

    const members = await membersOf(p.companyId);
    expect(members.length).toBe(K);

    const roots = members.filter((m) => m.previousHash == null);
    expect(roots.length).toBe(1);

    const nonRoot = members.filter((m) => m.previousHash != null);
    expect(nonRoot.length).toBe(K - 1);
    const prevHashSet = new Set(nonRoot.map((m) => m.previousHash));
    expect(prevHashSet.size).toBe(K - 1); // no duplicated previousHash

    const head = await headOf(p.companyId);
    const notReferenced = members.find(
      (m) => !members.some((o) => o.previousHash === m.hash),
    );
    expect(notReferenced!.id).toBe(head!.lastEntryId);
    expect(head!.lastHash).toBe(notReferenced!.hash);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(K);
    expect(result.headConsistent).toBe(true);
  });

  // ── T15 — concurrent different companies → independent chains ──
  it('T15: two companies append concurrently → independent heads/chains, both verify PASS', async () => {
    const a = await seedCompany('tanant-a');
    const b = await seedCompany('tenant-b');

    await Promise.all([
      (async () => {
        for (let i = 0; i < 3; i++) {
          await createPostedAppended(a.companyId, `A${i}`, a.gl1, a.gl2);
        }
      })(),
      (async () => {
        for (let i = 0; i < 3; i++) {
          await createPostedAppended(b.companyId, `B${i}`, b.gl1, b.gl2);
        }
      })(),
    ]);

    for (const s of [a, b]) {
      const result = await verifyJournalChain(s.companyId);
      expect(result.valid).toBe(true);
      expect(result.totalChecked).toBe(3);
    }

    const headA = await headOf(a.companyId);
    const headB = await headOf(b.companyId);
    expect(headA_and_B_are_independent(headA!, headB!)).toBe(true);
  });

  // ── T16 — empty-chain race (first appends concurrent, no head precreated) ──
  it('T16: two concurrent FIRST appends → single ROOT; second chains on first', async () => {
    const p = await seedCompany('race');
    // No head row precreated; two independent transactions race the INSERT..ON CONFLICT.
    await Promise.all([
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: p.companyId,
            date: new Date('2026-03-15T10:00:00.000Z'),
            description: 'Race 1',
            status: 'posted',
            lines: {
              create: [
                { glAccountId: p.gl1.id, debit: 1, credit: 0 },
                { glAccountId: p.gl2.id, debit: 0, credit: 1 },
              ],
            },
          },
        });
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: entry.id,
        });
        return entry.id;
      }),
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: p.companyId,
            date: new Date('2026-03-15T10:00:00.000Z'),
            description: 'Race 2',
            status: 'posted',
            lines: {
              create: [
                { glAccountId: p.gl1.id, debit: 2, credit: 0 },
                { glAccountId: p.gl2.id, debit: 0, credit: 2 },
              ],
            },
          },
        });
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: entry.id,
        });
        return entry.id;
      }),
    ]);

    const members = await membersOf(p.companyId);
    expect(members.length).toBe(2);
    const roots = members.filter((m) => m.previousHash == null);
    expect(roots.length).toBe(1); // exactly ONE root despite the race
    const root = roots[0];
    const other = members.find((m) => m.id !== root.id)!;
    expect(other.previousHash).toBe(root.hash);

    const heads = await db.journalChainHead.findMany({
      where: { companyId: p.companyId },
    });
    expect(heads.length).toBe(1);
    expect(heads[0]!.lastEntryId).toBe(other.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(2);
  });

  // ── T17 — tenant isolation ──
  it('T17: cross-company append refused (CHAIN_COMPANY_MISMATCH); no head change', async () => {
    const a = await seedCompany('iso-a');
    const b = await seedCompany('iso-b');
    const entryA = await createPostedAppended(a.companyId, 'A', a.gl1, a.gl2);
    const entryB = await createPostedAppended(b.companyId, 'B', b.gl1, b.gl2);

    const headBBefore = await headOf(b.companyId);
    const headABefore = await headOf(a.companyId);

    // Append entry of company A claiming it belongs to company B's chain.
    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: b.companyId,
          entryId: entryA.id,
        });
      }),
    ).rejects.toThrow('CHAIN_COMPANY_MISMATCH');
    // No self-append either (entry already sealed).
    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: b.companyId,
          entryId: entryB.id,
        });
      }),
    ).rejects.toThrow(JournalChainError);

    const headAAfter = await headOf(a.companyId);
    const headBAfter = await headOf(b.companyId);
    expect(headAAfter!.lastHash).toBe(headABefore!.lastHash);
    expect(headBAfter!.lastHash).toBe(headBBefore!.lastHash);

    // No cross references.
    const aMembers = await membersOf(a.companyId);
    const bMembers = await membersOf(b.companyId);
    const aHashes = new Set(aMembers.map((m) => m.hash));
    const bHashes = new Set(bMembers.map((m) => m.hash));
    for (const m of aMembers) {
      expect(bHashes.has(m.previousHash)).toBe(false);
    }
    for (const m of bMembers) {
      expect(aHashes.has(m.previousHash)).toBe(false);
    }
    expect(entryA.hash).not.toBeNull();
  });

  // ── T18 — rollback atomicity ──
  it('T18: rollback after append → entry, hash, head all rolled back (fresh chain)', async () => {
    const p = await seedCompany('rollback-fresh');
    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: p.companyId,
            date: new Date('2026-03-15T10:00:00.000Z'),
            description: 'Doomed',
            status: 'posted',
            lines: {
              create: [
                { glAccountId: p.gl1.id, debit: 5, credit: 0 },
                { glAccountId: p.gl2.id, debit: 0, credit: 5 },
              ],
            },
          },
        });
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: entry.id,
        });
        throw new Error('JH2_FORCED_ROLLBACK');
      }),
    ).rejects.toThrow('JH2_FORCED_ROLLBACK');

    const doomed = await db.journalEntry.findFirst({ where: { companyId: p.companyId } });
    expect(doomed).toBeNull();
    expect(await headOf(p.companyId)).toBeNull();

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(0);
  });

  it('T18b: rollback after append on EXISTING chain → head stays on prior TAIL', async () => {
    const p = await seedCompany('rollback-existing');
    const first = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const headBefore = await headOf(p.companyId);

    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: p.companyId,
            date: new Date('2026-03-16T10:00:00.000Z'),
            description: 'Doomed B',
            status: 'posted',
            lines: {
              create: [
                { glAccountId: p.gl1.id, debit: 6, credit: 0 },
                { glAccountId: p.gl2.id, debit: 0, credit: 6 },
              ],
            },
          },
        });
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: entry.id,
        });
        throw new Error('JH2_FORCED_ROLLBACK');
      }),
    ).rejects.toThrow('JH2_FORCED_ROLLBACK');

    const headAfter = await headOf(p.companyId);
    expect(headAfter!.lastHash).toBe(headBefore!.lastHash);
    expect(headAfter!.lastEntryId).toBe(first.id);
    const remaining = await db.journalEntry.findFirst({
      where: { companyId: p.companyId, description: 'Doomed B' },
    });
    expect(remaining).toBeNull();

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1);
  });

  // ── T19 — legacy explicit + legacy→V2 ──
  /** Build a V1 (totals-only, hashVersion=null) legacy chain in the TEST DB. */
  async function buildLegacyChain(companyId: string, gl1: { id: string }, gl2: { id: string }, n = 2) {
    let previousHash: string | null = null;
    const created = [];
    for (let i = 0; i < n; i++) {
      // Historical contract (035a56d): [id|companyId|ISODate|description|
      // reference??''|status('posted')|totalDebit.toFixed(2)|totalCredit.
      // toFixed(2)|previousHash??''] HMAC-SHA-256.
      const draft = {
        date: new Date('2026-02-10T10:00:00.000Z'),
        description: `Legacy ${i}`,
      };
      const entry = await db.journalEntry.create({
        data: {
          companyId,
          ...draft,
          status: 'posted',
          lines: {
            create: [
              { glAccountId: gl1.id, debit: 100 + i, credit: 0, description: 'ld' },
              { glAccountId: gl2.id, debit: 0, credit: 100 + i, description: 'lc' },
            ],
          },
        },
        include: { lines: true },
      });
      const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      const hash = computeEntryHash({
        id: entry.id,
        companyId,
        date: entry.date.toISOString(),
        description: entry.description,
        reference: entry.reference,
        status: 'posted',
        totalDebit,
        totalCredit,
        previousHash,
      });
      await db.journalEntry.update({
        where: { id: entry.id },
        data: { hash, previousHash }, // hashVersion stays NULL → legacy
      });
      created.push({ ...entry, hash, previousHash });
      previousHash = hash;
    }
    return created;
  }

  it('T19.1: valid legacy chain certifies under V1 (no head row)', async () => {
    const p = await seedCompany('legacy-a');
    const legacy = await buildLegacyChain(p.companyId, p.gl1, p.gl2);
    expect(legacy.length).toBe(2);
    expect(legacy.every((l) => l.hashVersion === null)).toEqual(true);
    expect(legacy[1]!.previousHash).toBe(legacy[0]!.hash);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(2);
    expect(result.legacyMembers).toBe(2);
  });

  it('T19.2: legacy→V2 first append chains onto derived legacy tail atomically', async () => {
    const p = await seedCompany('legacy-b');
    const legacy = await buildLegacyChain(p.companyId, p.gl1, p.gl2);
    const legacyTail = legacy[1]!;
    expect((await headOf(p.companyId))).toBeNull();

    const v2 = await createPostedAppended(p.companyId, 'V1→V2', p.gl1, p.gl2);

    expect(v2.previousHash).toBe(legacyTail.hash);
    expect(v2.hashVersion).toBe('v2');

    const head = await headOf(p.companyId);
    expect(head!.lastHash).toBe(v2.hash);
    expect(head!.lastEntryId).toBe(v2.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(3);
    expect(result.legacyMembers).toBe(2);
    expect(result.v2Members).toBe(1);
  });

  it('T19.3: uncertifiable legacy → first V2 append BLOCKED, no root invented', async () => {
    const p = await seedCompany('legacy-c');
    await buildLegacyChain(p.companyId, p.gl1, p.gl2);
    // Corrupt the LAST legacy hash → legacy undecisvably broken.
    const legacyRows = await db.journalEntry.findMany({
      where: { companyId: p.companyId, hash: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    const tail = legacyRows[legacyRows.length - 1]!;
    await db.journalEntry.update({
      where: { id: tail.id },
      data: { hash: 'cc'.repeat(32) },
    });

    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: p.companyId,
            date: new Date('2026-03-15T10:00:00.000Z'),
            description: 'Blocked V2',
            status: 'posted',
            lines: {
              create: [
                { glAccountId: p.gl1.id, debit: 7, credit: 0 },
                { glAccountId: p.gl2.id, debit: 0, credit: 7 },
              ],
            },
          },
        });
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: entry.id,
        });
      }),
    ).rejects.toThrow('LEGACY_HASH_UNCERTIFIABLE');

    // The V2 append was fully rolled back: no v2 member, no head row.
    const v2 = await db.journalEntry.findFirst({
      where: { companyId: p.companyId, hashVersion: 'v2' },
    });
    expect(v2).toBeNull();
    expect(await headOf(p.companyId)).toBeNull();
    // Legacy remains untouched (still the corrupted bytes; verifier DOWN).

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.legacyUncertifiable).toBe(true);
  });

  // ── T20 — A → B → C with void B in the middle ──
  it('T20: A→B→C; void B keeps topology and head on C; verifier PASS(3)', async () => {
    const p = await seedCompany('void-mid');
    const a = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const b = await createPostedAppended(p.companyId, 'B', p.gl1, p.gl2);
    const c = await createPostedAppended(p.companyId, 'C', p.gl1, p.gl2);

    expect(b.previousHash).toBe(a.hash);
    expect(c.previousHash).toBe(b.hash);

    await voidViaTx(b.id);

    const [aAfter, bAfter, cAfter] = await Promise.all(
      [a, b, c].map((m) =>
        db.journalEntry.findUniqueOrThrow({
          where: { id: m.id },
          select: { status: true, hash: true, previousHash: true },
        }),
      ),
    );
    expect(aAfter.hash).toBe(a.hash);
    expect(bAfter.status).toBe('void');
    expect(bAfter.hash).toBe(b.hash);
    expect(bAfter.previousHash).toBe(a.hash);
    expect(cAfter.status).toBe('posted');
    expect(cAfter.previousHash).toBe(b.hash);

    const head = await headOf(p.companyId);
    expect(head!.lastEntryId).toBe(c.id);

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(3);
    expect(result.members).toBe(3);
  });

  // ── Extra — structural topology (duplicate stored hashes / fork) ──
  it('EXTRA: forked stored previousHash → verifier FAIL with CHAIN_FORK', async () => {
    const p = await seedCompany('fork');
    const a = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    const b = await createPostedAppended(p.companyId, 'B', p.gl1, p.gl2);
    const c = await createPostedAppended(p.companyId, 'C', p.gl1, p.gl2);
    expect((await verifyJournalChain(p.companyId)).valid).toBe(true);

    // Force B and C to chain on the SAME predecessor.
    await db.journalEntry.update({
      where: { id: c.id },
      data: { previousHash: a.hash },
    });

    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('CHAIN_FORK');
  });

  // ── Empty-chain head combinations (JH2.11C § 1) ──
  it('EMPTY_CHAIN_NO_HEAD: no head, no members → PASS (totalChecked=0)', async () => {
    const p = await seedCompany('empty-nohead');
    expect(await headOf(p.companyId)).toBeNull();
    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(0);
    expect(result.reasonCode).toBeUndefined();
  });

  it('EMPTY_CHAIN_EMPTY_HEAD: head with both nulls, no members → PASS', async () => {
    const p = await seedCompany('empty-cleanhead');
    await db.journalChainHead.create({
      data: { companyId: p.companyId, lastHash: null, lastEntryId: null },
    });
    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(0);
    expect(result.headConsistent).toBe(true);
  });

  it('EMPTY_CHAIN_STALE_HEAD: head with opaque state, no members → FAIL CHAIN_HEAD_WITHOUT_MEMBERS', async () => {
    const p = await seedCompany('empty-stalehead');
    await db.journalChainHead.create({
      data: { companyId: p.companyId, lastHash: 'ff'.repeat(32), lastEntryId: 'deleted-entry-id' },
    });
    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('CHAIN_HEAD_WITHOUT_MEMBERS');
    expect(result.headConsistent).toBe(false);
  });

  // ── F1 (JH2.15): duplicate stored hash → explicit rejection ──
  it('F1: two distinct members carrying the SAME stored hash → FAIL DUPLICATE_MEMBER_HASH', async () => {
    const p = await seedCompany('f1');
    const first = await createPostedAppended(p.companyId, 'A', p.gl1, p.gl2);
    await createPostedAppended(p.companyId, 'B', p.gl1, p.gl2);
    // Force B's stored hash to equal A's stored hash (byte-identical value).
    await db.journalEntry.updateMany({
      where: { id: { not: first.id }, companyId: p.companyId, hash: { not: null } },
      data: { hash: first.hash as string },
    });
    const result = await verifyJournalChain(p.companyId);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('DUPLICATE_MEMBER_HASH');
  });

  // ── F2 (JH2.15): injective serialization ──
  it('F2: delimiter-injection counterexample → DIFFERENT V2 hashes (a|b/null vs a/b)', () => {
    const base = {
      id: 'entry-inj',
      companyId: 'company-inj',
      date: new Date('2026-01-01T00:00:00.000Z'),
      previousHash: null as string | null,
      lines: [] as Array<{ glAccountId: string; debit: number; credit: number; description?: string | null }>,
    };
    const completion = (description: string, reference: string | null) =>
      computeEntryHashV2({ ...base, description, reference });
    // (A) description='a|b', reference=null   (B) description='a', reference='b'
    expect(completion('a|b', null)).not.toBe(completion('a', 'b'));
    // NOTE: reference null vs '' are deliberately equivalent (payload uses
    // reference ?? '' — a frozen contract from JH.1); ambiguity was about
    // CONTENT, proven by the A≠B test above.
    // same bytes → same hash
    expect(completion('a|b', null)).toBe(completion('a|b', null));
  });

  it('F2: special text in LINE description (|, ;, Unicode, newline) — deterministic & unambiguous', () => {
    const special = 'Dr|Cr;é燙\n';
    const lines = [
      { glAccountId: 'gl-a', debit: 10, credit: 0, description: special },
      { glAccountId: 'gl-b', debit: 0, credit: 10, description: 'x' },
    ];
    const base = {
      id: 'entry-uni',
      companyId: 'company-uni',
      date: new Date('2026-01-01T00:00:00.000Z'),
      description: special,
      reference: null as string | null,
      previousHash: null as string | null,
    };
    const forward = computeEntryHashV2({ ...base, lines });
    const reversed = computeEntryHashV2({ ...base, lines: [...lines].reverse() });
    expect(forward).toBe(reversed); // order independence retained
    // A sibling with a DIFFERENT semantic (same chars redistributed between
    // two line descriptions) must NOT collide.
    const changed = computeEntryHashV2({
      ...base,
      lines: [
        { glAccountId: 'gl-a', debit: 10, credit: 0, description: special.slice(0, -1) },
        { glAccountId: 'gl-b', debit: 0, credit: 10, description: 'x' },
      ],
    });
    expect(changed).not.toBe(forward);
  });

  // ── F3 (JH2.15): unsealed historical posted member blocks fresh ROOT ──
  it('F3: POSTED historical member with hash=NULL blocks fresh ROOT (CHAIN_UNSEALED_HISTORICAL_MEMBER)', async () => {
    const p = await seedCompany('f3');
    await db.journalEntry.create({
      data: {
        companyId: p.companyId,
        date: new Date('2026-02-01T10:00:00.000Z'),
        description: 'Legacy unsealed posted',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: p.gl1.id, debit: 80, credit: 0 },
            { glAccountId: p.gl2.id, debit: 0, credit: 80 },
          ],
        },
      },
    });

    await expect(
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: p.companyId,
            date: new Date('2026-03-15T10:00:00.000Z'),
            description: 'Attempt over unsealed history',
            status: 'posted',
            lines: {
              create: [
                { glAccountId: p.gl1.id, debit: 9, credit: 0 },
                { glAccountId: p.gl2.id, debit: 0, credit: 9 },
              ],
            },
          },
        });
        await appendEntryToJournalChain(tx as unknown as ChainTx, {
          companyId: p.companyId,
          entryId: entry.id,
        });
      }),
    ).rejects.toThrow('CHAIN_UNSEALED_HISTORICAL_MEMBER');

    // Rollback proof: the whole tx (create + append) rolled back → the
    // attempted entry does NOT exist; the historical unsealed member is
    // untouched; no head was created.
    const attempt = await db.journalEntry.findFirst({
      where: { companyId: p.companyId, description: 'Attempt over unsealed history' },
      select: { hash: true, previousHash: true, hashVersion: true },
    });
    expect(attempt).toBeNull(); // rolled back entirely
    const unsealed = await db.journalEntry.findFirstOrThrow({
      where: { companyId: p.companyId, description: 'Legacy unsealed posted' },
      select: { hash: true, previousHash: true, hashVersion: true },
    });
    expect(unsealed.hash).toBeNull();
    expect(unsealed.previousHash).toBeNull();
    expect(unsealed.hashVersion).toBeNull();
    expect(await headOf(p.companyId)).toBeNull();
  });

  it('F3b: never-posted VOID (hash=NULL) is NOT a member and does NOT block a fresh ROOT', async () => {
    const p = await seedCompany('f3-void');
    await db.journalEntry.create({
      data: {
        companyId: p.companyId,
        date: new Date('2026-02-01T10:00:00.000Z'),
        description: 'Pending_review rejected → void, never posted',
        status: 'void',
      },
    });
    // Membership JH2: void WITHOUT hash was never POSTED → not a member →
    // a legitimate fresh ROOT is allowed (proves the guard is member-scoped).
    const created = await createPostedAppended(p.companyId, 'Fresh root', p.gl1, p.gl2);
    expect(created.previousHash).toBeNull();
    expect(created.hash).not.toBeNull();
    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(1);
  });
});

// T15 helper
function headA_and_B_are_independent(headA: { lastHash: string | null }, headB: { lastHash: string | null }): boolean {
  return headA.lastHash !== headB.lastHash && headA.lastHash !== null && headB.lastHash !== null;
}
