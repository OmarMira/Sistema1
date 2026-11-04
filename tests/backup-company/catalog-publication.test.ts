import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { queryRows } from './helpers';

const state = vi.hoisted(() => {
  const fs = require('node:fs'), path = require('node:path');
  const parent = path.resolve('tests/backup-company/.scratch');
  fs.mkdirSync(parent, { recursive: true });
  return { root: fs.mkdtempSync(path.join(parent, 'catalog-')), transactions: 0,
    rows: { company: [
      { id: 'tenant', legalName: 'Compañía Ñ € 中文 😀', taxId: null },
      { id: 'other', legalName: 'Other company', taxId: null },
    ] } as Record<string, any[]> };
});
vi.mock('@/lib/config/paths', () => ({ BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'company-config.json') } }));
const database = vi.hoisted(() => new Proxy({}, { get: (_, model: string) => ({
  findMany: async (query: any) => queryRows(state.rows, model, query),
  findUnique: async (query: any) => queryRows(state.rows, model, query)[0] ?? null,
}) }));
vi.mock('@/lib/db', () => ({ db: database, withCompanyBackupTransaction: async (callback: any) => {
  state.transactions++; return callback(database);
} }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { createBackup, listBackups, getBackupFile } from '@/lib/backup';

const dir = path.join(state.root, 'backups'), index = path.join(dir, 'manifest.json');
const fault = (code: string) => Object.assign(new Error(`controlled ${code}`), { code, syscall: 'rename' });
function files() { return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; }
function disk() { return files().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]); }
function noTemps() { expect(files().filter(name => name.endsWith('.tmp'))).toEqual([]); }
async function rejected(work: Promise<unknown>): Promise<Error & { cause?: NodeJS.ErrnoException }> {
  try { await work; } catch (error) { return error as Error & { cause?: NodeJS.ErrnoException }; }
  throw new Error('Expected public backup rejection');
}
// Scoped platform control, no skips. The Atomics spy ALWAYS delegates to the real
// wait and is restored before leaving this callback; no fake global scheduling.
async function onPlatform(platform: NodeJS.Platform, work: (waits: () => number[]) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const spy = vi.spyOn(Atomics, 'wait');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    await work(() => {
      const calls: readonly (readonly unknown[])[] = spy.mock.calls;
      return calls.filter(call => call[0] instanceof Int32Array && call[0].length === 1 &&
        call[1] === 0 && call[2] === 0 && [10, 25, 50].includes(Number(call[3]))).map(call => Number(call[3]));
    });
  } finally { spy.mockRestore(); Object.defineProperty(process, 'platform', descriptor); }
}
beforeEach(() => {
  vi.restoreAllMocks(); state.transactions = 0;
  for (const name of fs.readdirSync(state.root)) fs.rmSync(path.join(state.root, name), { recursive: true, force: true });
});
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(state.root, { recursive: true, force: true }); });

