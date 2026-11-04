/**
 * S6 (Wave 5, part 1) — backup retention.
 *
 * Finding: nothing ever removed a published backup file, and every restore
 * stamps an EXTRA safety snapshot next to the regular ones, so an installed
 * instance grew without bound.
 *
 * Contract pinned here, all through the public publish/prune path:
 *  (1) `BACKUP_RETENTION_COUNT` (default 20) bounds the files kept per company;
 *      the newest full backup of every company is never removed. The policy runs
 *      at publish time, i.e. exactly when the growth happens.
 *  (2) `BACKUP_RETENTION_DAYS` (default 90) removes a company's older backups by
 *      age; 0 explicitly disables the age rule.
 *  (3) A file a recovery journal names as its `safetyFilename` is NEVER pruned
 *      (safety snapshots are excluded from pruning entirely — the
 *      journal/receipt coupling is not re-derived here). If the journal
 *      directory exists but a journal cannot be read, pruning is skipped
 *      wholesale instead of guessing which rollback image is disposable.
 *  (4) `pruneBackups()` reports what it removed and rewrites the catalog cache;
 *      `runBackupRetention()` (the maintenance-cycle entry point) records a
 *      BACKUP_PRUNED audit row per company with the filenames in its details.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPANY_BACKUP_VERSION, SNAPSHOT_SECTIONS, sealSnapshot } from '@/lib/backup-format';
import type { BackupData } from '@/lib/backup';
import { db } from '@/lib/db';
import { clearDatabase, createTestCompany, createTestCompanyMember, createTestUser } from '../helpers/factories';

// The storage roots are resolved once, at module load of src/lib/config/paths.
// A private data root in the system temp directory keeps every file this suite
// publishes out of the worktree, and is removed in afterAll.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-backup-retention-'));
const previousDataRoot = process.env.ACCOUNTEXPRESS_DATA_DIR;

let storage: typeof import('@/lib/backup-storage');
let runtime: typeof import('@/lib/backup-runtime-maintenance');
let paths: typeof import('@/lib/config/paths');

beforeAll(async () => {
  process.env.ACCOUNTEXPRESS_DATA_DIR = dataRoot;
  paths = await import('@/lib/config/paths');
  storage = await import('@/lib/backup-storage');
  runtime = await import('@/lib/backup-runtime-maintenance');
});

afterAll(() => {
  if (previousDataRoot === undefined) delete process.env.ACCOUNTEXPRESS_DATA_DIR;
  else process.env.ACCOUNTEXPRESS_DATA_DIR = previousDataRoot;
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const TENANT = 'retention-tenant';
const OTHER_TENANT = 'retention-other';
const journalDirectory = () => path.join(path.dirname(paths.RUNTIME_FILES.companyConfig), 'backup-recovery');

function resetStorage(): void {
  delete process.env.BACKUP_RETENTION_COUNT;
  delete process.env.BACKUP_RETENTION_DAYS;
  fs.rmSync(paths.BACKUP_DIR, { recursive: true, force: true });
  fs.rmSync(journalDirectory(), { recursive: true, force: true });
}

/** A minimal but fully valid 2.1.0 snapshot, sealed exactly like a real export. */
function snapshotText(options: { companyId: string; createdAt: string }): string {
  const data: Record<string, unknown> = {
    company: [{ id: options.companyId }],
    systemConfig: [],
    companyConfig: null,
  };
  for (const section of SNAPSHOT_SECTIONS) if (!(section in data)) data[section] = [];
  const recordCounts: Record<string, number> = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((section) => [section, (data[section] as unknown[]).length]),
  );
  recordCounts.companyConfig = false;
  const snapshot = {
    manifest: {
      version: COMPANY_BACKUP_VERSION,
      id: crypto.randomUUID(),
      createdAt: options.createdAt,
      companyId: options.companyId,
      companyInfo: { id: options.companyId, legalName: 'Retention Tenant', taxId: null },
      recordCounts,
      fidelity: { monetary: 'decimal-18,2', jsonNulls: [] },
    },
    data,
  } as unknown as BackupData;
  sealSnapshot(snapshot);
  return JSON.stringify(snapshot, null, 2);
}

/** Publish one backup through the public path; returns its filename. */
function publish(companyId: string, createdAt: string): string {
  const filename = `${companyId}_${crypto.randomUUID()}.json`;
  storage.publishBackup(filename, snapshotText({ companyId, createdAt }));
  return filename;
}

