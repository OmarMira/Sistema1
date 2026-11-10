if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKUP_DIR, RUNTIME_FILES } from '@/lib/config/paths';
import { logger } from '@/lib/logger';
import { parseSnapshot, isCompanyFormat } from './backup-format';
import type { BackupManifest } from './backup';

export interface CatalogEntry {
  id: string;
  filename: string;
  companyId: string;
  size: number;
  createdAt: string;
  companyLegalName: string;
  recordCounts: BackupManifest['recordCounts'];
  /** Source user id stamped in the manifest at creation time, when present. */
  createdBy?: string;
}
export interface BackupCatalog { backups: CatalogEntry[] }

/** A stored file that exists but cannot be read or parsed. Preserved untouched. */
export interface UnreadableCatalogFile {
  filename: string;
  error: string;
}

/** Catalog view limited to ONE company, plus its unreadable files. */
export interface CompanyBackupCatalog {
  backups: CatalogEntry[];
  unreadable: UnreadableCatalogFile[];
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/* ─── Encryption at rest ───────────────────────────────────────────────
 * A backup carries the full ledger, company PII and restore material, so a
 * published file is sealed with AES-256-GCM before it reaches the disk and is
 * unsealed transparently on read. The scheme is exactly the one exposed by
 * src/lib/crypto.ts: a PBKDF2-SHA256 key (salt 'crypto-key-salt', 100000
 * iterations, derived from SESSION_SECRET), AES-256-GCM, a 16-byte random IV,
 * the 16-byte tag appended to the ciphertext and the payload transported as
 * `ivHex:base64(ciphertext||tag)`. It is re-expressed here with node:crypto
 * because the two call sites are synchronous — publishing happens inside the
 * coordinated restore transaction and every reader is synchronous — while the
 * shared module is asynchronous (Web Crypto) and must stay free of Node-only
 * imports for the Edge instrumentation bundle. Interoperability with
 * src/lib/crypto.ts is pinned by tests/backup-company/encryption-at-rest.test.ts.
 */
const ENCRYPTED_BACKUP_MAGIC = 'ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1\n';
const CIPHER = 'aes-256-gcm';
const KEY_SALT = 'crypto-key-salt';
const KEY_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

let cachedKey: { secret: string; key: Buffer } | null = null;

function backupKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET environment variable is required. ' +
      'Set it in .env.local (development) or your deployment environment (production).',
    );
  }
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: crypto.pbkdf2Sync(secret, KEY_SALT, KEY_ITERATIONS, KEY_LENGTH, 'sha256') };
  }
  return cachedKey.key;
}

/** Seal plaintext backup JSON into the self-describing at-rest envelope. */
function sealBackupText(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(CIPHER, backupKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope = {
    format: 'accountexpress-company-backup',
    version: 1,
    algorithm: 'AES-256-GCM',
    keyDerivation: `PBKDF2-SHA256-${KEY_ITERATIONS}`,
    ciphertext: `${iv.toString('hex')}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')}`,
  };
  return ENCRYPTED_BACKUP_MAGIC + JSON.stringify(envelope);
}

/** Unseal a sealed envelope; authentication failures surface, never plaintext fallback. */
function unsealBackupText(filename: string, body: string): string {
  let envelope: { format?: unknown; version?: unknown; algorithm?: unknown; ciphertext?: unknown };
  try { envelope = JSON.parse(body); }
  catch { throw new Error(`Backup file ${filename} is encrypted but its envelope is not valid JSON`); }
  if (envelope?.format !== 'accountexpress-company-backup' || envelope.version !== 1 ||
      envelope.algorithm !== 'AES-256-GCM' || typeof envelope.ciphertext !== 'string') {
    throw new Error(`Backup file ${filename} is encrypted with an unsupported envelope`);
  }
  const parts = envelope.ciphertext.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/.test(parts[0])) {
    throw new Error(`Backup file ${filename} has a malformed encrypted payload`);
  }
  const sealed = Buffer.from(parts[1], 'base64');
  if (sealed.length < TAG_LENGTH) throw new Error(`Backup file ${filename} has a truncated encrypted payload`);
  try {
    const decipher = crypto.createDecipheriv(CIPHER, backupKey(), Buffer.from(parts[0], 'hex'));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new Error(
      `Backup file ${filename} could not be decrypted: the ciphertext failed authentication ` +
      '(SESSION_SECRET changed or the file was tampered with)',
      { cause: error },
    );
  }
}