it.each([1, 3])('recovers after %i transient Windows EPERM faults using the same flushed/closed temp and atomic target', async failures => {
  const first = await createBackup('tenant');
  const oldIndex = fs.readFileSync(index), oldBackup = getBackupFile(first.filename)!;
  const rows = structuredClone(state.rows);
  const open = fs.openSync, flush = fs.fsyncSync, close = fs.closeSync, stat = fs.lstatSync;
  let fd: number | undefined, opened = 0, flushed = 0, closed = 0, attempts = 0, temp = '', proposed = '';
  let checked: string[] = [];
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: any[]) => {
    const result = (open as any)(...args);
    if (String(args[0]).includes('.manifest.json.') && args[1] === 'wx') { fd = result; opened++; }
    return result;
  }) as any);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(handle => { if (handle === fd) flushed++; flush(handle); });
  vi.spyOn(fs, 'closeSync').mockImplementation(handle => { if (handle === fd) { closed++; fd = undefined; } close(handle); });
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: any[]) => {
    checked.push(String(args[0])); return (stat as any)(...args);
  }) as any);
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    attempts++;
    expect(target).toBe(index);
    expect(fs.readFileSync(index).equals(oldIndex)).toBe(true);
    expect(getBackupFile(first.filename)).toEqual(oldBackup);
    expect(opened).toBe(1); expect(flushed).toBe(1); expect(closed).toBe(1);
    if (!temp) { temp = String(source); proposed = fs.readFileSync(source, 'utf8'); }
    expect(String(source)).toBe(temp); expect(fs.readFileSync(source, 'utf8')).toBe(proposed);
    if (attempts > 1) { expect(checked).toContain(temp); expect(checked).toContain(index); }
    checked = [];
    if (attempts <= failures) throw fault('EPERM');
    // This unit injects an exact failure count. Do not let a second, real
    // Windows sharing violation add nondeterministic failures to that count.
    // Native replacement is exercised by the ordinary export/catalog tests.
    fs.writeFileSync(target, fs.readFileSync(source));
    fs.unlinkSync(source);
  });
  await onPlatform('win32', async waits => {
    const saved = await createBackup('tenant');
    expect(attempts).toBe(failures + 1);
    expect(waits()).toEqual([10, 25, 50].slice(0, failures));
    const catalog = JSON.parse(proposed);
    expect(catalog.backups.find((row: any) => row.filename === saved.filename).id).toBe(saved.id);
    expect(fs.readFileSync(index, 'utf8')).toBe(proposed);
    const raw = getBackupFile(saved.filename)!;
    expect(raw.data).toBe(Buffer.from(saved.data, 'base64').toString('utf8'));
    expect(raw.size).toBe(Buffer.byteLength(raw.data));
    expect(JSON.parse(raw.data).manifest).toMatchObject({ id: saved.id, companyId: 'tenant',
      companyInfo: { legalName: 'Compañía Ñ € 中文 😀' } });
    expect(listBackups('tenant').map(row => row.id).sort()).toEqual([first.id, saved.id].sort());
    expect(getBackupFile(first.filename)).toEqual(oldBackup);
    expect(state.rows).toEqual(rows); expect(state.transactions).toBe(2); noTemps();
  });
});

it('caps persistent Windows EPERM at four attempts, exposes the cause and preserves old cache/backup bytes plus discoverability', async () => {
  const first = await createBackup('tenant'), other = await createBackup('other');
  const oldIndex = fs.readFileSync(index), beforeFiles = files(), previous = getBackupFile(first.filename), foreign = getBackupFile(other.filename);
  const rows = structuredClone(state.rows), failure = fault('EPERM');
  const sources: string[] = [];
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    sources.push(String(source)); expect(target).toBe(index);
    expect(fs.readFileSync(index).equals(oldIndex)).toBe(true); throw failure;
  });
  await onPlatform('win32', async waits => {
    const error = await rejected(createBackup('tenant'));
    expect(sources).toHaveLength(4); expect(new Set(sources).size).toBe(1);
    expect(waits()).toEqual([10, 25, 50]);
    expect(error.message).toContain('but catalog update failed: Error: controlled EPERM');
    expect(error.cause).toBe(failure); expect(error.cause?.code).toBe('EPERM');
    expect(fs.readFileSync(index).equals(oldIndex)).toBe(true);
    expect(getBackupFile(first.filename)).toEqual(previous); expect(getBackupFile(other.filename)).toEqual(foreign);
    const published = files().filter(name => !beforeFiles.includes(name));
    expect(published).toHaveLength(1); expect(error.message).toContain(published[0]);
    const complete = getBackupFile(published[0])!;
    const body = JSON.parse(complete.data);
    expect(body.manifest.companyId).toBe('tenant'); expect(complete.size).toBe(Buffer.byteLength(complete.data));
    expect(listBackups('tenant').map(row => row.id).sort()).toEqual([first.id, body.manifest.id].sort());
    expect(listBackups('other').map(row => row.id)).toEqual([other.id]);
    // Reading the authoritative files must not attempt to repair/rewrite cache.
    expect(sources).toHaveLength(4); expect(fs.readFileSync(index).equals(oldIndex)).toBe(true);
    expect(state.rows).toEqual(rows); expect(state.transactions).toBe(3); noTemps();
  });
});

