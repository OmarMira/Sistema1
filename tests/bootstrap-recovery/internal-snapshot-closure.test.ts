import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { COMPANY_ID, makeSnapshot } from './helpers';

/**
 * S11/S12 — the internal plaintext snapshot must never reach the browser.
 *
 * `GET /api/backup/[filename]?internal=1` used to return the stored snapshot as
 * base64; the in-app restore/preview fetched it and posted it back. The closure
 * keeps both flows working by resolving the snapshot server-side from a
 * validated filename, so these tests assert three things only:
 *
 *  1. the plaintext read path is refused and performs no storage read,
 *  2. restore/preview still work, resolved by validated filename,
 *  3. tenant isolation, authorization and the pre-existing upload/base64
 *     restore inputs behave exactly as before.
 *
 * Only infrastructure is mocked (guard chain, database, storage reader and the
 * restore/preview collaborators). Every response decision is production code.
 */
const CALLER_COMPANY = COMPANY_ID;
const OWNED_BACKUP = `${CALLER_COMPANY}_backup-2026-01-05.json`;
const FOREIGN_BACKUP = 'company-otra_backup-2026-01-05.json';

const mocks = vi.hoisted(() => ({
  getBackupFile: vi.fn(),
  buildPortableRecoveryFile: vi.fn(),
  validateBackupForCoordinatedRestore: vi.fn(),
  restoreCompanyBackupCoordinated: vi.fn(),
  previewCompanyRestore: vi.fn(),
  requireCompanyRole: vi.fn(),
  // The restore route now carries the portable door, so it re-establishes the
  // tenant check explicitly instead of inheriting it from the guard chain, and
  // reads the actor's platform role to do so.
  requireActiveTenantAccess: vi.fn(),
  userFindUnique: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: 'admin-1', companyId: CALLER_COMPANY }),
}));
vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: mocks.requireCompanyRole,
  requireActiveTenantAccess: mocks.requireActiveTenantAccess,
}));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: mocks.audit }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }));
vi.mock('@/lib/backup', () => ({
  getBackupFile: mocks.getBackupFile,
  buildPortableRecoveryFile: mocks.buildPortableRecoveryFile,
  validateBackupForCoordinatedRestore: mocks.validateBackupForCoordinatedRestore,
}));
vi.mock('@/lib/backup-restore', () => ({
  restoreCompanyBackupCoordinated: mocks.restoreCompanyBackupCoordinated,
  previewCompanyRestore: mocks.previewCompanyRestore,
}));

import { GET as downloadGET, POST as downloadPOST } from '@/app/api/backup/[filename]/route';
import { POST as restorePOST } from '@/app/api/backup/restore/route';
import { POST as previewPOST } from '@/app/api/backup/restore/preview/route';

const BASE = 'http://localhost:3000';
const params = (filename: string) => ({ params: Promise.resolve({ filename }) });

function jsonRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

const snapshot = makeSnapshot();
const storedText = JSON.stringify(snapshot);
const PREVIEW = {
  companyId: CALLER_COMPANY,
  checksum: 'c'.repeat(64),
  counts: snapshot.manifest.recordCounts,
  ids: { Company: [CALLER_COMPANY] },
  blockers: [] as string[],
  scope: 'database-only; runtime configuration and external assets are not written' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCompanyRole.mockResolvedValue(undefined);
  mocks.requireActiveTenantAccess.mockResolvedValue(undefined);
  mocks.userFindUnique.mockResolvedValue({ platformRole: 'company_admin' });
  mocks.audit.mockResolvedValue(undefined);
  mocks.validateBackupForCoordinatedRestore.mockReturnValue({ valid: true, errors: [] });
  mocks.getBackupFile.mockReturnValue({ data: storedText, size: storedText.length });
  mocks.restoreCompanyBackupCoordinated.mockResolvedValue({
    status: 'committed',
    scope: 'database-and-company-config',
    counts: { Company: 1 },
    operationId: 'op-1',
    safetyFilename: `${CALLER_COMPANY}_safety.json`,
  });
  mocks.previewCompanyRestore.mockResolvedValue(PREVIEW);
});

