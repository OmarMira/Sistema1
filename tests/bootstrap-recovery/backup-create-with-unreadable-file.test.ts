import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { localText, makeSnapshot } from './helpers';

/**
 * Reported creation failure (T10 / S14): a stored file that cannot be read made
 * `POST /api/backup` fail for every company, so the operator could not create a
 * backup at all.
 *
 * Rules pinned here (creation is driven through the public HTTP route and the
 * real storage/workflow code):
 *  1. Another company's unreadable file never blocks a new current-company
 *     backup; that file is left byte-identical and its catalog entry untouched.
 *  2. A current-company unreadable file does not block either, but stays
 *     protected and surfaced: it is never rewritten, deleted or hidden.
 *  3. When the inventory is uncertain, publication is separated from catalog
 *     maintenance: the index is not rewritten, retention/pruning is skipped, and
 *     the warning is explicit in the response (no foreign filename leaked).
 *  4. A readable catalog keeps the previous behavior exactly: index updated,
 *     retention still applied, no warning.
 *  5. Storage faults that leave no safe decision stay fail-closed: nothing is
 *     published.
 *
 * Synthetic DB rows and a synthetic scratch directory outside the worktree.
 */
const state = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sistema1-backup-create-'));
  const ownerPassword = 'clave-duena-1';
  const rows: Record<string, Array<Record<string, unknown>>> = {
    company: [{
      id: 'tenant', legalName: 'Mi Empresa S.A.', taxId: null, logo: null,
      entityType: 'BUSINESS', isActive: true, isOnboardingComplete: true,
      createdAt: new Date('2025-01-01T00:00:00.000Z'), updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    }],
    user: [{
      id: 'user-owner-tenant',
      email: 'dueno@example.test',
      firstName: 'Dueña',
      lastName: 'Origen',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      platformRole: 'super_admin',
      isActive: true,
      emailVerifiedAt: new Date('2025-01-02T00:00:00.000Z'),
      legacyUser: false,
      companyMemberships: [{ companyId: 'tenant' }],
      passwordHash: `hashed:${ownerPassword}`,
    }],
  };
  return { root, rows, ownerPassword, audit: [] as unknown[] };
});

vi.mock('@/lib/config/paths', () => ({
  BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'config', 'company-config.json') },
}));
vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: 'admin-tenant', companyId: 'tenant' }),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: async () => undefined }));
vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: async (entry: unknown) => {
    state.audit.push(entry);
  },
}));
vi.mock('@/lib/auth', () => ({
  hashPassword: async (value: string) => `hashed:${value}`,
  verifyPassword: async (value: string, hash: string) => hash === `hashed:${value}`,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/db', () => {
  const client = new Proxy({}, {
    get: (_target, model: string) => {
      // Metadata SQL is not reached: the synthetic snapshot has no JSON-nullable rows.
      if (model === '$queryRaw' || model === '$queryRawUnsafe') return async () => [];
      if (model === '$transaction') return async (work: (tx: unknown) => Promise<unknown>) => work(client);
      return {
        findMany: async () => state.rows[model] ?? [],
        findUnique: async () => (state.rows[model] ?? [])[0] ?? null,
      };
    },
  });
  return { db: client, withCompanyBackupTransaction: async (work: (tx: unknown) => Promise<unknown>) => work(client) };
});

import { GET, POST } from '@/app/api/backup/route';
import { publishBackup } from '@/lib/backup-storage';

const dir = path.join(state.root, 'backups');
const BASE = 'http://localhost:3000';
const WARNING = {
  code: 'BACKUP_CATALOG_UNVERIFIED',
  message:
    'The new backup was stored, but the backup catalog and retention cleanup were skipped because at least one ' +
    'stored backup file could not be read. Existing backup files were not changed or deleted.',
};
const previousRetentionDays = process.env.BACKUP_RETENTION_DAYS;

function publish(companyId: string, filename: string) {
  publishBackup(filename, localText(makeSnapshot({ companyId, legalName: `Empresa ${companyId} S.A.` })));
}

/** Flip one ciphertext byte: a well-formed envelope that can no longer authenticate. */
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
  for (const name of fs.readdirSync(dir).sort()) snapshot[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return snapshot;
}

function postRequest() {
  return new NextRequest(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ companyId: 'tenant', password: state.ownerPassword }),
  }) as never;
}

function getRequest() {
  return new NextRequest(`${BASE}/api/backup?companyId=tenant`, { method: 'GET' }) as never;
}