/** Reject symlinks/junctions in every existing component, not only the leaf. */
function assertNoLinks(target: string): void {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  if (parent !== absolute) assertNoLinks(parent);
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Backup storage symlink is not allowed');
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function ensureDirectory(): void {
  assertNoLinks(BACKUP_DIR);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.lstatSync(BACKUP_DIR).isDirectory()) throw new Error('Backup storage is not a directory');
}

export function validBackupFilename(filename: string): boolean {
  return typeof filename === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.json$/.test(filename) &&
    !filename.includes('..') && filename !== 'manifest.json';
}

function backupPath(filename: string): string {
  if (!validBackupFilename(filename)) throw new Error('Invalid backup filename');
  const target = path.resolve(BACKUP_DIR, filename);
  if (path.dirname(target) !== path.resolve(BACKUP_DIR)) throw new Error('Invalid backup path');
  assertNoLinks(target);
  return target;
}

export function readBackupText(filename: string): { data: string; size: number } | null {
  if (!validBackupFilename(filename)) return null;
  const target = backupPath(filename);
  try {
    if (!fs.lstatSync(target).isFile()) throw new Error('Backup is not a regular file');
    const raw = fs.readFileSync(target);
    const onDisk = raw.toString('utf8');
    if (!Buffer.from(onDisk, 'utf8').equals(raw)) throw new Error('Backup is not valid UTF8');
    // Sealed files declare themselves; anything else is a legacy plaintext
    // snapshot and stays readable without migration.
    const data = onDisk.startsWith(ENCRYPTED_BACKUP_MAGIC)
      ? unsealBackupText(filename, onDisk.slice(ENCRYPTED_BACKUP_MAGIC.length))
      : onDisk;
    // Size is the payload size clients already see, not the on-disk envelope size.
    return { data, size: Buffer.byteLength(data, 'utf8') };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** A missing config is explicit null; malformed/unreadable state must not disappear. */
export function readCompanyConfig(companyId: string): Record<string, unknown> | null {
  assertNoLinks(RUNTIME_FILES.companyConfig);
  let text: string;
  try { text = fs.readFileSync(RUNTIME_FILES.companyConfig, 'utf8'); }
  catch (error) { if (missing(error)) return null; throw error; }
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.companies !== undefined && (!config.companies || typeof config.companies !== 'object' || Array.isArray(config.companies)))) {
    throw new Error('Invalid company configuration');
  }
  const selected = Object.prototype.hasOwnProperty.call(config.companies ?? {}, companyId) ? config.companies[companyId] : null;
  if (selected !== null && (typeof selected !== 'object' || Array.isArray(selected))) throw new Error('Invalid company configuration');
  return selected;
}

function readIndex(): BackupCatalog {
  const target = path.join(BACKUP_DIR, 'manifest.json');
  assertNoLinks(target);
  let text: string;
  try { text = fs.readFileSync(target, 'utf8'); }
  catch (error) { if (missing(error)) return { backups: [] }; throw error; }
  try {
    const index = JSON.parse(text);
    if (!Array.isArray(index?.backups)) return { backups: [] };
    return { backups: index.backups.filter((entry: CatalogEntry) => entry &&
      typeof entry.id === 'string' && validBackupFilename(entry.filename) && typeof entry.companyId === 'string') };
  } catch { return { backups: [] }; }
}

/** Sorted backup filenames on disk. A missing directory is an empty catalog. */
function listBackupFilenames(): string[] {
  assertNoLinks(BACKUP_DIR);
  let names: string[];
  try { names = fs.readdirSync(BACKUP_DIR); }
  catch (error) { if (missing(error)) return []; throw error; }
  return names.sort().filter(validBackupFilename);
}

