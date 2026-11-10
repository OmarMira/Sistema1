import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { localText, makeSnapshot } from './helpers';

/**
 * Reported incident (T10 / S14): `GET /api/backup?companyId=…` answered 500 for a
 * healthy tenant as soon as ONE stored file could not be decrypted — in the
 * reported case a file that did not even belong to the caller's company.
 *
 * Rules pinned here:
 *  1. A listing is scoped to the caller company: files the catalog attributes to
 *     another company are never decrypted and never make the list fail.
 *  2. A caller-company file that cannot be read stays on disk untouched and is
 *     SURFACED as `unreadable` — integrity loss is never hidden.
 *  3. A file the catalog cannot attribute to the caller is never claimed.
 *  4. Publication is separated from maintenance: a new snapshot is still stored
 *     when the inventory is unverified, while the catalog rewrite and pruning
 *     stay refused and the uncertainty is surfaced explicitly.
 *  5. Nothing on the read path writes or repairs storage.
 *
 * The scratch directory is synthetic and lives outside the worktree.
 */
const state = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sistema1-backup-list-scope-'));
  return { root, companyId: 'tenant', auditLog: [] as unknown[] };
});

vi.mock('@/lib/config/paths', () => ({
  BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'config', 'company-config.json') },
}));
vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: `admin-${state.companyId}`, companyId: state.companyId }),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: async () => undefined }));
vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: async (entry: unknown) => {
    state.auditLog.push(entry);
  },
}));
vi.mock('@/lib/auth', () => ({
  hashPassword: async () => 'not-a-real-hash',
  verifyPassword: async () => false,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/db', () => ({
  db: {},
  withCompanyBackupTransaction: async () => {
    throw new Error('a backup listing never opens a write transaction');
  },
}));

import { GET } from '@/app/api/backup/route';
import { pruneBackups, publishBackup } from '@/lib/backup-storage';

const dir = path.join(state.root, 'backups');

function publish(companyId: string, filename: string, legalName: string) {
  publishBackup(filename, localText(makeSnapshot({ companyId, legalName })));
}

/** Flip one ciphertext byte: well-formed envelope that can no longer authenticate. */
function corrupt(filename: string) {
  const file = path.join(dir, filename);
  const onDisk = fs.readFileSync(file, 'utf8');
  const match = /"ciphertext":"([0-9a-f]{32}):([^"]+)"/.exec(onDisk);
  if (!match) throw new Error(`fixture ${filename} is not a sealed backup`);
  const bytes = Buffer.from(match[2], 'base64');
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(file, onDisk.replace(match[0], `"ciphertext":"${match[1]}:${bytes.toString('base64')}"`));
}

function disk(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!fs.existsSync(dir)) return snapshot;
  for (const name of fs.readdirSync(dir).sort()) snapshot[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return snapshot;
}

function listRequest(query = `companyId=${state.companyId}`) {
  return new NextRequest(`http://localhost/api/backup?${query}`, { method: 'GET' }) as never;
}

function names(body: { backups: Array<{ filename: string }> }): string[] {
  return body.backups.map((row) => row.filename);
}

const previousRetentionDays = process.env.BACKUP_RETENTION_DAYS;

