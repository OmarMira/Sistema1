import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createPortableContainer, openPortableContainer } from '@/lib/backup-portable';
import { sealSnapshot } from '@/lib/backup-format';
import { COMPANY_ID, COMPANY_LEGAL_NAME, OPEN_CONTEXT, OWNER, OWNER_VERIFIED_AT, SOURCE_PASSWORD, makeSnapshot } from './helpers';
import { ForbiddenError } from '@/lib/api-error';

/**
 * Public-interface tests for the recovery/backup HTTP routes.
 *
 * Only infrastructure is mocked (the API guard chain, the database, sessions and
 * the workflow/storage collaborators). Everything that decides the response —
 * payload validation, status mapping, leak prevention and the real AEAD portable
 * container — is the production code.
 */
const mocks = vi.hoisted(() => ({
  requestChallenge: vi.fn(),
  complete: vi.fn(),
  createPortableBackup: vi.fn(),
  buildPortableRecoveryFile: vi.fn(),
  getBackupFile: vi.fn(),
  createSession: vi.fn(async () => 'session-token-fixture'),
  requireCompanyRole: vi.fn(async () => undefined),
  user: {
    findUnique: vi.fn(async () => ({
      id: OWNER.id, email: OWNER.email, firstName: 'Owner', lastName: 'Origin', platformRole: 'super_admin',
    })),
    findMany: vi.fn(async () => []),
  },
  company: {
    count: vi.fn(async () => 0),
    findMany: vi.fn(async () => [{ id: COMPANY_ID, legalName: COMPANY_LEGAL_NAME, entityType: 'BUSINESS', taxId: null, isOnboardingComplete: true }]),
  },
  auditLog: { count: vi.fn(async () => 0) },
  companyMember: { findMany: vi.fn(async () => []) },
}));

vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: 'admin-1', companyId: COMPANY_ID }),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: mocks.requireCompanyRole }));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: async () => undefined }));
vi.mock('@/lib/sessions', () => ({ createSession: mocks.createSession }));
vi.mock('@/lib/auth', () => ({
  hashPassword: async (password: string) => `hashed:${password}`,
  verifyPassword: async (password: string, hash: string) => hash === `hashed:${password}`,
}));
vi.mock('@/lib/backup-recovery-lock', () => ({
  createPostgresRecoveryLockStore: () => ({ acquire: async () => true, release: async () => true }),
}));
vi.mock('@/lib/backup-recovery-mail', () => ({ createRecoveryMailTransport: () => null }));
vi.mock('@/lib/backup-recovery-auth', () => ({
  createPostgresRecoveryChallengeStore: () => ({}),
  requestPortableRecoveryChallenge: mocks.requestChallenge,
  completePortableRecovery: mocks.complete,
}));
vi.mock('@/lib/backup-recovery-provenance', () => ({
  createPostgresProvenanceRecorder: () => ({ record: async () => undefined }),
  createPortableDestinationRestore: () => async () => ({ status: 'refused', httpStatus: 500, code: 'UNUSED', message: '' }),
}));
vi.mock('@/lib/backup-restore', () => ({
  restoreCompanyBackupCoordinated: async () => ({ status: 'committed', operationId: 'op' }),
}));
vi.mock('@/lib/db', () => ({ db: { ...mocks, $queryRawUnsafe: async () => [] } }));
vi.mock('@/lib/backup', () => ({
  createPortableBackup: mocks.createPortableBackup,
  buildPortableRecoveryFile: mocks.buildPortableRecoveryFile,
  getBackupFile: mocks.getBackupFile,
  listBackups: () => [],
  listBackupInventory: () => ({ backups: [], unreadable: [] }),
  deleteBackup: () => ({ status: 'not_found' }),
}));

import { POST as bootstrapRestore } from '@/app/api/bootstrap/restore/route';
import { POST as createBackupRoute } from '@/app/api/backup/route';
import { GET as downloadRoute, POST as portableDownloadRoute } from '@/app/api/backup/[filename]/route';

const BASE = 'http://localhost:3000';
const routeContext = (filename = `${COMPANY_ID}_backup.json`) => ({
  params: Promise.resolve({ filename }),
});