type InspectedFile =
  | { kind: 'entry'; entry: CatalogEntry }
  // Owned by another company (index evidence) or unattributable: never claimed.
  | { kind: 'foreign' }
  | { kind: 'absent' }
  | { kind: 'unreadable'; message: string; error: Error };

/**
 * Inspect ONE stored file. `companyId` limits the inspection to one tenant;
 * without it the whole catalog is inspected and a failure is reported so the
 * caller can stay fail-closed.
 */
function inspectCatalogFile(filename: string, index: BackupCatalog, companyId?: string): InspectedFile {
  const hints = index.backups.filter(entry => entry.filename === filename);
  if (companyId !== undefined && hints.length > 0 && !hints.some(entry => entry.companyId === companyId)) {
    // Listing one tenant never decrypts another tenant's bytes.
    return { kind: 'foreign' };
  }
  const ownsHint = companyId === undefined || hints.some(entry => entry.companyId === companyId);
  const unreadable = (message: string, error: Error): InspectedFile =>
    ownsHint ? { kind: 'unreadable', message, error } : { kind: 'absent' };

  let file: { data: string; size: number } | null;
  try { file = readBackupText(filename); }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return unreadable(failure.message, failure);
  }
  if (!file) return { kind: 'absent' }; // Concurrent deletion, not a storage error.
  let snapshot;
  try { snapshot = parseSnapshot(file.data); }
  catch (error) {
    // Same message the whole-catalog read has always thrown.
    const message = `Invalid backup file ${filename}: ${String(error)}`;
    return unreadable(message, new Error(message));
  }
  const { manifest } = snapshot;
  if (companyId !== undefined && manifest.companyId !== companyId) return { kind: 'foreign' };
  const hint = index.backups.find(entry => entry.filename === filename && entry.companyId === manifest.companyId);
  return {
    kind: 'entry',
    entry: {
      id: isCompanyFormat(manifest.version) ? manifest.id! : hint?.id ?? `legacy-${crypto.createHash('sha256').update(filename).digest('hex')}`,
      filename, companyId: manifest.companyId, size: file.size,
      createdAt: manifest.createdAt, companyLegalName: manifest.companyInfo.legalName,
      recordCounts: manifest.recordCounts,
      ...(typeof manifest.createdBy === 'string' ? { createdBy: manifest.createdBy } : {}),
    },
  };
}

/** Files are authoritative; index is a replaceable cache and legacy ID hint. No read-side writes. */
export function readCatalog(): BackupCatalog {
  const names = listBackupFilenames();
  const index = readIndex();
  const backups: CatalogEntry[] = [];
  for (const filename of names) {
    const inspected = inspectCatalogFile(filename, index);
    // The whole-catalog read is the publication/pruning safeguard: an unreadable
    // file stays fatal there, because rewriting the index over it would drop
    // history nobody asked to lose.
    if (inspected.kind === 'unreadable') throw inspected.error;
    if (inspected.kind === 'entry') backups.push(inspected.entry);
  }
  return { backups };
}

/**
 * Catalog view SCOPED to one company.
 *
 * Listing is a read of ONE tenant's history, so it must never depend on the
 * readability of another tenant's bytes: files the index attributes to another
 * company are skipped without being decrypted. Per-file failures are isolated —
 * a file of THIS company that cannot be decrypted or parsed is reported in
 * `unreadable` (the operator sees the integrity loss) instead of failing the
 * whole request, and the file itself is never modified or removed.
 *
 * Attribution for an unreadable file requires catalog evidence: only an index
 * entry for the caller company surfaces it. A file the index cannot attribute is
 * never claimed by a tenant, because the manifest that would prove ownership is
 * exactly the part that cannot be read.
 */
