/**
 * Wave 6 (zero open items) — first-install restore of a CURRENT-format backup.
 *
 * The reported user flow: create a backup (format 2.1.0) → delete all the data →
 * from the "Sistema vacío detectado" page, restore that same backup. That flow
 * could not succeed:
 *   (1) the route answered 503 unless the operator had exported
 *       BOOTSTRAP_SETUP_TOKEN (a non-technical user cannot),
 *   (2) even with the token, `validateBackup` only admits 1.0.0/1.1.0 and
 *       rejected the 2.1.0 file the running app itself produces,
 *   (3) the route demanded `recoveryPassword` while the page never sent it.
 *
 * The contract pinned here:
 *   - the ONLY admission gate is `companyCount === 0` (checked first): a system
 *     that already has data answers 409 DB_NOT_EMPTY and writes nothing —
 *     no environment token exists any more, so a first install works offline;
 *   - a 2.1.0 backup + a recovery password (min 8 chars) restores through the
 *     coordinated path: session cookie, company/user/account/journal counts
 *     equal to the backup, company administrative membership kept;
 *   - a missing or too-short recovery password answers 400 in Spanish and
 *     leaves the database untouched (nothing created, nothing restored);
 *   - the restored owner logs in with that recovery password and reads their
 *     company back through /api/auth/me (the session really works).
 *
 * The source tenant is exported through the PRODUCTION path (`createBackup`,
 * with `appendEntryToJournalChain` sealing the JH2 tail) and then deleted, so
 * the payload under test is the app's own output and the database is empty —
 * exactly the situation of the reported defect.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createBackup } from '@/lib/backup';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import {
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestJournalEntry,
  createTestUser,
} from '../helpers/factories';
import { POST as bootstrapRestorePOST } from '@/app/api/bootstrap/restore/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as meGET } from '@/app/api/auth/me/route';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';

const RECOVERY_PASSWORD = 'Recuperacion!2026';
const OWNER_EMAIL = 'bootstrap.restore.owner@example.com';
const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');

type CreatedBackup = Awaited<ReturnType<typeof createBackup>>;

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

/** Production export path: snapshot + JH2 seal + published 2.1.0 payload. */
async function createSourceBackup() {
  const owner = await createTestUser(OWNER_EMAIL);
  const company = await createTestCompany('Bootstrap Restore SA');
  await createTestCompanyMember(owner.id, company.id);
  const cash = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const revenue = await createTestGlAccount({
    companyId: company.id,
    code: '4010',
    name: 'Revenue',
    accountType: 'revenue',
    normalBalance: 'credit',
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

  const backup: CreatedBackup = await createBackup(company.id, owner.id);
  publishedBackups.push(backup.filename);
  return { backup, owner, company };
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

async function restoreWithPassword(backup: CreatedBackup, password: string | undefined) {
  return restoreRequest(
    password === undefined ? { data: backup.data } : { data: backup.data, recoveryPassword: password },
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
    entitlements: await db.companyModuleEntitlement.count(),
    sessions: await db.session.count(),
  };
}

describe('POST /api/bootstrap/restore — first-install restore of a 2.1.0 backup', () => {
  let backup: CreatedBackup;
  let sourceCompanyId: string;
  let sourceUserId: string;

  beforeEach(async () => {
    await wipeDatabase();
    const source = await createSourceBackup();
    backup = source.backup;
    sourceCompanyId = source.company.id;
    sourceUserId = source.owner.id;
    currentSourceCompanyId = sourceCompanyId;
    expect(backup.recordCounts.glAccounts).toBe(2);
    expect(backup.recordCounts.journalEntries).toBe(1);
    // The user backs up and then deletes all the data: the system is empty.
    await wipeDatabase();
    expect(await db.company.count()).toBe(0);
  });

  afterEach(() => {
    // The export under test and the safety snapshot the coordinated restore
    // publishes for the same company both land in db/backups.
    collectPublishedBackups(currentSourceCompanyId);
    forgetPublishedBackups();
  });

  it('restores the 2.1.0 backup with a recovery password and opens a session', async () => {
    const response = await restoreWithPassword(backup, RECOVERY_PASSWORD);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // Session cookie: same name/attributes the login route issues in tests.
    const cookie = response.cookies.get('session');
    expect(cookie?.value ?? '').not.toBe('');

    // Data restored exactly as the backup declares it.
    const restored = await countRestored();
    expect(restored.companies).toBe(1);
    expect(restored.users).toBe(backup.recordCounts.users);
    expect(restored.glAccounts).toBe(backup.recordCounts.glAccounts);
    expect(restored.journalEntries).toBe(backup.recordCounts.journalEntries);
    expect(restored.journalLines).toBe(backup.recordCounts.journalLines);
    expect(restored.companyMembers).toBe(backup.recordCounts.companyMembers);
    expect(restored.entitlements).toBe(backup.recordCounts.companyModuleEntitlements);
    expect(restored.sessions).toBe(1);

    const company = await db.company.findUnique({ where: { id: sourceCompanyId } });
    expect(company?.legalName).toBe('Bootstrap Restore SA');
    const membership = await db.companyMember.findFirst({ where: { companyId: sourceCompanyId } });
    expect(membership?.userId).toBe(sourceUserId);
    expect(membership?.role).toBe('company_admin');

    // The first restored user is the installation owner, immediately usable.
    const owner = await db.user.findUnique({ where: { id: sourceUserId } });
    expect(owner?.email).toBe(OWNER_EMAIL);
    expect(owner?.platformRole).toBe('super_admin');
    expect(owner?.legacyUser).toBe(true);
    expect(owner?.emailVerifiedAt).not.toBeNull();

    expect(body.user.id).toBe(sourceUserId);
    expect((body.companies as Array<{ id: string }>).map((c) => c.id)).toContain(sourceCompanyId);
  });

  it('rejects a missing recovery password with a Spanish 400 and writes nothing', async () => {
    const response = await restoreWithPassword(backup, undefined);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(body.error).toBe(es.errors.RECOVERY_PASSWORD_REQUIRED);
    expect(body.error).toMatch(/contraseña/i);
    expect(response.cookies.get('session')).toBeUndefined();

    const untouched = await countRestored();
    expect(untouched.companies).toBe(0);
    expect(untouched.users).toBe(0);
    expect(untouched.glAccounts).toBe(0);
    expect(untouched.journalEntries).toBe(0);
  });

  it('rejects a recovery password shorter than 8 characters and writes nothing', async () => {
    const response = await restoreWithPassword(backup, 'short7!');
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(body.error).toBe(es.errors.RECOVERY_PASSWORD_REQUIRED);

    const untouched = await countRestored();
    expect(untouched.companies).toBe(0);
    expect(untouched.users).toBe(0);
  });

  it('PRESERVE: a system that already has data answers 409 DB_NOT_EMPTY and writes nothing', async () => {
    const existing = await createTestCompany('Already Installed SA');
    const existingUser = await createTestUser('already.installed@example.com');
    await createTestCompanyMember(existingUser.id, existing.id);
    const before = await countRestored();

    // Even a perfectly valid payload must be refused: the empty-system gate is
    // the whole authorization for this endpoint.
    const response = await restoreWithPassword(backup, RECOVERY_PASSWORD);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('DB_NOT_EMPTY');
    expect(response.cookies.get('session')).toBeUndefined();

    const after = await countRestored();
    expect(after).toEqual(before);
    expect(await db.company.findUnique({ where: { id: sourceCompanyId } })).toBeNull();
  });

  it('lets the restored owner log in with the recovery password and read their company', async () => {
    const restored = await restoreWithPassword(backup, RECOVERY_PASSWORD);
    expect(restored.status).toBe(200);

    const login = await loginPOST(
      new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: OWNER_EMAIL, password: RECOVERY_PASSWORD }),
      }),
    );
    const loginBody = await login.json();
    expect(login.status).toBe(200);
    expect(loginBody.user.email).toBe(OWNER_EMAIL);
    expect(
      (loginBody.companies as Array<{ id: string }>).map((c) => c.id),
    ).toContain(sourceCompanyId);

    const token = login.cookies.get('session')?.value as string;
    const me = await meGET(
      new NextRequest('http://localhost/api/auth/me', {
        method: 'GET',
        headers: { cookie: `session=${token}` },
      }),
    );
    const meBody = await me.json();
    expect(me.status).toBe(200);
    expect(meBody.user.id).toBe(sourceUserId);
    expect((meBody.companies as Array<{ id: string }>).map((c) => c.id)).toContain(sourceCompanyId);
  });

  it('restores from the multipart upload the page actually sends (file + recoveryPassword)', async () => {
    const formData = new FormData();
    const snapshot = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8')) as unknown;
    formData.append(
      'file',
      new File([JSON.stringify(snapshot)], 'bootstrap-restore.json', { type: 'application/json' }),
    );
    formData.append('recoveryPassword', RECOVERY_PASSWORD);

    const response = await bootstrapRestorePOST(
      new NextRequest('http://localhost/api/bootstrap/restore', { method: 'POST', body: formData }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(response.cookies.get('session')?.value ?? '').not.toBe('');
    expect(await db.glAccount.count()).toBe(backup.recordCounts.glAccounts);
  });

  it('PRESERVE: multipart upload keeps the extension guard and writes nothing', async () => {
    const formData = new FormData();
    formData.append('file', new File(['{}'], 'backup.txt', { type: 'text/plain' }));
    formData.append('recoveryPassword', RECOVERY_PASSWORD);

    const response = await bootstrapRestorePOST(
      new NextRequest('http://localhost/api/bootstrap/restore', { method: 'POST', body: formData }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Extensión inválida. Solo archivos .json y .backup');
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  it('translates the bootstrap error codes in both locales', () => {
    for (const code of ['RECOVERY_PASSWORD_REQUIRED']) {
      const esText = (es.errors as Record<string, string>)[code];
      const enText = (en.errors as Record<string, string>)[code];
      expect(typeof esText, `${code} [es]`).toBe('string');
      expect(typeof enText, `${code} [en]`).toBe('string');
      expect(esText.trim().length).toBeGreaterThan(0);
      expect(enText.trim().length).toBeGreaterThan(0);
      expect(enText).not.toBe(esText);
    }
  });
});