const MINUTE = 60_000;
/** Oldest-first creation timestamps, so publication order matches age order. */
function agedTimestamps(count: number, options: { newestAgeMs?: number } = {}): string[] {
  const newest = Date.now() - (options.newestAgeMs ?? 0);
  return Array.from({ length: count }, (_, index) =>
    new Date(newest - (count - 1 - index) * MINUTE).toISOString());
}

function publishedFiles(): string[] {
  return fs.existsSync(paths.BACKUP_DIR)
    ? fs.readdirSync(paths.BACKUP_DIR).filter((name) => name.endsWith('.json') && name !== 'manifest.json').sort()
    : [];
}

/** A recovery journal referencing `safetyFilename`, shaped like the real contract. */
function writeRecoveryJournal(safetyFilename: string): string {
  const operationId = crypto.randomUUID();
  fs.mkdirSync(journalDirectory(), { recursive: true });
  fs.writeFileSync(path.join(journalDirectory(), `${operationId}.json`), JSON.stringify({
    version: 1,
    payload: {
      operationId,
      companyId: TENANT,
      checksum: 'a'.repeat(64),
      files: [],
      safetyFilename,
    },
    digest: 'b'.repeat(64),
  }));
  return operationId;
}

describe('S6 (1) — retention bounds growth at publish time', () => {
  beforeEach(resetStorage);

  it('keeps the default 20 newest backups per company and removes the rest', () => {
    const timestamps = agedTimestamps(23);
    const filenames = timestamps.map((createdAt) => publish(TENANT, createdAt));

    // Retention runs on every publish, so the directory never holds more than
    // the policy allows: the three oldest snapshots are already gone.
    expect(publishedFiles()).toHaveLength(20);
    for (const removed of filenames.slice(0, 3)) expect(publishedFiles()).not.toContain(removed);
    for (const kept of filenames.slice(3)) expect(publishedFiles()).toContain(kept);
    // The newest full backup survives unconditionally.
    expect(publishedFiles()).toContain(filenames[filenames.length - 1]!);
    // The catalog cache follows the files instead of listing ghosts.
    const catalog = storage.readCatalog();
    expect(catalog.backups).toHaveLength(20);
    expect(catalog.backups.map((entry) => entry.filename).sort()).toEqual(publishedFiles());
  });

  it('honours BACKUP_RETENTION_COUNT and reports exactly what it pruned', () => {
    process.env.BACKUP_RETENTION_DAYS = '0'; // age rule off while seeding
    const filenames = agedTimestamps(5).map((createdAt) => publish(TENANT, createdAt));

    process.env.BACKUP_RETENTION_COUNT = '2';
    const result = storage.pruneBackups();

    expect(result.policy).toEqual({ count: 2, days: 0 });
    expect(result.unknownSafetyState).toBe(false);
    expect(result.retained).toBe(2);
    expect([...result.pruned.map((entry) => entry.filename)].sort())
      .toEqual([filenames[0]!, filenames[1]!, filenames[2]!].sort());
    expect(publishedFiles()).toEqual([filenames[3]!, filenames[4]!].sort());
    // Nothing was pruned twice: a second run is a no-op.
    expect(storage.pruneBackups().pruned).toEqual([]);
  });

  it('PRESERVE — a directory inside both limits is left untouched', () => {
    const filenames = agedTimestamps(3).map((createdAt) => publish(TENANT, createdAt));
    const result = storage.pruneBackups();

    expect(result.pruned).toEqual([]);
    expect(result.retained).toBe(3);
    expect(publishedFiles()).toEqual([...filenames].sort());
  });
});

describe('S6 (1) — age policy', () => {
  beforeEach(resetStorage);

  it('removes backups older than BACKUP_RETENTION_DAYS without touching the newest', () => {
    process.env.BACKUP_RETENTION_DAYS = '0'; // age rule off while seeding
    const now = Date.now();
    const stale = publish(TENANT, new Date(now - 120 * 86_400_000).toISOString());
    const fresh = publish(TENANT, new Date(now - 40 * 86_400_000).toISOString());
    const newest = publish(TENANT, new Date(now).toISOString());

    process.env.BACKUP_RETENTION_DAYS = '90';
    const result = storage.pruneBackups();

    expect(result.policy).toEqual({ count: 20, days: 90 });
    expect(result.pruned.map((entry) => entry.filename)).toEqual([stale]);
    expect(publishedFiles()).toEqual([fresh, newest].sort());
  });

  it('never prunes the newest backup of a company even when it is older than the limit', () => {
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const only = publish(TENANT, ancient);

    const result = storage.pruneBackups();

    expect(result.pruned).toEqual([]);
    expect(publishedFiles()).toEqual([only]);
  });
});