export function readCompanyCatalog(companyId: string): CompanyBackupCatalog {
  const names = listBackupFilenames();
  const index = readIndex();
  const backups: CatalogEntry[] = [];
  const unreadable: UnreadableCatalogFile[] = [];
  for (const filename of names) {
    const inspected = inspectCatalogFile(filename, index, companyId);
    if (inspected.kind === 'entry') backups.push(inspected.entry);
    else if (inspected.kind === 'unreadable') unreadable.push({ filename, error: inspected.message });
  }
  return { backups, unreadable };
}

/** Windows can transiently deny atomic replacement of an existing index.
 * Keep the same flushed/closed temp and target; never unlink the old cache.
 * Four attempts maximum, with 85 ms of requested synchronous waits in total.
 * Only rename EPERM is eligible, never snapshot linking or path validation.
 */
function replaceCatalog(temp: string, target: string): void {
  const delays = [10, 25, 50] as const;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    assertNoLinks(temp);
    assertNoLinks(target);
    try {
      fs.renameSync(temp, target);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException)?.code !== 'EPERM' || attempt >= delays.length) {
        throw error;
      }
      Atomics.wait(sleeper, 0, 0, delays[attempt]);
    }
  }
}

/** Flush complete bytes, then atomically link without replacing a prior file. */
function writeAtomic(target: string, text: string, replaceIndex: boolean): void {
  ensureDirectory();
  assertNoLinks(target);
  const temp = path.join(BACKUP_DIR, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  let owned = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    owned = true;
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assertNoLinks(target);
    if (replaceIndex) replaceCatalog(temp, target);
    else fs.linkSync(temp, target);
  } finally {
    // Only the exclusive temporary file created by this invocation is removed.
    if (owned) {
      try { fs.unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; }
    }
  }
}

/**
 * Drop ONE entry from the index without reading any stored file.
 *
 * The index is a replaceable cache of ids for legacy filenames; the files are
 * authoritative. A delete must therefore never decrypt the rest of the inventory:
 * one unreadable file belonging to another company used to make a healthy
 * tenant's delete fail. Entries of other companies and other tenants' files are
 * left exactly as they were.
 */
export function removeCatalogEntry(filename: string, companyId: string): void {
  const index = readIndex();
  const remaining = index.backups.filter(
    (entry) => !(entry.filename === filename && entry.companyId === companyId),
  );
  if (remaining.length === index.backups.length) return; // nothing to remove
  writeCatalog({ backups: remaining });
}

export function writeCatalog(catalog: BackupCatalog): void {
  writeAtomic(path.join(BACKUP_DIR, 'manifest.json'), JSON.stringify(catalog, null, 2), true);
}

/** A published snapshot whose catalog/retention maintenance had to be skipped. */
export interface PublishWarning {
  code: 'BACKUP_CATALOG_UNVERIFIED';
  message: string;
}

export interface PublishResult {
  /** false when the catalog index was left untouched (uncertain inventory). */
  catalogUpdated: boolean;
  /** Explicit, surfaced uncertainty; null when the catalog was fully verified. */
  warning: PublishWarning | null;
}

export const BACKUP_CATALOG_UNVERIFIED_WARNING: PublishWarning = {
  code: 'BACKUP_CATALOG_UNVERIFIED',
  message:
    'The new backup was stored, but the backup catalog and retention cleanup were skipped because at least one ' +
    'stored backup file could not be read. Existing backup files were not changed or deleted.',
};

/**
 * Classify the stored files for publication WITHOUT trusting the index and
 * WITHOUT failing on a single damaged file.
 *
 * `unreadable > 0` means the inventory is UNCERTAIN: the owner of a file that
 * cannot be authenticated is unknowable, so no safe catalog rewrite or retention
 * decision exists. `readIndex()` storage faults still throw, because that is a
 * storage failure rather than a per-file integrity problem.
 */
function classifyCatalog(): { unreadable: number } {
  const index = readIndex();
  let unreadable = 0;
  for (const filename of listBackupFilenames()) {
    if (inspectCatalogFile(filename, index).kind === 'unreadable') unreadable += 1;
  }
  return { unreadable };
}

