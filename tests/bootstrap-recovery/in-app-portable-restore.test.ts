import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ForbiddenError } from '@/lib/api-error';
import { COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD, makeSnapshot } from './helpers';

/**
 * Public contract of the in-app restore route with the portable door (S23/S24).
 *
 * Only infrastructure is mocked (the API guard chain, the database, sessions and
 * the portable engine). Everything this route owns — door selection, the
 * session-scoped authorization order, the destination handed to the engine, the
 * response mapping and the untouched internal-snapshot path — is production
 * code.
 */
const mocks = vi.hoisted(() => ({
  requestChallenge: vi.fn(),
  complete: vi.fn(),
  coordinated: vi.fn(),
  getSessionUserId: vi.fn(),
  requireCompanyRole: vi.fn(),
  requireActiveTenantAccess: vi.fn(),
  context: vi.fn(),
  userFindUnique: vi.fn(),
  getBackupFile: vi.fn(),
  destinationOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({ requireCompanyContext: () => mocks.context() }));
vi.mock('@/lib/rbac', () => ({
  requireActiveTenantAccess: mocks.requireActiveTenantAccess,
  requireCompanyRole: mocks.requireCompanyRole,
}));
vi.mock('@/lib/sessions', () => ({ getSessionUserId: mocks.getSessionUserId }));
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
  createPortableDestinationRestore: (options: Record<string, unknown>) => {
    mocks.destinationOptions.push(options);
    return async () => ({ status: 'refused', httpStatus: 500, code: 'UNUSED', message: '' });
  },
  loadRecoveryEvidence: async () => new Map(),
  RecoveryProvenanceError: class RecoveryProvenanceError extends Error {},
}));
vi.mock('@/lib/backup', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBackupFile: mocks.getBackupFile,
}));
vi.mock('@/lib/backup-restore', () => ({ restoreCompanyBackupCoordinated: mocks.coordinated }));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique },
    company: { count: async () => 0 },
    auditLog: { count: async () => 0 },
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 1,
  },
}));

import { POST as restoreRoute } from '@/app/api/backup/restore/route';
import { createPortableContainer } from '@/lib/backup-portable';

const BASE = 'http://localhost:3000';
const OWNER_VERIFIED_AT = '2026-01-02T00:00:00.000Z';

function portableText(snapshot = makeSnapshot()): string {
  return createPortableContainer({
    snapshot,
    password: SOURCE_PASSWORD,
    owner: {
      ownerUserId: OWNER.id, ownerEmail: OWNER.email, emailVerifiedAt: OWNER_VERIFIED_AT,
      legacyUser: false, verifiedAt: OWNER_VERIFIED_AT,
    },
    companyLegalName: COMPANY_LEGAL_NAME,
    createdAt: snapshot.manifest.createdAt,
  });
}

function upload(
  url: string,
  fields: Record<string, string | File>,
): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value as never);
  return new NextRequest(url, { method: 'POST', body: form });
}

function portableForm(text: string, extra: Record<string, string> = {}) {
  return {
    file: new File([text], 'recovery.json'),
    password: SOURCE_PASSWORD,
    ownerEmail: OWNER.email,
    companyName: COMPANY_LEGAL_NAME,
    ...extra,
  };
}

const settingsUrl = `${BASE}/api/backup/restore?mode=portable&door=settings&companyId=${COMPANY_ID}`;
const adminUrl = `${BASE}/api/backup/restore?mode=portable&door=admin`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.destinationOptions.length = 0;
  mocks.getSessionUserId.mockResolvedValue('admin-tenant');
  mocks.userFindUnique.mockResolvedValue({ email: OWNER.email, platformRole: 'super_admin' });
  mocks.context.mockReturnValue({ userId: 'admin-tenant', companyId: COMPANY_ID });
  mocks.requireCompanyRole.mockResolvedValue(undefined);
  mocks.requireActiveTenantAccess.mockResolvedValue(undefined);
  mocks.requestChallenge.mockResolvedValue({ status: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
  mocks.coordinated.mockResolvedValue({ status: 'committed', scope: 'database-and-company-config', operationId: 'op-int' });
});

