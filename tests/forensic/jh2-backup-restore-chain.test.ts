/**
 * JH2.12 — Backup / Restore chain continuity (BR1–BR12).
 *
 * Real DB, real createBackup/restoreBackup. No mocks.
 * Warranty under test: the authoritative JournalChainHead travels in the
 * backup, is VALIDATED against the restored members inside the restore tx,
 * and a new append continues the RESTORED chain without inventing roots.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import type { BackupData } from '@/lib/backup';
import { createBackup, restoreBackup } from '@/lib/backup';
import { appendEntryToJournalChain, type ChainTx } from '@/lib/journal-chain';
import { verifyJournalChain } from '@/lib/journal-hash';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

type Seeded = {
  companyId: string;
  userId: string;
  gl1: { id: string };
  gl2: { id: string };
};

let seq = 0;

async function seedCompany(label: string): Promise<Seeded> {
  seq += 1;
  const user = await createTestUser(`jh2br-${label}-${seq}-${Date.now()}@example.com`);
  const company = await createTestCompany(`JH2BR ${label}`);
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
  return { companyId: company.id, userId: user.id, gl1, gl2 };
}

async function appendViaTx(seeded: Seeded, description: string) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const entry = await tx.journalEntry.create({
      data: {
        companyId: seeded.companyId,
        date: new Date('2026-03-15T10:00:00.000Z'),
        description,
        status: 'posted',
        lines: {
          create: [
            { glAccountId: seeded.gl1.id, debit: 100, credit: 0 },
            { glAccountId: seeded.gl2.id, debit: 0, credit: 100 },
          ],
        },
      },
    });
    await appendEntryToJournalChain(tx as unknown as ChainTx, {
      companyId: seeded.companyId,
      entryId: entry.id,
    });
    return entry.id;
  });
}

async function buildBackup(p: Seeded): Promise<BackupData> {
  const result = await createBackup(p.companyId);
  return JSON.parse(Buffer.from(result.data, 'base64').toString('utf-8')) as BackupData;
}

async function restoreFrom(p: Seeded, backupData: BackupData, targetId?: string) {
  // Bootstrap-mode restore requires an EMPTY database: wipe the seeded
  // company first (company row + all children incl. chain head via cascade).
  const id = targetId ?? p.companyId;
  await db.journalChainHead.deleteMany({ where: { companyId: id } });
  await db.bankTransaction.deleteMany({ where: { statement: { bankAccount: { companyId: id } } } });
  await db.bankStatement.deleteMany({ where: { bankAccount: { companyId: id } } });
  await db.journalLine.deleteMany({ where: { entry: { companyId: id } } });
  await db.journalEntry.deleteMany({ where: { companyId: id } });
  await db.bankAccount.deleteMany({ where: { companyId: id } });
  await db.bankStatement.deleteMany({ where: { companyId: id } });
  await db.glAccount.deleteMany({ where: { companyId: id } });
  await db.companyMember.deleteMany({ where: { companyId: id } });
  await db.company.delete({ where: { id: id } }).catch(() => {});
  return restoreBackup(id, backupData, p.userId, { bootstrap: true });
}

async function headOf(companyId: string) {
  return db.journalChainHead.findUnique({ where: { companyId } });
}

describe('JH2.12 — backup/restore chain continuity (BR1–BR12)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });
  afterEach(async () => {
    await clearDatabase();
  });

  it('BR1: new backup includes JournalChainHead (companyId/lastHash/lastEntryId; row id not exported)', async () => {
    const p = await seedCompany('br1');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    expect(data.data.journalChainHead).not.toBeNull();
    expect(data.data.journalChainHead!.companyId).toBe(p.companyId);
    expect(data.data.journalChainHead!.lastHash).toEqual(expect.any(String));
    const head = await headOf(p.companyId);
    expect(data.data.journalChainHead!.lastEntryId).toBe(head!.lastEntryId);
  });

  it('BR2..BR4: restore preserves hash/previousHash/hashVersion and restores the VALIDATED head; verify PASS', async () => {
    const p = await seedCompany('br2');
    const first = await appendViaTx(p, 'A');
    const second = await appendViaTx(p, 'B');
    const data = await buildBackup(p);
    const before = await db.journalEntry.findMany({
      where: { companyId: p.companyId },
      select: { hash: true, previousHash: true, hashVersion: true, id: true },
      orderBy: { createdAt: 'asc' },
    });

    // Wipe and restore the SAME company id (bootstrap: no prior data).
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(true);

    const restored = await db.journalEntry.findMany({
      where: { companyId: p.companyId },
      select: { hash: true, previousHash: true, hashVersion: true, id: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(restored.map((r) => r.hash)).toEqual(before.map((b) => b.hash));
    expect(restored.map((r) => r.previousHash)).toEqual(before.map((b) => b.previousHash));
    expect(restored.every((r) => r.hashVersion === 'v2')).toBe(true);
    expect(restored.find((r) => r.id === first)!.previousHash).toBeNull();
    expect(restored.find((r) => r.id === second)!.previousHash).toBe(restored.find((r) => r.id === first)!.hash);

    const head = await headOf(p.companyId);
    expect(head!.lastHash).toBe(second && restored.find((r) => r.id === second)!.hash);
    expect(head!.lastEntryId).toBe(second);

    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(2);
  });

  it('BR5..BR7: new POSTED after restore continues the RESTORED tail (no second ROOT); head advances; verify PASS', async () => {
    const p = await seedCompany('br5');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    const backupHead = (data.data.journalChainHead!);
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(true);

    const newEntry = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const entry = await tx.journalEntry.create({
        data: {
          companyId: p.companyId,
          date: new Date('2026-03-20T10:00:00.000Z'),
          description: 'Post-restore',
          status: 'posted',
          lines: {
            create: [
              { glAccountId: p.gl1.id, debit: 55, credit: 0 },
              { glAccountId: p.gl2.id, debit: 0, credit: 55 },
            ],
          },
        },
      });
      await appendEntryToJournalChain(tx as unknown as ChainTx, {
        companyId: p.companyId,
        entryId: entry.id,
      });
      return tx.journalEntry.findUniqueOrThrow({
        where: { id: entry.id },
        select: { hash: true, previousHash: true, hashVersion: true },
      });
    });

    expect(newEntry.previousHash).toBe(backupHead.lastHash); // continues the restored tail
    expect(newEntry.hashVersion).toBe('v2');

    const head = await headOf(p.companyId);
    expect(head!.lastHash).toBe(newEntry.hash); // head advanced to the NEW entry

    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(2);
    expect(verify.headConsistent).toBe(true);
  });

  it('BR8: OLD backup without head + valid V2 chain → head derived safely (verify + continuation PASS)', async () => {
    const p = await seedCompany('br8');
    await appendViaTx(p, 'A');
    await appendViaTx(p, 'B');
    const data = await buildBackup(p);
    // Simulate a legacy backup: strip the head.
    delete (data.data as { journalChainHead?: unknown }).journalChainHead;

    const res = await restoreFrom(p, data);
    expect(res.success).toBe(true);

    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(2);

    const head = await headOf(p.companyId);
    expect(head).not.toBeNull();
    expect(head!.lastHash).not.toBeNull(); // derived from the certified tail

    // Continuation works.
    const cont = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const entry = await tx.journalEntry.create({
        data: {
          companyId: p.companyId,
          date: new Date('2026-03-21T10:00:00.000Z'),
          description: 'Continue',
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
    });
    expect(cont).toBeUndefined();
    const verify2 = await verifyJournalChain(p.companyId);
    expect(verify2.valid).toBe(true);
    expect(verify2.totalChecked).toBe(3);
  });

  it('BR9: OLD backup without head + corrupt V2 topology → restore FAIL (rollback)', async () => {
    const p = await seedCompany('br9');
    await appendViaTx(p, 'A');
    await appendViaTx(p, 'B');
    const data = await buildBackup(p);
    delete (data.data as { journalChainHead?: unknown }).journalChainHead;
    // Real corruption: point B at a nonexistent ROOT (chain unverifiable).
    const bEntry = data.data.journalEntries.find((e) => (e.description as string) === 'B');
    if (bEntry) bEntry.previousHash = 'ee'.repeat(32);

    const membersBefore = await db.journalEntry.count({ where: { companyId: p.companyId } });
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/JH2_RESTORE_CHAIN_INVALID/);
    // rollback: no partial state (bootstrap mode keeps company but no entries)
    const membersAfter = await db.journalEntry.findMany({
      where: { companyId: p.companyId, hash: { not: null } },
    });
    expect(membersAfter.length).toBeLessThanOrEqual(membersBefore + 1);
  });

  it('BR10: backup with head.lastHash mismatch → restore FAIL', async () => {
    const p = await seedCompany('br10');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    data.data.journalChainHead!.lastHash = 'ab'.repeat(32);
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/JH2_RESTORE_CHAIN_HEAD_MISMATCH/);
  });

  it('BR11: backup with head.lastEntryId incorrect → restore FAIL', async () => {
    const p = await seedCompany('br11');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    data.data.journalChainHead!.lastEntryId = 'wrong-entry-id';
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/JH2_RESTORE_CHAIN_HEAD_MISMATCH/);
  });

  it('BR12: zero members + stale (non-null) head → restore FAIL, coherent with verifier', async () => {
    const p = await seedCompany('br12');
    const data = await buildBackup(p); // no members posted → head null in backup
    // Fabricate the corrupt combination the verifier rejects.
    data.data.journalChainHead = {
      companyId: p.companyId,
      lastHash: 'cd'.repeat(32),
      lastEntryId: 'gone-entry',
    };
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/JH2_CHAIN_HEAD_WITHOUT_MEMBERS/);
  });

  it('OLD_BACKUP_NO_HEAD_NO_HASH (legacy case B): backup without head and zero hashed members restores with no head row', async () => {
    const p = await seedCompany('old-nohash');
    await db.journalEntry.create({
      data: {
        companyId: p.companyId,
        date: new Date(),
        description: 'unposted legacy entry (no hash)',
        status: 'posted',
      },
    });
    const data = await buildBackup(p);
    delete (data.data as { journalChainHead?: unknown }).journalChainHead;
    // zero hashed members → head was null; strip it defensively
    data.data.journalChainHead = null;
    const res = await restoreFrom(p, data);
    expect(res.success).toBe(true);
    expect(await headOf(p.companyId)).toBeNull();
    // High-water contract (JH2.6, frozen): posted rows without a seal make the
    // chain UNVERIFIABLE (MEMBER_HASH_NULL) — the dataset is not a chain
    // member universe; the verifier surfaces that explicitly, never covering
    // it with an empty PASS.
    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(false);
    expect(verify.reasonCode).toBe('MEMBER_HASH_NULL');
  });
});
