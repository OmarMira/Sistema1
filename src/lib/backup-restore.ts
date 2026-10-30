import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { withCompanyBackupTransaction } from '@/lib/db';
import { captureCompanySnapshot, type BackupData, type BackupManifest, type CompanySnapshotClient } from './backup';
import { sealSnapshot } from './backup-format';
import { publishBackup, readCompanyConfig } from './backup-storage';
import {
  RESTORE_MODELS, delegate, identity, sameConfig, scalarData,
  validateRestoreSource, validateRestoreDestination, type Tables,
} from './backup-validation';

export interface CompanyRestorePreview {
  readonly companyId: string;
  readonly checksum: string;
  readonly counts: Readonly<BackupManifest['recordCounts']>;
  readonly ids: Readonly<Record<string, readonly string[]>>;
  readonly blockers: readonly string[];
  readonly scope: 'database-only; runtime configuration and external assets are not written';
}
export interface CompanyRestoreResult {
  status: 'committed' | 'not_confirmed';
  scope: 'database-only';
  operationId: string;
  safetyFilename: string;
  counts?: BackupManifest['recordCounts'];
  /** A transaction transport failure may mean COMMIT succeeded. Never auto-retry. */
  error?: string;
}

async function readDestination(tx: CompanySnapshotClient): Promise<Tables> {
  const tables: Tables = {};
  for (const model of Object.values(RESTORE_MODELS)) {
    if (model === 'SystemConfig') { tables[model] = []; continue; }
    // Do not even read shared-user credentials or security fields.
    const select = model === 'User' ? { id: true, email: true } : undefined;
    const reader = tx[delegate(model) as keyof typeof tx] as unknown as {
      findMany(query: unknown): Promise<Tables[string]>;
    };
    tables[model] = await reader.findMany({ ...(select ? { select } : {}) });
  }
  tables.JournalChainHead = await tx.journalChainHead.findMany();
  return tables;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function blockers(snapshot: ReturnType<typeof validateRestoreSource>['snapshot'], config: unknown, destination: Tables): string[] {
  const result: string[] = [];
  if (!sameConfig(snapshot.data.companyConfig, config)) result.push('RESTORE_FILES_REQUIRED: target company configuration differs; coordinated file recovery is not implemented');
  if (snapshot.data.company[0].logo || destination.Company[0]?.logo) result.push('RESTORE_ASSETS_REQUIRED: source/destination company logo bytes are not in v2');
  return result;
}

/**
 * Read-only, destination-aware preview. Does not authorize a later restore:
 * restore repeats every check under its own transaction/locks. Caller must
 * authorize the exact company; this module does not establish sessions/RBAC.
 */
export async function previewCompanyRestore(companyId: string, text: string): Promise<CompanyRestorePreview> {
  const source = validateRestoreSource(companyId, text);
  const destination = await withCompanyBackupTransaction(async tx =>
    validateRestoreDestination(source.tables, await readDestination(tx), companyId),
  { isolationLevel: 'RepeatableRead' });
  return frozen({ companyId, checksum: source.snapshot.manifest.integrity!.digest,
    counts: source.snapshot.manifest.recordCounts,
    ids: Object.fromEntries(Object.entries(RESTORE_MODELS).map(([section, model]) => [section, source.tables[model].map(identity)])),
    blockers: blockers(source.snapshot, readCompanyConfig(companyId), destination),
    scope: 'database-only; runtime configuration and external assets are not written' as const });
}

/**
 * Actual v2 database replacement, intentionally NOT wired to legacy/bootstrap
 * routes. File-changing recoveries fail closed, rather than pretending a DB
 * transaction is a distributed DB/JSON/files transaction. No delayed file jobs
 * or replay exist, so a later configuration edit can never be overwritten here.
 *
 * Cooperating restores serialize across processes via PostgreSQL advisory and
 * Company row locks. Serializable isolation protects the read-set/replacement
 * from conflicting DB writers; serialization errors are surfaced, never retried.
 * Ordinary runtime file writers do not cooperate: configuration equality is a
 * prerequisite check, NOT proof of a coordinated filesystem snapshot.
 */
export async function restoreCompanyBackup(companyId: string, text: string): Promise<CompanyRestoreResult> {
  const source = validateRestoreSource(companyId, text);
  const operationId = crypto.randomUUID();
  let safetyFilename = '';
  let mutationStarted = false;
  try {
    await withCompanyBackupTransaction(async tx => {
      // Parameterized server-side, transaction-scoped lock; no process mutex.
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${companyId}, 729104))`);
      const companies = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`);
      if (companies.length !== 1) throw new Error('RESTORE_IDENTITY: destination company missing');
      const current = await readDestination(tx);
      const owned = validateRestoreDestination(source.tables, current, companyId);
      const config = readCompanyConfig(companyId);
      const refused = blockers(source.snapshot, config, owned);
      if (refused.length) throw new Error(refused.join('; '));
      // The same existing snapshot builder enforces export inventory, graph
      // ownership and user-secret exclusion. Every read is in this transaction.
      const safety = await captureCompanySnapshot(tx, companyId, config);
      sealSnapshot(safety.backupData);
      const safetyText = JSON.stringify(safety.backupData, null, 2);
      validateRestoreSource(companyId, safetyText);
      publishBackup(safety.filename, safetyText);
      safetyFilename = safety.filename;
      // Recheck observed config changes before writes; this is deliberately not
      // described as a lock or crash-consistent cross-resource guarantee.
      if (!sameConfig(config, readCompanyConfig(companyId))) throw new Error('RESTORE_FILES_REQUIRED: configuration changed during safety publication');
      mutationStarted = true;
      await replaceRows(tx, source.tables, owned, companyId, source.snapshot);
      const head = source.snapshot.data.journalChainHead;
      if (head) await tx.journalChainHead.create({ data: head });
      // Durable commit evidence, atomic with replacement. Unsigned operational
      // event, not a fabricated accounting-chain signature. It is NOT a claim
      // that external files were restored. No auto-recovery replay consumes it.
      await tx.auditLog.create({ data: {
        id: operationId, companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
        entity: 'Backup', entityId: source.snapshot.manifest.id,
        details: JSON.stringify({ scope: 'database-only', safetyFilename,
          checksum: source.snapshot.manifest.integrity!.digest }),
      } });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000 });
    return { status: 'committed', scope: 'database-only', operationId, safetyFilename, counts: source.snapshot.manifest.recordCounts };
  } catch (error) {
    if (!mutationStarted) throw error; // Invalid input/publication failure: no DB writes started.
    return { status: 'not_confirmed', scope: 'database-only', operationId, safetyFilename,
      error: `Database outcome not confirmed; do not auto-retry or replay files. Inspect commit receipt ${operationId} and safety backup. ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function replaceRows(tx: CompanySnapshotClient, source: Tables, owned: Tables, companyId: string, snapshot: BackupData): Promise<void> {
  // The schema's two nullable self-references need a separate unlink/link pass.
  // Validation has already rejected foreign inbound references and cycles.
  for (const [model, field] of [['GlAccount', 'parentId'], ['CompanyKnowledge', 'mergedIntoId']]) {
    for (const row of owned[model]) {
      if (row[field] != null) await modelWriter(tx, model).update({ where: { id: row.id }, data: { [field]: null } });
    }
  }
  await tx.journalChainHead.deleteMany({ where: { companyId } });
  const models = Object.values(RESTORE_MODELS).filter(m => !['Company', 'User', 'SystemConfig'].includes(m));
  for (const model of [...models].reverse()) {
    if (!owned[model].length) continue;
    const key = model === 'DetectionConfig' ? 'companyId' : 'id';
    await modelWriter(tx, model).deleteMany({ where: { [key]: { in: owned[model].map(row => row[key]) } } });
  }
  await tx.company.update({ where: { id: companyId }, data: scalarData('Company', source.Company[0], snapshot) as Prisma.CompanyUncheckedUpdateInput });
  for (const model of models) {
    for (const row of source[model]) {
      const data = scalarData(model, row, snapshot);
      if (model === 'GlAccount') data.parentId = null;
      if (model === 'CompanyKnowledge') data.mergedIntoId = null;
      await modelWriter(tx, model).create({ data });
    }
  }
  for (const [model, field] of [['GlAccount', 'parentId'], ['CompanyKnowledge', 'mergedIntoId']]) {
    for (const row of source[model]) {
      if (row[field] != null) await modelWriter(tx, model).update({ where: { id: row.id }, data: { [field]: row[field] } });
    }
  }
}

// Dynamic access is isolated here; inventory/schema validation occurs before
// this writer is ever used. No arbitrary backup-controlled model names.
function modelWriter(tx: CompanySnapshotClient, model: string) {
  return tx[delegate(model) as keyof typeof tx] as unknown as {
    update(query: unknown): Promise<unknown>;
    create(query: unknown): Promise<unknown>;
    deleteMany(query: unknown): Promise<unknown>;
  };
}