function containerText(password = SOURCE_PASSWORD) {
  const snapshot = makeSnapshot();
  snapshot.data.glAccounts.push({ id: 'gl-private', companyId: COMPANY_ID, name: 'Cuenta privada' });
  snapshot.manifest.recordCounts.glAccounts = 1;
  sealSnapshot(snapshot);
  return createPortableContainer({
    snapshot,
    password,
    owner: {
      ownerUserId: OWNER.id, ownerEmail: OWNER.email, emailVerifiedAt: OWNER_VERIFIED_AT,
      legacyUser: false, verifiedAt: OWNER_VERIFIED_AT,
    },
    companyLegalName: COMPANY_LEGAL_NAME,
    createdAt: snapshot.manifest.createdAt,
  });
}

function multipart(fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value as never);
  return new NextRequest(`${BASE}/api/bootstrap/restore`, { method: 'POST', body: form });
}

function jsonRequest(url: string, body: unknown, method = 'POST', headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCompanyRole.mockResolvedValue(undefined);
});

describe('POST /api/bootstrap/restore — public contract', () => {
  it('never trusts a non-File multipart "file" field (no crash, explicit error)', async () => {
    const response = await bootstrapRestore(
      multipart({ file: 'not-a-file', password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('BACKUP_FILE_REQUIRED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('validates password and company name before the workflow runs', async () => {
    const noPassword = await bootstrapRestore(
      multipart({ file: new File(['{}'], 'b.json'), companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(noPassword.status).toBe(400);
    expect((await noPassword.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');

    const tooLong = await bootstrapRestore(
      multipart({ file: new File(['{}'], 'b.json'), password: 'x'.repeat(257), companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();

    const noCompany = await bootstrapRestore(
      multipart({ file: new File(['{}'], 'b.json'), password: SOURCE_PASSWORD }) as never,
      {} as never,
    );
    expect(noCompany.status).toBe(400);
    expect((await noCompany.json()).code).toBe('RECOVERY_COMPANY_REQUIRED');
  });

  it('requires the owner email that unlocks the file', async () => {
    const missing = await bootstrapRestore(
      multipart({ file: new File([containerText()], 'b.json'), password: SOURCE_PASSWORD, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('RECOVERY_EMAIL_REQUIRED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();

    const malformed = await bootstrapRestore(
      multipart({
        file: new File([containerText()], 'b.json'), password: SOURCE_PASSWORD,
        ownerEmail: 'not-an-email', companyName: COMPANY_LEGAL_NAME,
      }) as never,
      {} as never,
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe('RECOVERY_EMAIL_REQUIRED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('rejects an oversized base64 body before decoding it', async () => {
    const response = await bootstrapRestore(
      jsonRequest(`${BASE}/api/bootstrap/restore`, {
        data: 'A'.repeat(70_000_000), password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME,
      }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('BACKUP_TOO_LARGE');
  });

  it('reports the owner-token stage without leaking token, password or owner email', async () => {
    mocks.requestChallenge.mockResolvedValue({ status: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
    const response = await bootstrapRestore(
      multipart({ file: new File([containerText()], 'b.json'), password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ stage: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SOURCE_PASSWORD);
    expect(serialized).not.toContain(OWNER.email);
    expect(serialized).not.toMatch(/[a-f0-9]{64}/);
  });

  it.each([
    [409, 'DB_NOT_EMPTY'],
    [403, 'RECOVERY_OWNER_UNAVAILABLE'],
    [503, 'RECOVERY_MAIL_UNAVAILABLE'],
    [429, 'RECOVERY_TOO_MANY_ATTEMPTS'],
  ])('maps workflow refusal %s/%s to an explicit status', async (status, code) => {
    mocks.requestChallenge.mockResolvedValue({ status, code, message: 'refused' });
    const response = await bootstrapRestore(
      multipart({ file: new File([containerText()], 'b.json'), password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ error: 'refused', code });
    expect(body.data).toBeUndefined();
  });

  it('creates the owner session after a successful restore', async () => {
    mocks.complete.mockResolvedValue({
      status: 'restored', operationId: 'op-1', sessionUserId: OWNER.id, counts: { company: 1 },
    });
    const response = await bootstrapRestore(
      multipart({
        file: new File([containerText()], 'b.json'),
        password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME, token: 'a'.repeat(64),
      }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, stage: 'restored', operationId: 'op-1' });
    expect(JSON.stringify(body)).not.toContain('a'.repeat(64));
    expect(mocks.createSession).toHaveBeenCalledWith(OWNER.id);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('never reports success while the database outcome is uncertain', async () => {
    mocks.complete.mockResolvedValue({
      status: 'reconciliation_required', operationId: 'op-1', code: 'RECOVERY_RECONCILIATION_REQUIRED',
      message: 'uncertain',
    });
    const response = await bootstrapRestore(
      multipart({
        file: new File([containerText()], 'b.json'),
        password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME, token: 'b'.repeat(64),
      }) as never,
      {} as never,
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('RECOVERY_RECONCILIATION_REQUIRED');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/backup — encrypted portable export', () => {
  it('requires the owner password and returns no plaintext accounting data', async () => {
    const missing = await createBackupRoute(jsonRequest(`${BASE}/api/backup`, { companyId: COMPANY_ID }) as never, {} as never);
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(mocks.createPortableBackup).not.toHaveBeenCalled();
  });

  it('returns the AEAD container that the recovery flow can open', async () => {
    const text = containerText();
    mocks.createPortableBackup.mockResolvedValue({
      id: 'backup-1',
      filename: `${COMPANY_ID}_backup.json`,
      recoveryFilename: `${COMPANY_ID}_backup_recovery.json`,
      size: 100,
      portableSize: text.length,
      createdAt: '2026-01-05T10:00:00.000Z',
      data: Buffer.from(text, 'utf8').toString('base64'),
      recordCounts: makeSnapshot().manifest.recordCounts,
    });
    const response = await createBackupRoute(
      jsonRequest(`${BASE}/api/backup`, { companyId: COMPANY_ID, password: SOURCE_PASSWORD }) as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recoveryProtected).toBe(true);
    expect(body.recoveryFilename).toMatch(/_recovery\.json$/);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Cuenta privada');
    expect(serialized).not.toContain(OWNER.email);
    const opened = openPortableContainer(Buffer.from(body.data, 'base64').toString('utf8'), SOURCE_PASSWORD, OPEN_CONTEXT);
    expect(opened.payload.companyId).toBe(COMPANY_ID);
  });

  it.each([
    ['RECOVERY_OWNER_MISSING', 409],
    ['RECOVERY_OWNER_AMBIGUOUS', 409],
    ['RECOVERY_PASSWORD_MISMATCH', 400],
  ])('maps %s to %s without echoing the owner email', async (code, status) => {
    const error = Object.assign(new Error(`${code}: sanitized`), { code, name: 'PortableRecoveryError' });
    const { PortableRecoveryError } = await import('@/lib/backup-portable');
    mocks.createPortableBackup.mockRejectedValue(new PortableRecoveryError(code as never, 'sanitized'));
    const response = await createBackupRoute(
      jsonRequest(`${BASE}/api/backup`, { companyId: COMPANY_ID, password: SOURCE_PASSWORD }) as never,
      {} as never,
    );
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain(OWNER.email);
    expect(error.message).toContain(code);
  });
});

describe('/api/backup/[filename] — download paths', () => {
  it('never returns the internal snapshot as a downloadable file', async () => {
    const noPassword = await downloadRoute(jsonRequest(`${BASE}/api/backup/x?companyId=c`, {}, 'GET') as never, routeContext() as never);
    expect(noPassword.status).toBe(400);
    expect((await noPassword.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
  });

  it('serves the encrypted portable file on POST and refuses the internal plaintext read', async () => {
    const text = containerText();
    mocks.buildPortableRecoveryFile.mockResolvedValue({
      filename: `${COMPANY_ID}_backup_recovery.json`,
      data: Buffer.from(text, 'utf8').toString('base64'),
      size: text.length,
      payloadDigest: 'p'.repeat(64),
    });
    const response = await portableDownloadRoute(
      jsonRequest(`${BASE}/api/backup/${COMPANY_ID}_backup.json`, { password: SOURCE_PASSWORD }) as never,
      routeContext() as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.filename).toMatch(/_recovery\.json$/);
    expect(JSON.stringify(body)).not.toContain('Cuenta privada');
    expect(openPortableContainer(Buffer.from(body.data, 'base64').toString('utf8'), SOURCE_PASSWORD, OPEN_CONTEXT)
      .payload.companyId).toBe(COMPANY_ID);

    // S11: the internal snapshot is no longer serialized to the browser, not
    // even as base64; the in-app flows now use the restore routes.
    mocks.getBackupFile.mockReturnValue({ data: '{"internal":true}', size: 16 });
    const internal = await downloadRoute(
      jsonRequest(`${BASE}/api/backup/${COMPANY_ID}_backup.json?companyId=${COMPANY_ID}&internal=1`, {}, 'GET') as never,
      routeContext() as never,
    );
    expect(internal.status).toBe(400);
    expect((await internal.json()).code).toBe('INTERNAL_SNAPSHOT_DISABLED');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('rejects a filename outside the caller company or a traversal attempt', async () => {
    const foreign = await downloadRoute(
      jsonRequest(`${BASE}/api/backup/other_backup.json?companyId=c`, {}, 'GET') as never,
      routeContext('other_backup.json') as never,
    );
    expect(foreign.status).toBe(400);
    const traversal = await downloadRoute(
      jsonRequest(`${BASE}/api/backup/..%2Fx.json?companyId=c`, {}, 'GET') as never,
      routeContext('../x.json') as never,
    );
    expect(traversal.status).toBe(400);
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
  });

  it('reports an unknown file as not found without leaking storage detail', async () => {
    mocks.buildPortableRecoveryFile.mockResolvedValue(null);
    const response = await portableDownloadRoute(
      jsonRequest(`${BASE}/api/backup/${COMPANY_ID}_backup.json`, { password: SOURCE_PASSWORD }) as never,
      routeContext() as never,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Backup file not found' });
  });
});

describe('route-level non-mutation on rejection', () => {
  it('does not create a session or touch the database counters for refused input', async () => {
    mocks.requestChallenge.mockResolvedValue({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH', message: 'no' });
    await bootstrapRestore(
      multipart({ file: new File([containerText()], 'b.json'), password: 'wrong-password-x', ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.company.count).not.toHaveBeenCalled();
    expect(mocks.auditLog.count).not.toHaveBeenCalled();
  });
});

describe('container binding', () => {
  it('binds the challenge to the exact uploaded bytes (route passes the file through unchanged)', async () => {
    mocks.requestChallenge.mockResolvedValue({ status: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
    const text = containerText();
    await bootstrapRestore(
      multipart({ file: new File([text], 'b.json'), password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    const passed = mocks.requestChallenge.mock.calls[0][1] as { fileText: string };
    expect(passed.fileText).toBe(text);
    expect(passed.fileText).toBe(new TextDecoder().decode(new TextEncoder().encode(text)));
    expect(crypto.createHash('sha256').update(passed.fileText, 'utf8').digest('hex')).toHaveLength(64);
  });
});

describe('download authorization — company_admin gate (restored)', () => {
  const downloadUrl = `${BASE}/api/backup/${COMPANY_ID}_backup.json?companyId=${COMPANY_ID}`;

  async function outcome(work: Promise<unknown>): Promise<{ statusCode?: number; code?: string } | 'resolved'> {
    try {
      await work;
      return 'resolved';
    } catch (error) {
      return error as { statusCode?: number; code?: string };
    }
  }

  it.each([
    ['GET', () => downloadRoute(jsonRequest(downloadUrl, {}, 'GET') as never, routeContext() as never)],
    ['POST', () => portableDownloadRoute(
      jsonRequest(`${BASE}/api/backup/${COMPANY_ID}_backup.json`, { password: SOURCE_PASSWORD }) as never,
      routeContext() as never,
    )],
  ])('refuses a non-admin caller on %s before any password or storage work', async (_verb, call) => {
    mocks.requireCompanyRole.mockRejectedValue(new ForbiddenError('Forbidden'));
    // apiHandler answers AppError(403/Forbidden) as a 403 response.
    expect(await outcome(call())).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(mocks.requireCompanyRole).toHaveBeenCalledWith(COMPANY_ID, ['company_admin']);
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('gates GET before the password check (no password supplied, no read)', async () => {
    mocks.requireCompanyRole.mockRejectedValue(new ForbiddenError('Forbidden'));
    expect(await outcome(downloadRoute(
      jsonRequest(downloadUrl, {}, 'GET') as never,
      routeContext() as never,
    ))).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
  });

  it('keeps asking a company admin for the owner password', async () => {
    const response = await downloadRoute(jsonRequest(downloadUrl, {}, 'GET') as never, routeContext() as never);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');
    expect(mocks.requireCompanyRole).toHaveBeenCalledWith(COMPANY_ID, ['company_admin']);
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });

  it('keeps the internal plaintext read closed for a company admin', async () => {
    const response = await downloadRoute(
      jsonRequest(`${downloadUrl}&internal=1`, {}, 'GET') as never,
      routeContext() as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INTERNAL_SNAPSHOT_DISABLED');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });
});
