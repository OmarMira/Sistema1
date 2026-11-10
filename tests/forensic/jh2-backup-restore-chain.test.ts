/**
 * JH2.12 — Backup / Restore chain continuity (BR1–BR12).
 *
 * Real DB, real createBackup + the CURRENT company recovery restore. No mocks.
 * Warranty under test: the authoritative JournalChainHead travels in the
 * backup, is VALIDATED against the restored members, and a new append continues
 * the RESTORED chain without inventing roots.
 *
 * Contract note (pinned in tests/bootstrap-recovery/legacy-format-fence.test.ts):
 * the legacy/bootstrap `restoreBackup` refuses 2.x snapshots on purpose — first
 * install ingestion of company archives is not enabled. Commerce with a
 * CURRENT backup therefore goes through the coordinated company recovery path
 * (`restoreCompanyBackup`), which admits only v2 snapshots, requires the
 * destination company to already exist, and certifies the journal chain
 * against the destination signing key (`RESTORE_CHAIN`, no re-signing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import type { BackupData } from '@/lib/backup';
import { createBackup } from '@/lib/backup';
import { sealSnapshot } from '@/lib/backup-format';
import { restoreCompanyBackup } from '@/lib/backup-restore';
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

/**
 * S1/S2/S7: creating a backup requires the creating administrator's password and
 * every company-recovery restore must prove that same credential. The chain
 * continuity contract under test is untouched; only the credential is supplied.
 */
const OWNER_PASSWORD = 'Clave.JournalChain.2026';

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
  const result = await createBackup(p.companyId, undefined, { ownerPassword: OWNER_PASSWORD });
  return JSON.parse(Buffer.from(result.data, 'base64').toString('utf-8')) as BackupData;
}

/**
 * Company recovery restore of a v2 snapshot. The payload is re-sealed right
 * before use so edited fixtures still carry a consistent integrity digest
 * (the digest is a fidelity check, not an authenticity proof: it is
 * `authenticated: false`).
 */
async function restoreFrom(p: Seeded, backupData: BackupData) {
  sealSnapshot(backupData);
  return restoreCompanyBackup(p.companyId, JSON.stringify(backupData), { ownerPassword: OWNER_PASSWORD });
}

/** Refused payloads must not be observable as a partial restore. */
async function rejectedRestore(p: Seeded, backupData: BackupData, expected: RegExp) {
  sealSnapshot(backupData);
  await expect(
    restoreCompanyBackup(p.companyId, JSON.stringify(backupData), { ownerPassword: OWNER_PASSWORD }),
  ).rejects.toThrow(expected);
}

async function headOf(companyId: string) {
  return db.journalChainHead.findUnique({ where: { companyId } });
}

async function sealedMembers(companyId: string) {
  return db.journalEntry.findMany({
    where: { companyId },
    select: { id: true, hash: true, previousHash: true, hashVersion: true },
    orderBy: { createdAt: 'asc' },
  });
}