describe('S6 (1) — safety snapshots and per-company isolation', () => {
  beforeEach(resetStorage);

  it('never prunes a snapshot a recovery journal names as its safety image', () => {
    process.env.BACKUP_RETENTION_DAYS = '0';
    const filenames = agedTimestamps(4).map((createdAt) => publish(TENANT, createdAt));
    const safety = filenames[0]!; // oldest: the first candidate for pruning
    writeRecoveryJournal(safety);

    process.env.BACKUP_RETENTION_COUNT = '2';
    const result = storage.pruneBackups();

    // Newest first, so the count limit reaches the two OLDEST files; the one a
    // journal protects survives and only its sibling is removed.
    expect(result.pruned.map((entry) => entry.filename)).toEqual([filenames[1]!]);
    expect(result.safetyProtected).toBe(1);
    expect(publishedFiles()).toContain(safety); // rollback image retained
    expect(publishedFiles()).toEqual([safety, filenames[2]!, filenames[3]!].sort());
  });

  it('skips pruning entirely when a recovery journal cannot be read', () => {
    process.env.BACKUP_RETENTION_DAYS = '0';
    const filenames = agedTimestamps(3).map((createdAt) => publish(TENANT, createdAt));
    fs.mkdirSync(journalDirectory(), { recursive: true });
    fs.writeFileSync(path.join(journalDirectory(), `${crypto.randomUUID()}.json`), '{ not json');

    process.env.BACKUP_RETENTION_COUNT = '1';
    const result = storage.pruneBackups();

    expect(result.unknownSafetyState).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(publishedFiles()).toEqual([...filenames].sort());
  });

  it('applies the policy per company instead of across the whole directory', () => {
    process.env.BACKUP_RETENTION_DAYS = '0';
    const mine = agedTimestamps(2).map((createdAt) => publish(TENANT, createdAt));
    const theirs = agedTimestamps(2).map((createdAt) => publish(OTHER_TENANT, createdAt));

    process.env.BACKUP_RETENTION_COUNT = '1';
    const result = storage.pruneBackups();

    // Each tenant keeps its own newest snapshot; the other tenant's file is not
    // counted against this one.
    expect(result.pruned.map((entry) => entry.filename).sort())
      .toEqual([mine[0]!, theirs[0]!].sort());
    expect(publishedFiles()).toEqual([mine[1]!, theirs[1]!].sort());
  });
});

describe('S6 (1) — the maintenance cycle audits every prune', () => {
  // A real tenant row so the shared clearDatabase helper (which scopes by test
  // membership) removes the audit rows this suite writes.
  async function auditedCompany(name: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await createTestUser(`wave5-s6-${stamp}@example.com`);
    const company = await createTestCompany(name);
    await createTestCompanyMember(user.id, company.id);
    return company;
  }

  beforeEach(async () => {
    resetStorage();
    await clearDatabase();
  });

  afterAll(async () => {
    await clearDatabase();
  });

  it('records BACKUP_PRUNED with the pruned filenames', async () => {
    const company = await auditedCompany('wave5-s6-retention');
    const filenames = agedTimestamps(3).map((createdAt) => publish(company.id, createdAt));

    process.env.BACKUP_RETENTION_COUNT = '1';
    const result = await runtime.runBackupRetention();

    expect(result.pruned.map((entry) => entry.filename).sort())
      .toEqual([filenames[0]!, filenames[1]!].sort());

    const audits = await db.auditLog.findMany({ where: { action: 'BACKUP_PRUNED' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.companyId).toBe(company.id);
    expect(audits[0]!.entity).toBe('Backup');
    const details = JSON.parse(audits[0]!.details ?? '{}');
    expect(details.filenames.sort()).toEqual([filenames[0]!, filenames[1]!].sort());
    expect(details.policy).toEqual({ count: 1, days: 90 });
    expect(publishedFiles()).toEqual([filenames[2]!]);
  });

  it('writes no audit row when there is nothing to prune', async () => {
    const company = await auditedCompany('wave5-s6-retention-noop');
    publish(company.id, new Date().toISOString());

    const result = await runtime.runBackupRetention();

    expect(result.pruned).toEqual([]);
    expect(await db.auditLog.count({ where: { action: 'BACKUP_PRUNED' } })).toBe(0);
  });
});
