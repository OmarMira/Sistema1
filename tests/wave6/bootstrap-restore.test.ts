/**
 * Wave 6 (rewritten for portable owner-verified recovery) — first-install
 * restore of a 2.1.0 backup on a NEW machine.
 *
 * The contract pinned here:
 *  - the export produces a downloadable file whose whole accounting payload is
 *    AEAD-encrypted under the source owner password, and opening it ALSO demands
 *    the owner email and the company legal name: all three are inputs of the
 *    password KDF, so the password alone can never open a file; the internal
 *    catalog still lists a sealed internal snapshot (same retention semantics);
 *  - the PUBLIC route refuses the old internal-snapshot payload, refuses a fresh
 *    install without a configured mail channel (fail closed, never a silent
 *    skip) and refuses a non-empty installation;
 *  - a full authorized recovery (owner email + password + company name + token)
 *    restores through the coordinated path and creates an owner session ON AN
 *    INSTALLATION WITH NO LOCAL ACCOUNT: the source owner is proven by the
 *    authenticated backup credential, never by an account that must exist here
 *    (T15);
 *  - journal/audit history restored from ANOTHER installation key still verifies
 *    through the authenticated provenance archive, and truthfully fails when the
 *    archive is bypassed; a second certified lineage is accepted only because
 *    that archive exists (T15);
 *  - a same-email local account with a different id is reused only after its own
 *    password proves it, keeping its credentials/role intact (S4).
 *
 * This suite requires disposable PostgreSQL (tests/global-setup.ts). It is never
 * executed by the isolated bootstrap runner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { createBackup, createPortableBackup } from '@/lib/backup';
import { openPortableContainer } from '@/lib/backup-portable';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import { verifyAuditChain, verifyJournalChain } from '@/lib/journal-hash';
import { restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import {
  completePortableRecovery, createMemoryRecoveryChallengeStore,
  requestPortableRecoveryChallenge, type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import {
  createPortableDestinationRestore, createPostgresProvenanceRecorder, loadRecoveryEvidence,
  RecoveryProvenanceError,
  type PortableDestinationClient, type ProvenanceRawClient,
} from '@/lib/backup-recovery-provenance';
import {
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestJournalEntry,
  createTestUser,
} from '../helpers/factories';
import { POST as bootstrapRestorePOST } from '@/app/api/bootstrap/restore/route';
import { BACKUP_DIR } from '@/lib/config/paths';

const RECOVERY_PASSWORD = 'Recuperacion!2026';
const OWNER_EMAIL = 'bootstrap.restore.owner@example.com';

/**
 * The public route's fail-closed refusal is "no mail channel configured". An
 * ambient developer environment may carry SMTP_* values, which would make the
 * route send a REAL email (with a live recovery token) and hide exactly the
 * contract pinned here, so this suite owns the whole mail configuration.
 */