beforeEach(() => {
  state.companyId = 'tenant';
  state.auditLog.length = 0;
  // Fixtures are published with fixed timestamps, so the age-based retention
  // rule is disabled here: this suite is about reads, not about pruning.
  process.env.BACKUP_RETENTION_DAYS = '0';
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(state.root)) {
    fs.rmSync(path.join(state.root, name), { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  if (previousRetentionDays === undefined) delete process.env.BACKUP_RETENTION_DAYS;
  else process.env.BACKUP_RETENTION_DAYS = previousRetentionDays;
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('list is scoped to the caller company', () => {
  it('answers 200 with only this company backups while another company file cannot be decrypted', async () => {
    publish('tenant', 'tenant_a.json', 'Mi Empresa S.A.');
    publish('otra', 'otra_b.json', 'Otra Empresa S.A.');
    corrupt('otra_b.json');
    const before = disk();
    const read = vi.spyOn(fs, 'readFileSync');

    const response = await GET(listRequest(), {} as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(names(body)).toEqual(['tenant_a.json']);
    expect(body.unreadable).toEqual([]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('otra_b.json');
    expect(serialized).not.toContain('Otra Empresa S.A.');
    // A listing never touches another company's bytes.
    expect(read.mock.calls.map((call) => String(call[0]))).not.toContain(path.join(dir, 'otra_b.json'));
    read.mockRestore();
    // Read side keeps every file byte-identical and creates no audit record.
    expect(disk()).toEqual(before);
    expect(state.auditLog).toEqual([]);
  });

  it('cannot be redirected to another company with a query parameter', async () => {
    publish('tenant', 'tenant_a.json', 'Mi Empresa S.A.');
    publish('otra', 'otra_b.json', 'Otra Empresa S.A.');

    const body = await (await GET(listRequest('companyId=otra'), {} as never)).json();

    expect(names(body)).toEqual(['tenant_a.json']);
    expect(JSON.stringify(body)).not.toContain('otra_b.json');
  });
});

describe('same-company unreadable files are surfaced, never hidden', () => {
  it('reports the preserved unreadable file next to the readable history', async () => {
    publish('tenant', 'tenant_ok.json', 'Mi Empresa S.A.');
    publish('tenant', 'tenant_danado.json', 'Mi Empresa S.A.');
    corrupt('tenant_danado.json');
    const before = disk();

    const response = await GET(listRequest(), {} as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(names(body)).toEqual(['tenant_ok.json']);
    expect(body.unreadable).toHaveLength(1);
    expect(body.unreadable[0].filename).toBe('tenant_danado.json');
    expect(body.unreadable[0].error).toMatch(/decryp/i);
    // Preserved exactly: no repair, no deletion, no index rewrite.
    expect(disk()).toEqual(before);
  });

  it('never claims an unreadable file the catalog cannot attribute to the caller', async () => {
    publish('tenant', 'tenant_ok.json', 'Mi Empresa S.A.');
    fs.writeFileSync(path.join(dir, 'desconocido.json'), '{ esto no es un respaldo }');
    const before = disk();

    const response = await GET(listRequest(), {} as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(names(body)).toEqual(['tenant_ok.json']);
    expect(body.unreadable).toEqual([]);
    expect(disk()).toEqual(before);
  });
});

describe('unchanged contracts', () => {
  it('keeps publication bounded and pruning fail-closed while any catalog file is unreadable', () => {
    publish('tenant', 'tenant_a.json', 'Mi Empresa S.A.');
    publish('otra', 'otra_b.json', 'Otra Empresa S.A.');
    corrupt('otra_b.json');
    const before = disk();

    const result = publishBackup('tenant_nuevo.json', localText(makeSnapshot({
      companyId: 'tenant', legalName: 'Mi Empresa S.A.',
    })));

    // Publication and maintenance are separate: the snapshot is stored, while the
    // catalog rewrite and retention are skipped and the uncertainty is surfaced.
    expect(result.catalogUpdated).toBe(false);
    expect(result.warning?.code).toBe('BACKUP_CATALOG_UNVERIFIED');
    // Pruning stays fail-closed: it never deletes from an unverified inventory.
    expect(() => pruneBackups({ policy: { count: 1, days: 0 } })).toThrow(/decryp/i);
    // Every pre-existing file — including the unreadable one — is byte-identical.
    const after = disk();
    for (const [name, bytes] of Object.entries(before)) expect(after[name]).toBe(bytes);
    expect(Object.keys(after).filter((name) => !(name in before))).toEqual(['tenant_nuevo.json']);
  });

  it('keeps the list record shape and still discovers a readable file missing from the index', async () => {
    publish('tenant', 'tenant_a.json', 'Mi Empresa S.A.');
    const orphan = localText(makeSnapshot({ companyId: 'tenant', legalName: 'Mi Empresa S.A.' }));
    fs.writeFileSync(path.join(dir, 'tenant_huerfano.json'), orphan);

    const response = await GET(listRequest(), {} as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.unreadable).toEqual([]);
    expect(names(body).sort()).toEqual(['tenant_a.json', 'tenant_huerfano.json']);
    const record = body.backups.find((row: { filename: string }) => row.filename === 'tenant_huerfano.json');
    // The record shape is a contract: the tooltip adds the directory this
    // installation stores the file in. `createdBy` appears only when the file
    // recorded a creator, so it is not part of the unconditional shape.
    expect(Object.keys(record).sort()).toEqual(
      ['companyInfo', 'createdAt', 'destination', 'filename', 'id', 'recordCounts', 'size'].sort(),
    );
    expect(record.destination).toBe(dir);
    expect(record.size).toBe(Buffer.byteLength(orphan, 'utf8'));
    expect(record.companyInfo).toEqual({ id: 'tenant', legalName: 'Mi Empresa S.A.' });
    expect(fs.readFileSync(path.join(dir, 'tenant_huerfano.json'), 'utf8')).toBe(orphan);
  });
});
