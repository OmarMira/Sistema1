import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localText, makeSnapshot } from './helpers';

/**
 * Reported defect (consolidation record, known defect 1): `deleteBackup` read the
 * WHOLE catalog, so a single stored file that could not be decrypted — belonging to
 * ANOTHER company — turned a healthy tenant's DELETE into a 500 instead of the
 * neutral 404 that `GET` already guarantees.
 *
 * Rules pinned here:
 *  1. Deleting this company's own backup succeeds while an unreadable foreign file
 *     exists, and that foreign file is left byte-identical.
 *  2. A file that cannot be attributed to the caller answers `not_found`; it is never
 *     claimed, never deleted and never turned into an error.
 *  3. Deleting this company's OWN unreadable file answers `not_found` and leaves it
 *     on disk: an unprovable ownership is not a licence to delete.
 *
 * The scratch directory is synthetic and lives outside the worktree.
 */
const state = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sistema1-delete-scope-'));
  return { root };
});

vi.mock('@/lib/config/paths', () => ({
  BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'config', 'company-config.json') },
}));
vi.mock('@/lib/db', () => ({ db: {}, withCompanyBackupTransaction: vi.fn() }));

import { deleteBackup } from '@/lib/backup';
import { publishBackup } from '@/lib/backup-storage';

const dir = path.join(state.root, 'backups');
const FOREIGN = 'other_tenant_unreadable.json';

function publishOwn(companyId: string, filename: string, legalName = 'Mi Empresa S.A.') {
  const text = localText(makeSnapshot({ companyId, legalName }));
  publishBackup(filename, text);
  return filename;
}

function writeUnreadableForeign() {
  fs.mkdirSync(dir, { recursive: true });
  // Not a sealed snapshot of this installation: the catalog cannot decrypt it.
  const body = JSON.stringify({ sealed: 'bm90LWEtcmVhbC1zZWFs', manifest: { companyId: 'other' } });
  fs.writeFileSync(path.join(dir, FOREIGN), body);
  return body;
}

beforeEach(() => {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
});

afterAll(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('deleting one backup is scoped to its own company', () => {
  it('deletes the own backup while an unreadable foreign file exists, untouched', () => {
    const foreignBody = writeUnreadableForeign();
    const own = publishOwn('tenant', 'tenant_1.json');

    expect(deleteBackup(own, 'tenant')).toEqual({ status: 'deleted' });
    expect(fs.existsSync(path.join(dir, own))).toBe(false);
    expect(fs.readFileSync(path.join(dir, FOREIGN), 'utf8')).toBe(foreignBody);
  });

  it('answers not_found for a file it cannot attribute, without touching it', () => {
    const foreignBody = writeUnreadableForeign();

    expect(deleteBackup(FOREIGN, 'tenant')).toEqual({ status: 'not_found' });
    expect(fs.readFileSync(path.join(dir, FOREIGN), 'utf8')).toBe(foreignBody);
  });

  it('answers not_found for a missing file and never throws on an unreadable inventory', () => {
    writeUnreadableForeign();

    expect(deleteBackup('tenant_absent.json', 'tenant')).toEqual({ status: 'not_found' });
  });

  it('never deletes the own unreadable file it cannot prove', () => {
    writeUnreadableForeign();

    expect(deleteBackup(FOREIGN, 'other')).toEqual({ status: 'not_found' });
    expect(fs.existsSync(path.join(dir, FOREIGN))).toBe(true);
  });
});