export function publishBackup(filename: string, text: string): PublishResult {
  parseSnapshot(text);
  // Seal before touching storage: without SESSION_SECRET nothing is published.
  const sealed = sealBackupText(text);
  // Classify old history first: a catalog that cannot be inspected fails the
  // publication (fail-closed), and a damaged file only makes it uncertain.
  const { unreadable } = classifyCatalog();
  // Publication never replaces an existing file (link, not rename).
  writeAtomic(backupPath(filename), sealed, false);

  if (unreadable > 0) {
    // Publication and maintenance are independent decisions. The new snapshot is
    // complete and discoverable from the files themselves (reads are file
    // authoritative), so the index and every existing file — including the
    // unreadable ones — stay untouched, and retention is NOT applied: pruning
    // from an unverified inventory could delete a file whose role is unknown.
    // The uncertainty is surfaced to the caller instead of being hidden.
    logger.warn('BACKUP_CATALOG_UNVERIFIED', { filename, unreadableFiles: unreadable });
    return { catalogUpdated: false, warning: BACKUP_CATALOG_UNVERIFIED_WARNING };
  }

  // An index write failure after publication leaves a complete discoverable
  // snapshot, never a false success response.
  try { writeCatalog(readCatalog()); }
  catch (error) { throw new Error(`Backup file published as ${filename}, but catalog update failed: ${String(error)}`, { cause: error }); }
  // Retention runs at the moment growth happens (every publish, including the
  // safety snapshot each restore adds). Publication already succeeded, so a
  // retention failure is reported and never turned into a false publish error.
  try { pruneBackups(); }
  catch (error) { logger.warn('BACKUP_RETENTION_SKIPPED', { error: String(error), filename }); }
  return { catalogUpdated: true, warning: null };
}