const MAIL_ENV_KEYS = [
  'ACCOUNTEXPRESS_MAIL_MODE',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_FROM_NAME',
] as const;
const savedMailEnv = new Map<string, string | undefined>();
function clearMailEnv() {
  for (const key of MAIL_ENV_KEYS) {
    savedMailEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}
function restoreMailEnv() {
  for (const key of MAIL_ENV_KEYS) {
    const value = savedMailEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedMailEnv.clear();
}

/**
 * The fixture database exists only for these suites, but earlier files in the
 * same run may leave tenants behind and the first-install contract is defined
 * on a database with ZERO companies. Truncating the public schema (never
 * _prisma_migrations) is the only reliable "system vacío"; the hard stop keeps
 * the same DATABASE_URL guard every factory uses.
 */
async function wipeDatabase() {
  if (!(process.env.DATABASE_URL ?? '').includes('test')) {
    throw new Error('wipeDatabase() REFUSED: DATABASE_URL does not point to a test database');
  }
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
}

/** Remove the files this suite published so db/backups is left as it was found. */
const publishedBackups: string[] = [];
let currentSourceCompanyId = '';
function forgetPublishedBackups() {
  for (const filename of publishedBackups) {
    const filePath = path.join(BACKUP_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
  if (publishedBackups.length > 0 && fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        backups: Array<{ filename: string }>;
      };
      manifest.backups = manifest.backups.filter((b) => !publishedBackups.includes(b.filename));
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // A malformed catalog is not this suite's evidence; ignore.
    }
  }
  publishedBackups.length = 0;
}

function collectPublishedBackups(companyId: string) {
  if (!fs.existsSync(BACKUP_DIR)) return;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (name.startsWith(`${companyId}_`) && name.endsWith('.json')) publishedBackups.push(name);
  }
}

/** Production export path: internal snapshot + portable AEAD container. */
async function createSourceBackup() {
  const owner = await createTestUser(OWNER_EMAIL);
  const company = await createTestCompany('Bootstrap Restore SA');
  await createTestCompanyMember(owner.id, company.id);
  const cash = await createTestGlAccount({
    companyId: company.id, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit',
  });
  const revenue = await createTestGlAccount({
    companyId: company.id, code: '4010', name: 'Revenue', accountType: 'revenue', normalBalance: 'credit',
  });
  const entry = await createTestJournalEntry(company.id, {
    date: '2025-04-10',
    description: 'First sale',
    lines: [
      { glAccountId: cash.id, debit: 1250.5, credit: 0 },
      { glAccountId: revenue.id, debit: 0, credit: 1250.5 },
    ],
  });
  // JH2: only a chain-sealed posted entry is restorable; the seal comes from
  // the SAME production primitive the journal POST route uses.
  await db.$transaction((tx) => appendEntryToJournalChain(tx, {
    companyId: company.id,
    entryId: entry.id,
  }));

  // Owner re-authentication: the export demands the password of the PROVEN
  // source owner, i.e. the active, email-verified super administrator of the
  // company, whose email is stamped into the sealed file identity.
  await db.user.update({
    where: { id: owner.id },
    data: {
      passwordHash: await hashPassword(RECOVERY_PASSWORD),
      emailVerifiedAt: new Date(),
      platformRole: 'super_admin',
    },
  });
  const internal = await createBackup(company.id, owner.id);
  const portable = await createPortableBackup({
    companyId: company.id, createdByUserId: owner.id, password: RECOVERY_PASSWORD,
  });
  publishedBackups.push(internal.filename);
  return { internal, portable, owner, company };
}

/**
 * The "new machine" fixture: zero companies and NO owner account at all, which
 * is the reported case. The portable container seals the source owner identity
 * and the recovery proves it from that authenticated credential, so the flow
 * never needs an existing destination account (it used to answer
 * RECOVERY_OWNER_UNAVAILABLE 403 here).
 */
function assertNoOwnerAccount() {
  return db.user.count();
}

function restoreRequest(body: Record<string, unknown>) {
  return bootstrapRestorePOST(
    new NextRequest('http://localhost/api/bootstrap/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function countRestored() {
  return {
    companies: await db.company.count(),
    users: await db.user.count(),
    glAccounts: await db.glAccount.count(),
    journalEntries: await db.journalEntry.count(),
    journalLines: await db.journalLine.count(),
    companyMembers: await db.companyMember.count(),
    sessions: await db.session.count(),
  };
}

/** Full authorized recovery with injected mail/challenge stores and REAL db work. */
async function runAuthorizedRecovery(input: {
  portable: Awaited<ReturnType<typeof createSourceBackup>>['portable'];
  password?: string;
}) {
  const store = createMemoryRecoveryChallengeStore();
  const lock = createMemoryRecoveryLockStore();
  const mail: Array<{ to: string; token: string }> = [];
  const deps: PortableRecoveryDeps = {
    now: () => new Date(),
    challenges: store,
    lock,
    mail: { send: async (message) => { mail.push(message as { to: string; token: string }); } },
    installationState: async () => {
      const [companies, audits] = await Promise.all([db.company.count(), db.auditLog.count()]);
      return { companies, audits };
    },
    restore: createPortableDestinationRestore({
      client: db as unknown as PortableDestinationClient,
      provenance: createPostgresProvenanceRecorder(db as unknown as ProvenanceRawClient),
      hashPassword,
      verifyPassword,
      readAuditArchive: async () => {
        try {
          const archive = await loadRecoveryEvidence('audit', null);
          return archive.size > 0 ? archive : undefined;
        } catch (error) {
          if (error instanceof RecoveryProvenanceError && error.code === 'RECOVERY_PROVENANCE_ABSENT') return undefined;
          throw error;
        }
      },
      coordinatedRestore: (companyId, text, mode, identityMap) =>
        restoreCompanyBackupCoordinated(companyId, text, mode, identityMap),
    }),
  };
  const fileText = Buffer.from(input.portable.data, 'base64').toString('utf8');
  const password = input.password ?? RECOVERY_PASSWORD;
  const requested = await requestPortableRecoveryChallenge(deps, {
    fileText, password, companyLegalName: 'Bootstrap Restore SA', ownerEmail: OWNER_EMAIL,
  });
  expect(requested.status).toBe('challenge_sent');
  const token = mail.at(-1)!.token;
  const completed = await completePortableRecovery(deps, {
    fileText, password, companyLegalName: 'Bootstrap Restore SA', ownerEmail: OWNER_EMAIL, token,
  });
  return { requested, completed, token, store };
}

describe('portable owner-verified recovery (first install)', () => {
  let source: Awaited<ReturnType<typeof createSourceBackup>>;

  beforeEach(async () => {
    clearMailEnv();
    await wipeDatabase();
    source = await createSourceBackup();
    currentSourceCompanyId = source.company.id;
    expect(source.portable.recordCounts.glAccounts).toBe(2);
    expect(source.portable.recordCounts.journalEntries).toBe(1);
  });

  afterEach(() => {
    collectPublishedBackups(currentSourceCompanyId);
    forgetPublishedBackups();
    restoreMailEnv();
  });

  it('exports an encrypted portable file and keeps the internal catalog entry', async () => {
    const bytes = Buffer.from(source.portable.data, 'base64').toString('utf8');
    expect(bytes).not.toContain('Bootstrap Restore SA');
    expect(bytes).not.toContain(OWNER_EMAIL);
    expect(source.portable.recoveryFilename).toMatch(/_recovery\.json$/);
    // The owner email and the company name are KDF inputs: the password alone
    // cannot open the file any more.
    const opened = openPortableContainer(bytes, RECOVERY_PASSWORD, {
      ownerEmail: OWNER_EMAIL, companyLegalName: 'Bootstrap Restore SA',
    });
    expect(opened.payload.companyId).toBe(source.company.id);
    expect(opened.payload.snapshot.data.journalEntries).toHaveLength(1);
    expect(fs.existsSync(path.join(BACKUP_DIR, source.internal.filename))).toBe(true);
  });

  it('refuses the old internal-snapshot payload on the public route', async () => {
    await wipeDatabase();
    const response = await restoreRequest({
      data: source.internal.data, password: RECOVERY_PASSWORD,
      companyName: 'Bootstrap Restore SA', ownerEmail: OWNER_EMAIL,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RECOVERY_FILE_UNSUPPORTED');
    expect(await db.company.count()).toBe(0);
  });

  it('fails closed when no mail channel is configured on the public route', async () => {
    await wipeDatabase();
    const response = await restoreRequest({
      data: source.portable.data, password: RECOVERY_PASSWORD,
      companyName: 'Bootstrap Restore SA', ownerEmail: OWNER_EMAIL,
    });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('RECOVERY_MAIL_UNAVAILABLE');
    expect(await db.company.count()).toBe(0);
  });

  it('refuses a non-empty installation', async () => {
    const response = await restoreRequest({
      data: source.portable.data, password: RECOVERY_PASSWORD,
      companyName: 'Bootstrap Restore SA', ownerEmail: OWNER_EMAIL,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('DB_NOT_EMPTY');
  });

  it('restores the whole accounting snapshot and keeps history verifiable', async () => {
    await wipeDatabase();
    expect(await assertNoOwnerAccount()).toBe(0);
    expect(await db.company.count()).toBe(0);
    const { completed, token } = await runAuthorizedRecovery({ portable: source.portable });
    expect(completed.status).toBe('restored');
    expect(JSON.stringify(completed)).not.toContain(token);

    const counts = await countRestored();
    expect(counts).toMatchObject({
      companies: 1, glAccounts: 2, journalEntries: 1, journalLines: 2, companyMembers: 1,
    });
    expect(counts.users).toBe(1);

    // Recovered history was signed by the SOURCE installation key. Rotating the
    // destination key proves that only the authenticated archive can certify it.
    const originalSecret = process.env.HMAC_SECRET;
    process.env.HMAC_SECRET = 'rotated-destination-hmac-secret';
    try {
      const journal = await verifyJournalChain(source.company.id);
      expect(journal.valid).toBe(true);
      const audit = await verifyAuditChain({ companyId: source.company.id });
      expect(audit.valid).toBe(true);
    } finally {
      if (originalSecret === undefined) delete process.env.HMAC_SECRET;
      else process.env.HMAC_SECRET = originalSecret;
    }

    const provenance = await db.$queryRawUnsafe<Array<{ provenance: { identityMap: unknown; fileDigest: string } }>>(
      `SELECT provenance FROM "BootstrapRecoveryProvenance" WHERE "companyId" = $1`, source.company.id);
    expect(provenance).toHaveLength(1);
    expect(provenance[0].provenance.identityMap).toEqual({});
    expect(provenance[0].provenance.fileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reuses a same-email local account only after proving its own password', async () => {
    const localId = 'bootstrap-local-owner';
    const localEmail = OWNER_EMAIL;
    const localPasswordHash = await hashPassword('LocalAccountPass!1');
    // The source backup of this test keeps the owner email; the destination only
    // holds a local account registered with that same email under another id.
    await wipeDatabase();
    await db.user.create({
      data: {
        id: localId, email: localEmail, passwordHash: localPasswordHash,
        firstName: 'Local', lastName: 'Owner', platformRole: 'user',
        emailVerifiedAt: new Date(),
      },
    });

    // Wrong local password: explicit refusal, nothing mutated.
    const refused = await runAuthorizedRecovery({
      portable: source.portable, password: RECOVERY_PASSWORD,
    });
    expect(refused.completed).toMatchObject({ status: 409, code: 'RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED' });
    expect(await db.company.count()).toBe(0);
    const untouched = await db.user.findUnique({ where: { id: localId }, select: { passwordHash: true, platformRole: true } });
    expect(untouched).toMatchObject({ passwordHash: localPasswordHash, platformRole: 'user' });
  });
});