describe('internal plaintext snapshot read is closed (S11)', () => {
  it('refuses ?internal=1 instead of returning the snapshot text', async () => {
    const response = await downloadGET(
      jsonRequest(`${BASE}/api/backup/${OWNED_BACKUP}?companyId=${CALLER_COMPANY}&internal=1`, {}, 'GET'),
      params(OWNED_BACKUP) as never,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INTERNAL_SNAPSHOT_DISABLED');
    expect(body).not.toHaveProperty('data');
    expect(JSON.stringify(body)).not.toContain(snapshot.manifest.companyInfo.legalName);
    // The closure is a refusal, not a second transport: nothing is read.
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('still validates the filename before answering the refused mode', async () => {
    const response = await downloadGET(
      jsonRequest(`${BASE}/api/backup/${FOREIGN_BACKUP}?companyId=${CALLER_COMPANY}&internal=1`, {}, 'GET'),
      params(FOREIGN_BACKUP) as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid filename');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/backup/restore — server-side lookup by validated filename', () => {
  it('restores the stored snapshot without sending it to the browser', async () => {
    const response = await restorePOST(
      jsonRequest(`${BASE}/api/backup/restore?companyId=${CALLER_COMPANY}`, { filename: OWNED_BACKUP }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, status: 'committed', operationId: 'op-1' });
    expect(body).not.toHaveProperty('data');
    expect(JSON.stringify(body)).not.toContain(snapshot.manifest.companyInfo.legalName);

    expect(mocks.getBackupFile).toHaveBeenCalledExactlyOnceWith(OWNED_BACKUP);
    expect(mocks.restoreCompanyBackupCoordinated).toHaveBeenCalledTimes(1);
    const [companyId, text] = mocks.restoreCompanyBackupCoordinated.mock.calls[0] as [string, string];
    expect(companyId).toBe(CALLER_COMPANY);
    expect(JSON.parse(text)).toEqual(JSON.parse(storedText));
  });

  it('rejects another company filename without reading it', async () => {
    const response = await restorePOST(
      jsonRequest(`${BASE}/api/backup/restore`, { filename: FOREIGN_BACKUP }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_BACKUP_FILENAME');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
    expect(mocks.restoreCompanyBackupCoordinated).not.toHaveBeenCalled();
  });

  it.each([
    ['traversal', '../etc/backup.json'],
    ['separator', `${CALLER_COMPANY}_backup/../x.json`],
    ['absolute', `/${CALLER_COMPANY}_backup.json`],
    ['not a backup', `${CALLER_COMPANY}_backup.txt`],
    ['not a string', 42],
  ])('rejects a %s filename with an explicit code', async (_label, filename) => {
    const response = await restorePOST(
      jsonRequest(`${BASE}/api/backup/restore`, { filename }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_BACKUP_FILENAME');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('reports an unknown owned filename as not found without restoring', async () => {
    mocks.getBackupFile.mockReturnValue(null);
    const response = await restorePOST(
      jsonRequest(`${BASE}/api/backup/restore`, { filename: OWNED_BACKUP }) as never,
      {} as never,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('BACKUP_FILE_NOT_FOUND');
    expect(mocks.restoreCompanyBackupCoordinated).not.toHaveBeenCalled();
  });

  it('keeps the company-role gate ahead of the storage read', async () => {
    mocks.requireCompanyRole.mockRejectedValue(new Error('forbidden'));
    await expect(
      restorePOST(jsonRequest(`${BASE}/api/backup/restore`, { filename: OWNED_BACKUP }) as never, {} as never),
    ).rejects.toThrow('forbidden');
    expect(mocks.requireCompanyRole).toHaveBeenCalledWith(CALLER_COMPANY, ['company_admin']);
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
    expect(mocks.restoreCompanyBackupCoordinated).not.toHaveBeenCalled();
  });
});

describe('POST /api/backup/restore/preview — server-side lookup by validated filename', () => {
  it('previews the stored snapshot without returning its content', async () => {
    const response = await previewPOST(
      jsonRequest(`${BASE}/api/backup/restore/preview?companyId=${CALLER_COMPANY}`, { filename: OWNED_BACKUP }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PREVIEW);
    expect(mocks.getBackupFile).toHaveBeenCalledExactlyOnceWith(OWNED_BACKUP);
    const [companyId, text] = mocks.previewCompanyRestore.mock.calls[0] as [string, string];
    expect(companyId).toBe(CALLER_COMPANY);
    expect(text).toBe(storedText);
  });

  it('rejects another company filename without reading it', async () => {
    const response = await previewPOST(
      jsonRequest(`${BASE}/api/backup/restore/preview`, { filename: FOREIGN_BACKUP }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_BACKUP_FILENAME');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
    expect(mocks.previewCompanyRestore).not.toHaveBeenCalled();
  });

  it('reports an unknown owned filename as not found without previewing', async () => {
    mocks.getBackupFile.mockReturnValue(null);
    const response = await previewPOST(
      jsonRequest(`${BASE}/api/backup/restore/preview`, { filename: OWNED_BACKUP }) as never,
      {} as never,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('BACKUP_FILE_NOT_FOUND');
    expect(mocks.previewCompanyRestore).not.toHaveBeenCalled();
  });
});

describe('previous behavior of the touched code is unchanged', () => {
  it('keeps the multipart upload restore working', async () => {
    const form = new FormData();
    form.append('companyId', CALLER_COMPANY);
    form.append('file', new File([storedText], 'backup.json', { type: 'application/json' }));
    const response = await restorePOST(
      new NextRequest(`${BASE}/api/backup/restore`, { method: 'POST', body: form }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    const [companyId, text] = mocks.restoreCompanyBackupCoordinated.mock.calls[0] as [string, string];
    expect(companyId).toBe(CALLER_COMPANY);
    expect(JSON.parse(text)).toEqual(JSON.parse(storedText));
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('keeps the base64 restore payload working', async () => {
    const base64 = Buffer.from(storedText, 'utf8').toString('base64');
    const response = await restorePOST(
      jsonRequest(`${BASE}/api/backup/restore`, { data: base64 }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.restoreCompanyBackupCoordinated).toHaveBeenCalledTimes(1);
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('keeps rejecting a request with neither data nor filename', async () => {
    const response = await restorePOST(
      jsonRequest(`${BASE}/api/backup/restore`, {}) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('companyId and data are required');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('keeps the inline preview payload working', async () => {
    const response = await previewPOST(
      jsonRequest(`${BASE}/api/backup/restore/preview`, { data: storedText }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.previewCompanyRestore).toHaveBeenCalledExactlyOnceWith(CALLER_COMPANY, storedText);
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('keeps the inline preview rejecting a missing payload', async () => {
    const response = await previewPOST(
      jsonRequest(`${BASE}/api/backup/restore/preview`, {}) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('data required');
  });

  it('keeps the portable download asking for the owner password', async () => {
    const response = await downloadGET(
      jsonRequest(`${BASE}/api/backup/${OWNED_BACKUP}?companyId=${CALLER_COMPANY}`, {}, 'GET') as never,
      params(OWNED_BACKUP) as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('keeps the portable POST download serving the encrypted container', async () => {
    mocks.buildPortableRecoveryFile.mockResolvedValue({
      filename: `${CALLER_COMPANY}_backup-2026-01-05_recovery.json`,
      data: Buffer.from('sealed-container', 'utf8').toString('base64'),
      size: 16,
      payloadDigest: 'p'.repeat(64),
    });
    const response = await downloadPOST(
      jsonRequest(`${BASE}/api/backup/${OWNED_BACKUP}`, { password: 'source-password-1' }) as never,
      params(OWNED_BACKUP) as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recoveryProtected).toBe(true);
    expect(body.filename).toMatch(/_recovery\.json$/);
    expect(body).not.toHaveProperty('internal');
    expect(mocks.buildPortableRecoveryFile).toHaveBeenCalledWith({
      companyId: CALLER_COMPANY,
      filename: OWNED_BACKUP,
      password: 'source-password-1',
    });
  });
});