describe('in-app portable door — door selection and authorization', () => {
  it('requires an explicit door', async () => {
    const response = await restoreRoute(
      upload(`${BASE}/api/backup/restore?mode=portable`, portableForm(portableText())) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RECOVERY_DOOR_REQUIRED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before parsing the body', async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const response = await restoreRoute(upload(adminUrl, portableForm(portableText())) as never, {} as never);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('AUTH_REQUIRED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('refuses the admin door to an account that is not the installation owner', async () => {
    mocks.userFindUnique.mockResolvedValue({ email: 'contador@example.test', platformRole: 'user' });
    const response = await restoreRoute(upload(adminUrl, portableForm(portableText())) as never, {} as never);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FORBIDDEN');
    // No promotion and no fallback: the engine is never reached.
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('requires the company administrator role on the settings door', async () => {
    mocks.requireCompanyRole.mockRejectedValue(new ForbiddenError('Forbidden'));
    await expect(
      restoreRoute(upload(settingsUrl, portableForm(portableText())) as never, {} as never),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });
});

describe('in-app portable door — destination handed to the engine (S23/S24)', () => {
  it('targets the backup company for the admin door', async () => {
    const response = await restoreRoute(upload(adminUrl, portableForm(portableText())) as never, {} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stage: 'challenge_sent' });
    expect(mocks.requestChallenge).toHaveBeenCalledTimes(1);
    const entry = mocks.requestChallenge.mock.calls[0][1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      destination: { mode: 'owner-admin' },
      sessionEmail: OWNER.email,
      companyLegalName: COMPANY_LEGAL_NAME,
      ownerEmail: OWNER.email,
      password: SOURCE_PASSWORD,
    });
    // The destination restore adds the backup's own company and never overwrites.
    expect(mocks.destinationOptions[0]).toMatchObject({ target: { mode: 'company', createIfAbsent: true } });
  });

  it('targets the ACTIVE company for the settings door', async () => {
    const response = await restoreRoute(upload(settingsUrl, portableForm(portableText())) as never, {} as never);

    expect(response.status).toBe(200);
    const entry = mocks.requestChallenge.mock.calls[0][1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      destination: { mode: 'active-company', companyId: COMPANY_ID },
      sessionEmail: OWNER.email,
    });
    expect(mocks.destinationOptions[0]).toMatchObject({
      target: { mode: 'company', companyId: COMPANY_ID },
    });
  });

  it('refuses a non-portable file on the portable door instead of feeding the KDF', async () => {
    const response = await restoreRoute(
      upload(settingsUrl, portableForm(JSON.stringify({ manifest: {}, data: {} }))) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RECOVERY_FILE_UNSUPPORTED');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('requires an actual file', async () => {
    const response = await restoreRoute(
      upload(settingsUrl, { password: SOURCE_PASSWORD, ownerEmail: OWNER.email, companyName: COMPANY_LEGAL_NAME }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('BACKUP_FILE_REQUIRED');
  });
});

describe('in-app portable door — responses', () => {
  it('completes with the token and never mints a second session', async () => {
    mocks.complete.mockResolvedValue({
      status: 'restored', operationId: 'op-9', sessionUserId: OWNER.id, counts: { company: 1 },
    });
    const response = await restoreRoute(
      upload(adminUrl, portableForm(portableText(), { token: 'a'.repeat(64) })) as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true, stage: 'restored', operationId: 'op-9', restoredCounts: { company: 1 },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    const entry = mocks.complete.mock.calls[0][1] as Record<string, unknown>;
    expect(entry).toMatchObject({ token: 'a'.repeat(64), destination: { mode: 'owner-admin' } });
  });

  it.each([
    [409, 'RECOVERY_COMPANY_EXISTS'],
    [409, 'RECOVERY_ACTIVE_COMPANY_MISMATCH'],
    [403, 'RECOVERY_SESSION_IDENTITY_MISMATCH'],
    [503, 'RECOVERY_MAIL_UNAVAILABLE'],
    [429, 'RECOVERY_TOO_MANY_ATTEMPTS'],
  ])('maps engine refusal %s/%s to an explicit status', async (status, code) => {
    mocks.requestChallenge.mockResolvedValue({ status, code, message: 'refused' });
    const response = await restoreRoute(upload(settingsUrl, portableForm(portableText())) as never, {} as never);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'refused', code });
  });

  it('never reports success while the database outcome is uncertain', async () => {
    mocks.complete.mockResolvedValue({
      status: 'reconciliation_required', operationId: 'op-unclear',
      code: 'RECOVERY_RECONCILIATION_REQUIRED', message: 'unclear',
    });
    const response = await restoreRoute(
      upload(adminUrl, portableForm(portableText(), { token: 'b'.repeat(64) })) as never,
      {} as never,
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.operationId).toBe('op-unclear');
    expect(JSON.stringify(body)).not.toContain('b'.repeat(64));
  });
});

describe('internal snapshot path is unchanged (PRESERVE)', () => {
  it('still refuses a snapshot without a manifest with the historical message', async () => {
    const response = await restoreRoute(
      upload(`${BASE}/api/backup/restore`, {
        companyId: COMPANY_ID,
        file: new File([JSON.stringify({ data: {} })], 'internal.json'),
      }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid backup:');
    expect(body.error).toContain('Missing manifest');
  });

  it('still refuses a portable container sent through the internal path', async () => {
    // Byte-identical to the historical behavior the reported incident produced:
    // the portable envelope is not a snapshot and validation refuses it first.
    const response = await restoreRoute(
      upload(`${BASE}/api/backup/restore`, {
        companyId: COMPANY_ID,
        file: new File([portableText()], 'recovery.json'),
      }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Missing manifest');
    expect(mocks.requestChallenge).not.toHaveBeenCalled();
  });

  it('still requires a file on a multipart internal upload', async () => {
    const response = await restoreRoute(
      upload(`${BASE}/api/backup/restore`, { companyId: COMPANY_ID }) as never,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No file uploaded' });
  });

  it('still restores from the server-side snapshot lookup for the caller company', async () => {
    const snapshot = makeSnapshot();
    mocks.getBackupFile.mockReturnValue({ data: JSON.stringify(snapshot) });
    mocks.coordinated.mockResolvedValue({
      status: 'committed', scope: 'database-and-company-config', operationId: 'op-int',
      counts: { company: 1 }, safetyFilename: 'safety.json',
    });

    const response = await restoreRoute(
      new NextRequest(`${BASE}/api/backup/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: `${COMPANY_ID}_ok.json` }),
      }) as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, operationId: 'op-int' });
    expect(mocks.coordinated).toHaveBeenCalledTimes(1);
  });

  it('still enforces the tenant check that the route used to inherit from the guard chain', async () => {
    mocks.requireActiveTenantAccess.mockRejectedValue(new ForbiddenError('Forbidden'));
    await expect(
      restoreRoute(
        upload(`${BASE}/api/backup/restore`, {
          companyId: COMPANY_ID,
          file: new File([JSON.stringify({ data: {} })], 'internal.json'),
        }) as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.coordinated).not.toHaveBeenCalled();
  });
});
