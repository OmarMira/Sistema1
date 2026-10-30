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
    const data = raw.toString('utf8');
    if (!Buffer.from(data, 'utf8').equals(raw)) throw new Error('Backup is not valid UTF8');
    return { data, size: raw.length };
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
  // Validate old history before publication; an index write failure after publication
  // leaves a complete discoverable snapshot, never a false success response.
  readCatalog();
  writeAtomic(backupPath(filename), text, false);
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
