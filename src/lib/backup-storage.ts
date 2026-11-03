if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKUP_DIR, RUNTIME_FILES } from '@/lib/config/paths';
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
}
export interface BackupCatalog { backups: CatalogEntry[] }

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

/** Files are authoritative; index is a replaceable cache and legacy ID hint. No read-side writes. */
export function readCatalog(): BackupCatalog {
  assertNoLinks(BACKUP_DIR);
  let names: string[];
  try { names = fs.readdirSync(BACKUP_DIR); }
  catch (error) { if (missing(error)) return { backups: [] }; throw error; }
  const index = readIndex();
  const backups: CatalogEntry[] = [];
  for (const filename of names.sort()) {
    if (!validBackupFilename(filename)) continue;
    const file = readBackupText(filename);
    if (!file) continue; // Concurrent deletion, not a storage error.
    let snapshot;
    try { snapshot = parseSnapshot(file.data); }
    catch (error) { throw new Error(`Invalid backup file ${filename}: ${String(error)}`); }
    const { manifest } = snapshot;
    const hint = index.backups.find(entry => entry.filename === filename && entry.companyId === manifest.companyId);
    backups.push({
      id: isCompanyFormat(manifest.version) ? manifest.id! : hint?.id ?? `legacy-${crypto.createHash('sha256').update(filename).digest('hex')}`,
      filename, companyId: manifest.companyId, size: file.size,
      createdAt: manifest.createdAt, companyLegalName: manifest.companyInfo.legalName,
      recordCounts: manifest.recordCounts,
    });
  }
  return { backups };
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

export function writeCatalog(catalog: BackupCatalog): void {
  writeAtomic(path.join(BACKUP_DIR, 'manifest.json'), JSON.stringify(catalog, null, 2), true);
}

export function publishBackup(filename: string, text: string): void {
  parseSnapshot(text);
  // Seal before touching storage: without SESSION_SECRET nothing is published.
  const sealed = sealBackupText(text);
  // Validate old history before publication; an index write failure after publication
  // leaves a complete discoverable snapshot, never a false success response.
  readCatalog();
  writeAtomic(backupPath(filename), sealed, false);
  try { writeCatalog(readCatalog()); }
  catch (error) { throw new Error(`Backup file published as ${filename}, but catalog update failed: ${String(error)}`, { cause: error }); }
}

export function removeBackupFile(filename: string): boolean {
  const target = backupPath(filename);
  try {
    if (!fs.lstatSync(target).isFile()) throw new Error('Backup is not a regular file');
    fs.unlinkSync(target);
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}