export function removeBackupFile(filename: string): boolean {
  const target = backupPath(filename);
  try {
    if (!fs.lstatSync(target).isFile()) throw new Error('Backup is not a regular file');
    fs.unlinkSync(target);
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}

/* ─── Retention policy ──────────────────────────────────────────────────
 * Every restore publishes an extra safety snapshot next to the regular ones,
 * so an installed instance grew without bound: nothing ever removed a backup
 * file. Retention is a bounded policy over the SAME authorized storage helpers
 * (never a raw unlink) with two independent limits:
 *
 *  - BACKUP_RETENTION_COUNT (default 20): per company, at most N files.
 *  - BACKUP_RETENTION_DAYS  (default 90): per company, at most N days of age
 *    (0 disables the age rule; a non-integer/negative value falls back).
 *
 * Hard guarantees, in order of precedence:
 *  1. The NEWEST full backup of every company is never pruned.
 *  2. A file referenced as `safetyFilename` by ANY recovery journal is never
 *     pruned, regardless of age or count. A safety snapshot is the rollback
 *     image of a restore; the journal/receipt coupling is deliberately NOT
 *     re-derived here (an unexpired receipt is an AuditLog row owned by the
 *     restore flow), so safety snapshots are EXCLUDED FROM PRUNING ENTIRELY.
 *     That is the conservative reading of "never delete a safety snapshot
 *     attached to an unexpired recovery receipt": we never delete any of them,
 *     and the operator removes them after reconciliation.
 *  3. If the journal directory exists but a journal cannot be read, the whole
 *     prune is skipped: an unreadable journal may name a safety snapshot we
 *     cannot identify, and guessing risks the only rollback image.
 */
export interface BackupRetentionPolicy {
  /** Maximum files kept per company (newest always kept). */
  count: number;
  /** Maximum age in days; 0 disables the age rule. */
  days: number;
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = { count: 20, days: 90 };

function positiveInteger(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function backupRetentionPolicy(env: NodeJS.ProcessEnv = process.env): BackupRetentionPolicy {
  const count = positiveInteger(env.BACKUP_RETENTION_COUNT);
  const days = positiveInteger(env.BACKUP_RETENTION_DAYS);
  return {
    // A zero/negative/invalid count would delete everything but the newest on
    // every publish; the documented default is used instead of a silent purge.
    count: count !== null && count >= 1 ? count : DEFAULT_BACKUP_RETENTION.count,
    days: days !== null ? days : DEFAULT_BACKUP_RETENTION.days,
  };
}

/** Recovery journals live beside the runtime files, one JSON per operation. */
function recoveryJournalDirectory(): string {
  return path.join(path.dirname(RUNTIME_FILES.companyConfig), 'backup-recovery');
}

/**
 * Filenames a recovery journal points at as its safety snapshot.
 * `null` means the protection set is UNKNOWN (unreadable journal present) and
 * pruning must not run at all.
 */
function safetySnapshotFilenames(): Set<string> | null {
  const directory = recoveryJournalDirectory();
  let names: string[];
  try { names = fs.readdirSync(directory); }
  catch (error) { if (missing(error)) return new Set(); throw error; }
  const safety = new Set<string>();
  for (const name of names) {
    // readdir yields single path components only: no traversal, and the
    // journal contract already guarantees the basename shape below.
    if (!name.endsWith('.json')) continue;
    let journal: unknown;
    try { journal = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch { return null; }
    const filename = (journal as { payload?: { safetyFilename?: unknown } })?.payload?.safetyFilename;
    if (filename === undefined) continue;
    if (!validBackupFilename(filename as string)) return null;
    safety.add(filename as string);
  }
  return safety;
}

export interface BackupPruneResult {
  policy: BackupRetentionPolicy;
  pruned: CatalogEntry[];
  retained: number;
  /** Files skipped because a recovery journal names them as its safety image. */
  safetyProtected: number;
  /** Retention was skipped wholesale because the safety set was unknown. */
  unknownSafetyState: boolean;
}

/**
 * Apply the retention policy to the published catalog. Files are authoritative
 * (the catalog is a cache), so the decision is recomputed from disk. Removal
 * goes through removeBackupFile, which re-validates the filename and target.
 */
export function pruneBackups(options: { now?: Date; policy?: BackupRetentionPolicy } = {}): BackupPruneResult {
  const policy = options.policy ?? backupRetentionPolicy();
  const now = (options.now ?? new Date()).getTime();
  const catalog = readCatalog();
  const safety = safetySnapshotFilenames();
  if (safety === null) {
    return { policy, pruned: [], retained: catalog.backups.length, safetyProtected: 0, unknownSafetyState: true };
  }

  const byCompany = new Map<string, CatalogEntry[]>();
  for (const entry of catalog.backups) {
    const group = byCompany.get(entry.companyId);
    if (group) group.push(entry); else byCompany.set(entry.companyId, [entry]);
  }

  const pruned: CatalogEntry[] = [];
  let safetyProtected = 0;
  for (const entries of byCompany.values()) {
    // Newest first; the filename tie-break keeps the order deterministic when
    // two snapshots share a timestamp.
    const ordered = [...entries].sort((a, b) =>
      (Date.parse(b.createdAt) - Date.parse(a.createdAt)) || a.filename.localeCompare(b.filename));
    for (const [position, entry] of ordered.entries()) {
      // Guarantee 1: the newest full backup of every company survives.
      if (position === 0) continue;
      // Guarantee 2: a safety snapshot is never pruned.
      if (safety.has(entry.filename)) { safetyProtected += 1; continue; }
      const created = Date.parse(entry.createdAt);
      const ageDays = Number.isFinite(created) ? (now - created) / 86_400_000 : -1;
      const beyondCount = position >= policy.count;
      const beyondAge = policy.days > 0 && ageDays > policy.days;
      if (!beyondCount && !beyondAge) continue;
      // A concurrent deletion is not a retention failure, and a file that is
      // not on disk must not be reported as pruned.
      if (!removeBackupFile(entry.filename)) continue;
      pruned.push(entry);
    }
  }

  if (pruned.length) {
    const removed = new Set(pruned.map(entry => entry.filename));
    writeCatalog({ backups: catalog.backups.filter(entry => !removed.has(entry.filename)) });
  }
  return { policy, pruned, retained: catalog.backups.length - pruned.length, safetyProtected, unknownSafetyState: false };
}