describe('JH2.12 — backup/restore chain continuity (BR1–BR12)', () => {
  beforeEach(async () => {
    await clearDatabase();
    // The recovery core certifies the INSTALLATION-WIDE audit chain before it
    // replaces any row (src/lib/backup-validation.ts RESTORE_CHAIN): a
    // predecessor another tenant still
    // needs must never be deleted or re-signed. Other suites leave hashed
    // AuditLog rows behind (their tenant is gone, or the hash was sealed with a
    // stubbed HMAC secret) and such a row can never be certified, so the shared
    // test DB removes ONLY that hashed residue. Unhashed operational rows — the
    // COMPANY_RESTORE_COMMITTED receipt this suite asserts on — are untouched,
    // and no chain-continuity assertion is relaxed.
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });
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
    const before = await sealedMembers(p.companyId);

    const res = await restoreFrom(p, data);
    expect(res.status).toBe('committed');
    // The committed receipt proves the replacement, not just the call.
    const receipt = await db.auditLog.findUnique({ where: { id: res.operationId } });
    expect(receipt?.action).toBe('COMPANY_RESTORE_COMMITTED');

    const restored = await sealedMembers(p.companyId);
    expect(restored.map((r) => r.hash)).toEqual(before.map((b) => b.hash));
    expect(restored.map((r) => r.previousHash)).toEqual(before.map((b) => b.previousHash));
    expect(restored.every((r) => r.hashVersion === 'v2')).toBe(true);
    expect(restored.find((r) => r.id === first)!.previousHash).toBeNull();
    expect(restored.find((r) => r.id === second)!.previousHash).toBe(restored.find((r) => r.id === first)!.hash);

    const head = await headOf(p.companyId);
    expect(head!.lastHash).toBe(restored.find((r) => r.id === second)!.hash);
    expect(head!.lastEntryId).toBe(second);

    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(2);
    expect(verify.headConsistent).toBe(true);
  });

  it('BR5..BR7: new POSTED after restore continues the RESTORED tail (no second ROOT); head advances; verify PASS', async () => {
    const p = await seedCompany('br5');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    const backupHead = (data.data.journalChainHead!);
    const res = await restoreFrom(p, data);
    expect(res.status).toBe('committed');

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

  it('BR8: v2 payload that omits the chain anchor is refused (never restores without chain evidence)', async () => {
    const p = await seedCompany('br8');
    await appendViaTx(p, 'A');
    await appendViaTx(p, 'B');
    const data = await buildBackup(p);
    const before = await sealedMembers(p.companyId);
    // A v2 snapshot must STATE its chain anchor (null when the chain is empty).
    // The retired legacy path derived a head for pre-anchor 1.x files; v2 has
    // no derivation branch, so an absent anchor is inadmissible rather than
    // silently inferred.
    delete (data.data as { journalChainHead?: unknown }).journalChainHead;

    await rejectedRestore(p, data, /RESTORE_CHAIN: invalid\/missing head/);

    // The live chain (evidence + anchor) is untouched and still verifies.
    expect(await sealedMembers(p.companyId)).toEqual(before);
    expect(await headOf(p.companyId)).not.toBeNull();
    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(2);
    expect(verify.headConsistent).toBe(true);
  });

  it('BR9: corrupt V2 topology (anchored head, dangling previousHash) → restore FAIL (nothing written)', async () => {
    const p = await seedCompany('br9');
    await appendViaTx(p, 'A');
    await appendViaTx(p, 'B');
    const data = await buildBackup(p);
    // Real corruption: point B at a nonexistent ROOT (chain unverifiable).
    const bEntry = data.data.journalEntries.find((e) => (e.description as string) === 'B');
    if (bEntry) bEntry.previousHash = 'ee'.repeat(32);

    const membersBefore = await sealedMembers(p.companyId);
    await rejectedRestore(p, data, /RESTORE_CHAIN: CHAIN_ORPHAN/);

    // No partial state: the live chain is untouched and still verifies.
    expect(await sealedMembers(p.companyId)).toEqual(membersBefore);
    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(true);
    expect(verify.totalChecked).toBe(2);
  });

  it('BR10: backup with head.lastHash mismatch → restore FAIL', async () => {
    const p = await seedCompany('br10');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    data.data.journalChainHead!.lastHash = 'ab'.repeat(32);
    await rejectedRestore(p, data, /RESTORE_CHAIN: CHAIN_HEAD_MISMATCH/);
    const head = await headOf(p.companyId);
    expect(head!.lastHash).not.toBe('ab'.repeat(32));
  });

  it('BR11: backup with head.lastEntryId incorrect → restore FAIL', async () => {
    const p = await seedCompany('br11');
    await appendViaTx(p, 'A');
    const data = await buildBackup(p);
    data.data.journalChainHead!.lastEntryId = 'wrong-entry-id';
    await rejectedRestore(p, data, /RESTORE_CHAIN: CHAIN_HEAD_MISMATCH/);
    expect(await headOf(p.companyId)).not.toBeNull();
    expect(await headOf(p.companyId).then((h) => h!.lastEntryId)).not.toBe('wrong-entry-id');
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
    await rejectedRestore(p, data, /RESTORE_CHAIN: CHAIN_HEAD_WITHOUT_MEMBERS/);
    expect(await headOf(p.companyId)).toBeNull();
  });

  it('a v2 snapshot carrying an unsealed POSTED member is refused (MEMBER_HASH_NULL), never restored', async () => {
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
    // zero hashed members → head null in the snapshot; keep it explicit
    data.data.journalChainHead = null;

    await rejectedRestore(p, data, /RESTORE_CHAIN: MEMBER_HASH_NULL/);

    // Nothing was replaced: the unsealed row is still the live state.
    expect(await headOf(p.companyId)).toBeNull();
    // High-water contract (JH2.6, frozen): posted rows without a seal make the
    // chain UNVERIFIABLE (MEMBER_HASH_NULL) — the dataset is not a chain member
    // universe; the verifier surfaces that explicitly, never an empty PASS.
    const verify = await verifyJournalChain(p.companyId);
    expect(verify.valid).toBe(false);
    expect(verify.reasonCode).toBe('MEMBER_HASH_NULL');
  });
});