it.each(['EIO', 'EACCES', 'EBUSY'])('does not retry non-EPERM %s index errors', async code => {
  const saved = await createBackup('tenant'), before = getBackupFile(saved.filename), oldIndex = fs.readFileSync(index);
  const failure = fault(code), rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure; });
  await onPlatform('win32', async waits => {
    const error = await rejected(createBackup('tenant'));
    expect(rename).toHaveBeenCalledTimes(1); expect(waits()).toEqual([]);
    expect(error.message).toContain(`controlled ${code}`); expect(error.cause).toBe(failure);
    expect(fs.readFileSync(index).equals(oldIndex)).toBe(true); expect(getBackupFile(saved.filename)).toEqual(before);
    expect(listBackups('tenant')).toHaveLength(2); noTemps();
  });
});

it('does not retry EPERM on non-Windows platforms', async () => {
  await createBackup('tenant');
  const oldIndex = fs.readFileSync(index), failure = fault('EPERM');
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure; });
  await onPlatform('linux', async waits => {
    const error = await rejected(createBackup('tenant'));
    expect(rename).toHaveBeenCalledTimes(1); expect(waits()).toEqual([]); expect(error.cause).toBe(failure);
    expect(fs.readFileSync(index).equals(oldIndex)).toBe(true); noTemps();
  });
});

it('fails a permission-denied catalog read immediately without publication or retries', async () => {
  await createBackup('tenant');
  const before = disk(), read = fs.readFileSync, failure = fault('EACCES');
  const rename = vi.spyOn(fs, 'renameSync');
  const denied = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
    if (String(file) === index) throw failure; return (read as any)(file, ...args);
  }) as any);
  await onPlatform('win32', async waits => {
    expect(await rejected(createBackup('tenant'))).toBe(failure);
    expect(denied.mock.calls.filter(call => String(call[0]) === index)).toHaveLength(1);
    expect(rename).not.toHaveBeenCalled(); expect(waits()).toEqual([]);
  });
  denied.mockRestore(); expect(disk()).toEqual(before); noTemps();
});

it('never retries or overwrites a primary snapshot link collision', async () => {
  const saved = await createBackup('tenant'), before = disk();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(saved.id as ReturnType<typeof crypto.randomUUID>);
  const link = vi.spyOn(fs, 'linkSync'), rename = vi.spyOn(fs, 'renameSync');
  await onPlatform('win32', async waits => {
    const error = await rejected(createBackup('tenant'));
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(link).toHaveBeenCalledTimes(1); expect(rename).not.toHaveBeenCalled(); expect(waits()).toEqual([]);
    expect(disk()).toEqual(before); expect(listBackups('tenant').map(row => row.id)).toEqual([saved.id]); noTemps();
  });
});

it('never retries EPERM on primary snapshot linking', async () => {
  await createBackup('tenant');
  const before = disk(), failure = fault('EPERM');
  const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw failure; }), rename = vi.spyOn(fs, 'renameSync');
  await onPlatform('win32', async waits => {
    expect(await rejected(createBackup('tenant'))).toBe(failure);
    expect(link).toHaveBeenCalledTimes(1); expect(rename).not.toHaveBeenCalled(); expect(waits()).toEqual([]);
    expect(disk()).toEqual(before); noTemps();
  });
});

it.each(['index', 'temp'])('revalidates the %s path for symlinks before the next rename attempt', async location => {
  await createBackup('tenant');
  const oldIndex = fs.readFileSync(index), stat = fs.lstatSync;
  let blocked = '';
  const denied = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: any, ...args: any[]) => {
    const result = (stat as any)(target, ...args);
    return blocked && String(target) === blocked ? new Proxy(result, { get: (obj, key) =>
      key === 'isSymbolicLink' ? () => true : Reflect.get(obj, key) }) : result;
  }) as any);
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(source => {
    blocked = location === 'index' ? index : String(source); throw fault('EPERM');
  });
  await onPlatform('win32', async waits => {
    const error = await rejected(createBackup('tenant'));
    expect(error.message).toContain('Backup storage symlink is not allowed');
    expect(rename).toHaveBeenCalledTimes(1); expect(waits()).toEqual([10]);
  });
  denied.mockRestore(); expect(fs.readFileSync(index).equals(oldIndex)).toBe(true);
  expect(listBackups('tenant')).toHaveLength(2); noTemps();
});
