if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';
import path from 'node:path';
import { RUNTIME_FILES } from './config/paths';
import { createMaintenanceGate } from './backup-maintenance.mjs';
import { createRecoveryJournal, readRecoveryJournal } from './backup-recovery-journal';
import { recoveryFileImage, companyConfigImage, reconcileRecoveryFiles } from './backup-recovery-files';
import { planCompanyLogo, validateCompanyLogo, companyLogoRecoveryTarget } from './backup-assets';
import { recoveryReceiptEvidence } from './backup-recovery-receipt.mjs';
import { Prisma } from '@prisma/client';
import { withCompanyBackupTransaction } from '@/lib/db';
import { ValidationError } from './api-error';
import { captureCompanySnapshot, type BackupData, type BackupManifest, type CompanySnapshotClient } from './backup';
import { sealSnapshot, assertSealedBackupFormat } from './backup-format';
import { assertBackupOwnership, buildBackupOwnership } from './backup-ownership';
import { publishBackup, readCompanyConfig } from './backup-storage';
import {
  RESTORE_MODELS, delegate, identity, sameConfig, scalarData,
  validateRestoreSource, validateRestoreDestination, type AuditRebase, type CompanyImport, type Row, type Tables,
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

/**
 * Payload/destination admission checks reject the call, they do not fail the
 * server: the HTTP routes map AppError to its status code, so a refused backup
 * must answer 4xx instead of a generic 500. The original message is preserved
 * verbatim so the RESTORE_/BACKUP_ASSET_ contracts (and their logs) are stable.
 * Only the validator call sites use this; the self-generated safety snapshot
 * check right before publication stays a plain error (that one is a server bug).
 */
function validated<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/^(RESTORE|BACKUP_ASSET)[A-Z_]*:/.test(message)) throw new ValidationError(message);
    throw error;
  }
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
 * S4 (T5): `importAsNewCompany` lets `companyId` be a company that does NOT own
 * the archive, so a super_admin can restore a backup as a new company inside an
 * installation that keeps running. It never weakens a check: the destination
 * must be an empty shell, the ownership credential is verified first, and every
 * other tenant is left byte-identical. Absent (default) the destination must be
 * the archive's own company, exactly as before.
 */
export interface CompanyRestoreOptions {
  /** S1/S2: credential of the super admin who created the backup. */
  ownerPassword?: string;
  /** S4: restore the archive as this company (may differ from its companyId). */
  importAsNewCompany?: boolean;
}

/**
 * Read-only, destination-aware preview. Does not authorize a later restore:
 * restore repeats every check under its own transaction/locks. Caller must
 * authorize the exact company; this module does not establish sessions/RBAC.
 */