function created(before: Record<string, string>): string[] {
  return Object.keys(disk()).filter((name) => !(name in before));
}

beforeEach(() => {
  state.audit.length = 0;
  process.env.BACKUP_RETENTION_DAYS = '0';
  for (const name of fs.readdirSync(state.root)) fs.rmSync(path.join(state.root, name), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  if (previousRetentionDays === undefined) delete process.env.BACKUP_RETENTION_DAYS;
  else process.env.BACKUP_RETENTION_DAYS = previousRetentionDays;
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('creation with an unreadable stored backup', () => {
  it('stores a new current-company backup when another company file cannot be read, changing nothing else', async () => {
    publish('tenant', 'tenant_a.json');
    publish('otra', 'otra_b.json');
    corrupt('otra_b.json');
    const before = disk();

    const response = await POST(postRequest(), {} as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recoveryProtected).toBe(true);
    expect(body.catalogWarning).toEqual(WARNING);
    // No foreign filename and no foreign company data leaks into this response.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('otra_b.json');
    expect(serialized).not.toContain('Empresa otra');
    expect(state.audit).toHaveLength(1);

    const after = disk();
    const fresh = created(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^tenant_/);
    // Every pre-existing file, including the unreadable foreign one, is byte-identical.
    for (const [name, bytes] of Object.entries(before)) expect(after[name]).toBe(bytes);
    // The catalog is NOT rewritten while the inventory is uncertain.
    expect(after['manifest.json']).toBe(before['manifest.json']);

    // The published file is discoverable through the public read the UI uses —
    // files are authoritative, so an unverified index cannot hide it.
    const listed = await (await GET(getRequest(), {} as never)).json();
    expect(listed.backups.map((row: { filename: string }) => row.filename).sort())
      .toEqual(['tenant_a.json', fresh[0]].sort());
    expect(listed.unreadable).toEqual([]);
  });

  it('keeps a damaged current-company file protected and surfaced while still creating a backup', async () => {
    publish('tenant', 'tenant_ok.json');
    publish('tenant', 'tenant_danado.json');
    corrupt('tenant_danado.json');
    process.env.BACKUP_RETENTION_DAYS = '90';
    const before = disk();

    const response = await POST(postRequest(), {} as never);

    expect(response.status).toBe(200);
    expect((await response.json()).catalogWarning).toEqual(WARNING);

    const after = disk();
    const fresh = created(before);
    expect(fresh).toHaveLength(1);
    for (const [name, bytes] of Object.entries(before)) {
      // Untouched and never deleted, even though the age-based retention rule
      // would have pruned the older snapshots: pruning is refused while the
      // inventory is unverified.
      expect(after[name]).toBe(bytes);
    }
    expect(after['manifest.json']).toBe(before['manifest.json']);

    const listed = await (await GET(getRequest(), {} as never)).json();
    expect(listed.backups.map((row: { filename: string }) => row.filename).sort())
      .toEqual([fresh[0], 'tenant_ok.json'].sort());
    expect(listed.unreadable.map((row: { filename: string }) => row.filename)).toEqual(['tenant_danado.json']);
  });

  it('keeps the previous behavior for a fully readable catalog: index updated, retention applied, no warning', async () => {
    publish('tenant', 'tenant_viejo_a.json');
    publish('tenant', 'tenant_viejo_b.json');
    process.env.BACKUP_RETENTION_DAYS = '90';
    const before = disk();

    const response = await POST(postRequest(), {} as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('catalogWarning');

    const after = disk();
    const fresh = created(before);
    expect(fresh).toHaveLength(1);
    const index = JSON.parse(after['manifest.json']);
    expect(index.backups.map((row: { filename: string }) => row.filename)).toEqual([fresh[0]]);
    // Retention still removes the snapshots the policy no longer keeps.
    expect(after['tenant_viejo_a.json']).toBeUndefined();
    expect(after['tenant_viejo_b.json']).toBeUndefined();
  });

  it('stays fail-closed when the catalog cannot be inspected at all', async () => {
    publish('tenant', 'tenant_a.json');
    publish('otra', 'otra_b.json');
    corrupt('otra_b.json');
    const before = disk();
    const read = fs.readFileSync;
    const denied = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (String(file) === path.join(dir, 'manifest.json')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (read as (...rest: unknown[]) => unknown)(file, ...args);
    }) as never);

    await expect(POST(postRequest(), {} as never)).rejects.toThrow(/EACCES/);

    denied.mockRestore();
    expect(disk()).toEqual(before);
    expect(state.audit).toEqual([]);
  });
});