export async function previewCompanyRestore(companyId: string, text: string,
  options: CompanyRestoreOptions = {}): Promise<CompanyRestorePreview> {
  const source = validated(() => validateRestoreSource(companyId, text, options));
  // Only an admitted NEW-company import (S4) relaxes the destination rule; when
  // the archive already belongs to this company nothing changes.
  const importing = options.importAsNewCompany === true && source.snapshot.manifest.companyId !== companyId;
  const destination = await withCompanyBackupTransaction(async tx => {
    const current = await readDestination(tx);
    return validated(() => validateRestoreDestination(source.tables, current, companyId, source.snapshot.manifest.id!, {
      importSourceCompanyId: importing ? source.snapshot.manifest.companyId : null,
    }).owned);
  }, { isolationLevel: 'RepeatableRead' });
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
 *
 * S1/S2: `options.ownerPassword` is the creating super-admin's credential. It
 * is verified (fail-closed) before the transaction, before any destination
 * validation and before any delete or publication.
 */
export async function restoreCompanyBackup(companyId: string, text: string, options?: CompanyRestoreOptions): Promise<CompanyRestoreResult> {
  return restoreDatabase(companyId, text, undefined, options?.ownerPassword, options?.importAsNewCompany);
}

type PrepareConfiguration = (operationId: string, checksum: string, safetyFilename: string) => void | Promise<void>;
async function restoreDatabase(companyId: string, text: string, prepareConfiguration?: PrepareConfiguration, ownerPassword?: string,
  importAsNewCompany = false): Promise<CompanyRestoreResult> {
  const source = validated(() => validateRestoreSource(companyId, text, { importAsNewCompany }));
  // Fail-closed ownership proof: the source snapshot is already parsed and its
  // HMAC verified here, so the verifier cannot be forged. Nothing below this
  // line runs without it — no lock, no destination validation, no delete.
  assertBackupOwnership(source.snapshot.manifest, ownerPassword);
  // S5 (T4): a legacy plain-text file (no sealed current-system format) is
  // refused here, before the transaction, before any delete and before the
  // safety snapshot is published. The ownership gate above stays FIRST.
  assertSealedBackupFormat(source.snapshot);
  const operationId = crypto.randomUUID();
  let safetyFilename = '';
  let mutationStarted = false;
  try {
    await withCompanyBackupTransaction(async tx => {
      // Parameterized server-side, transaction-scoped lock; no process mutex.
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${companyId}, 729104))`);
      const companies = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`);
      // A missing destination is an admission refusal, never a server fault: the
      // routes answer the documented RESTORE_ contract instead of a generic 500.
      if (companies.length !== 1) throw new ValidationError('RESTORE_IDENTITY: destination company missing');
      const current = await readDestination(tx);
      // S4 (T5): only an explicitly admitted new-company import may target a
      // company that does not own the archive. Everything else keeps the
      // original rule (destination === archive identity).
      const importing = importAsNewCompany && source.snapshot.manifest.companyId !== companyId;
      const { owned, reanchor, imported } = validated(() => validateRestoreDestination(
        source.tables, current, companyId, source.snapshot.manifest.id!, {
          importSourceCompanyId: importing ? source.snapshot.manifest.companyId : null,
        }));
      const config = readCompanyConfig(companyId);
      const refused = blockers(source.snapshot, config, owned).filter(() => !prepareConfiguration);
      if (prepareConfiguration) {
        validateCompanyLogo(source.snapshot.data.company[0].logo, source.snapshot.manifest.companyLogo);
        const logo = source.snapshot.data.company[0].logo;
        if (logo && current.Company.some(row => row.id !== companyId && row.logo === logo)) throw new Error('RESTORE_ASSETS_REQUIRED: logo path shared with another company');
      }
      if (refused.length) throw new Error(refused.join('; '));
      // The same existing snapshot builder enforces export inventory, graph
      // ownership and user-secret exclusion. Every read is in this transaction.
      const safety = await captureCompanySnapshot(tx, companyId, config);
      // The safety snapshot is the rollback image of THIS operation. It carries
      // its own fresh verifier for the same credential the restorer just proved,
      // so a later rollback is possible without weakening S1/S2 (no password is
      // stored, and a backup created without ownership proof stays impossible).
      if (ownerPassword) safety.backupData.manifest.ownership = buildBackupOwnership(ownerPassword);
      sealSnapshot(safety.backupData);
      const safetyText = JSON.stringify(safety.backupData, null, 2);
      validateRestoreSource(companyId, safetyText);
      publishBackup(safety.filename, safetyText);
      safetyFilename = safety.filename;
      // Recheck observed config changes before writes; this is deliberately not
      // described as a lock or crash-consistent cross-resource guarantee.
      if (!sameConfig(config, readCompanyConfig(companyId))) throw new Error('RESTORE_FILES_REQUIRED: configuration changed during safety publication');
      await prepareConfiguration?.(operationId, source.snapshot.manifest.integrity!.digest, safetyFilename);
      mutationStarted = true;
      await replaceRows(tx, source.tables, owned, companyId, source.snapshot, reanchor, imported);
      const head = source.snapshot.data.journalChainHead;
      if (head) {
        // An imported company certifies under ITS destination identity, so the
        // declared tail is the re-sealed one (documented by
        // RESTORE_IMPORT_JOURNAL); every other path stores the archive tail.
        await tx.journalChainHead.create({ data: imported
          ? { companyId, lastEntryId: imported.journalTail?.lastEntryId ?? null, lastHash: imported.journalTail?.lastHash ?? null }
          : head });
      }
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

export interface CoordinatedRestoreResult extends Omit<CompanyRestoreResult, 'status' | 'scope'> {
  status: 'committed' | 'aborted' | 'reconciliation_required';
  scope: 'database-and-company-config';
}

/** Internal service entry point, not HTTP authority. Keeps admission closed on
 * any uncertain commit/file outcome. Logos require exact checksummed archive
 * bytes and a trusted installed target mapping; legacy missing bytes fail closed.
 * The ownership credential is verified before the maintenance gate is acquired,
 * so a refused restore never even publishes a maintenance marker.
 */
export async function restoreCompanyBackupCoordinated(companyId: string, text: string, options?: CompanyRestoreOptions): Promise<CoordinatedRestoreResult> {
  const source = validated(() => validateRestoreSource(companyId, text, { importAsNewCompany: options?.importAsNewCompany }));
  assertBackupOwnership(source.snapshot.manifest, options?.ownerPassword);
  // S5 (T4): refused before the maintenance gate, so a legacy plain-text file
  // never even publishes a maintenance marker (the ownership gate stays FIRST).
  assertSealedBackupFormat(source.snapshot);
  validated(() => validateCompanyLogo(source.snapshot.data.company[0].logo, source.snapshot.manifest.companyLogo));
  const runtime = path.dirname(RUNTIME_FILES.companyConfig);
  const journalRoot = path.join(runtime, 'backup-recovery');
  const gate = createMaintenanceGate(path.join(runtime, 'backup-maintenance'));
  // This transition is requested BY an admitted operation, so its own
  // normal-operation lease must not deadlock the drain it is starting. Only that
  // one lease identity is excluded; every other request stays fenced while the
  // marker is up (they are refused at admission long before reaching here).
  const owner = gate.beginMaintenance({ excludeCurrentOperation: true });
  let journalStarted = false;
  let intentOperationId = '';
  let intentSafetyFilename = '';
  let result: CompanyRestoreResult | undefined;
  try {
    await owner.drain({ timeoutMs: 5000 });
    return await owner.runRecovery(async () => {
      result = await restoreDatabase(companyId, text, async (operationId, checksum, safetyFilename) => {
        const before = recoveryFileImage(RUNTIME_FILES.companyConfig);
        const after = companyConfigImage(before, companyId, source.snapshot.data.companyConfig);
        const logo = await planCompanyLogo(source.snapshot.data.company[0].logo, source.snapshot.manifest.companyLogo);
        intentOperationId = operationId;
        intentSafetyFilename = safetyFilename;
        journalStarted = true;
        createRecoveryJournal(journalRoot, { operationId, companyId, checksum, maintenanceId: owner.id, safetyFilename,
          ...(source.snapshot.manifest.companyLogo ? { logoUrl: source.snapshot.manifest.companyLogo.url } : {}),
          files: [...(before === after ? [] : [{ key: 'company-config', before, after }]), ...(logo ? [logo.file] : [])] });
      }, options?.ownerPassword, options?.importAsNewCompany);
      if (result.status !== 'committed') return { ...result, status: 'reconciliation_required' as const,
        scope: 'database-and-company-config' as const };
      const journal = readRecoveryJournal(journalRoot, result.operationId);
      const targets: Record<string, string> = { 'company-config': RUNTIME_FILES.companyConfig };
      if (journal.logoUrl) targets['company-logo'] = await companyLogoRecoveryTarget(journal.logoUrl);
      const outcome = reconcileRecoveryFiles(journal, targets, 'committed');
      if (outcome !== 'complete') return { ...result, status: 'reconciliation_required' as const,
        scope: 'database-and-company-config' as const, error: 'File generation changed; maintenance remains closed.' };
      return { ...result, status: 'committed' as const, scope: 'database-and-company-config' as const };
    }).then(value => {
      // runRecovery has settled: ownership cannot be released from inside it.
      if (value.status === 'committed') owner.release();
      return value;
    });
  } catch (error) {
    if (!journalStarted) {
      // No recovery intent exists, so the marker this operation published must not
      // fence the application. Release exactly that marker: the owner refuses if
      // its identity is no longer the published one, and any other live lease
      // keeps the fence up. A crash leaves no owner at all and therefore always
      // stays closed for the operator. Nothing is auto-recovered by guessing.
      try {
        await owner.drain({ timeoutMs: 5000 });
        owner.release();
      } catch {
        // Ambiguity stays blocking: the marker is never removed speculatively.
      }
      throw error;
    }
    return { status: 'reconciliation_required', scope: 'database-and-company-config',
      operationId: result?.operationId ?? intentOperationId, safetyFilename: result?.safetyFilename ?? intentSafetyFilename,
      error: `Recovery intent exists; maintenance remains closed. ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Resume a recorded operation only; never create a replacement DB transaction.
 * The advisory lock is acquired under ReadCommitted before querying the receipt,
 * so an absent receipt cannot be an old snapshot of a still-committing restore.
 * A process-crash recovery lock is intentionally NOT stolen here.
 */
export async function reconcileCompanyBackupRecovery(companyId: string, operationId: string): Promise<CoordinatedRestoreResult> {
  const runtime = path.dirname(RUNTIME_FILES.companyConfig);
  const journal = readRecoveryJournal(path.join(runtime, 'backup-recovery'), operationId);
  if (journal.companyId !== companyId || !journal.maintenanceId) throw new Error('RECOVERY_IDENTITY: journal ownership mismatch');
  const gate = createMaintenanceGate(path.join(runtime, 'backup-maintenance'));
  const owner = gate.resumeMaintenance(journal.maintenanceId);
  await owner.drain({ timeoutMs: 5000 });
  const base = { operationId, safetyFilename: journal.safetyFilename ?? '', scope: 'database-and-company-config' as const };
  try {
    const decision = await owner.runRecovery(async () => {
      const evidence = await withCompanyBackupTransaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${companyId}, 729104))`);
        const receipt = await tx.auditLog.findUnique({ where: { id: operationId } });
        return recoveryReceiptEvidence(journal, receipt);
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 20000 });
      const targets: Record<string, string> = { 'company-config': RUNTIME_FILES.companyConfig };
      if (journal.logoUrl) targets['company-logo'] = await companyLogoRecoveryTarget(journal.logoUrl);
      return reconcileRecoveryFiles(journal, targets, evidence);
    });
    if (decision === 'blocked') return { ...base, status: 'reconciliation_required', error: 'Receipt or file generation could not be verified; maintenance remains closed.' };
    owner.release();
    if (decision === 'aborted') return { ...base, status: 'aborted', error: 'Database replacement did not commit; original files restored and maintenance reopened. Start a new explicitly confirmed operation.' };
    return { ...base, status: 'committed' };
  } catch (error) {
    return { ...base, status: 'reconciliation_required', error: `Maintenance remains closed. ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function replaceRows(tx: CompanySnapshotClient, source: Tables, owned: Tables, companyId: string, snapshot: BackupData,
  reanchor: AuditRebase | null = null, imported: CompanyImport | null = null): Promise<void> {
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
  const companyData = scalarData('Company', source.Company[0], snapshot);
  // An imported company KEEPS its destination id and takes the archive's
  // substance; the archive id is never written into the Company row.
  if (imported) delete companyData.id;
  await tx.company.update({ where: { id: companyId }, data: companyData as Prisma.CompanyUncheckedUpdateInput });
  for (const model of models) {
    // S6 (T3): a re-based audit segment is inserted INSTEAD of the archive rows:
    // the sealed RESTORE_REBASE entry first, then the same segment re-linked
    // under this installation's secret. Every other model is untouched.
    // S4 (T5): an imported company inserts its CLOSED HISTORICAL audit records
    // (never chain members) and its journal entries re-sealed under the
    // destination identity, in place of the archive's own rows.
    const rows = model === 'AuditLog' && reanchor ? reanchor.rows
      : model === 'AuditLog' && imported ? imported.auditRows
      : model === 'JournalEntry' && imported ? imported.journalEntries
      : source[model];
    for (const row of rows) {
      const data = scalarData(model, row, snapshot);
      if (imported && data.companyId === imported.sourceCompanyId) data.companyId = companyId;
      // The approval payload carries the tenant id the action belongs to; a
      // NEW company must own its pending actions (validated on every later
      // backup of this company). Only this tenant's own value is rewritten.
      if (imported && model === 'PendingApproval' && data.payload && typeof data.payload === 'object' &&
          (data.payload as Row).companyId === imported.sourceCompanyId) {
        data.payload = { ...(data.payload as Row), companyId };
      }
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
