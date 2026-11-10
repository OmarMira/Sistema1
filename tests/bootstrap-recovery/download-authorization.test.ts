import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { COMPANY_ID } from './helpers';

/**
 * Download authorization at the HTTP boundary (S9-S11).
 *
 * This file deliberately mocks ONLY infrastructure (session resolution, the
 * database, the rate limiter, the maintenance gate, storage and audit). The real
 * `apiHandler`, the real `requireActiveTenantAccess`/`requireCompanyRole` and the
 * real route handlers are the production code, so a non-admin caller is observed
 * as an actual HTTP 403 with no password handling, no storage read and no
 * password-verification work.
 */
const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  userRole: { platformRole: 'employee' } as { platformRole: string } | null,
  membership: { role: 'viewer' } as { role: string; id?: string } | null,
  buildPortableRecoveryFile: vi.fn(),
  getBackupFile: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: mocks.getSessionUserId }));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: async () => mocks.userRole },
    company: { findUnique: async () => ({ isActive: true }) },
    companyMember: { findUnique: async () => mocks.membership },
  },
}));
vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: () => ({ allowed: true, limit: 100, remaining: 99, resetAt: 0 }),
}));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: () => null }));
vi.mock('@/lib/backup-runtime-maintenance', () => ({
  acquireNormalOperation: () => ({ run: <T>(work: () => Promise<T>) => work(), release: () => undefined }),
}));
vi.mock('@/lib/backup', () => ({
  buildPortableRecoveryFile: mocks.buildPortableRecoveryFile,
  getBackupFile: mocks.getBackupFile,
}));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: mocks.audit }));

import { GET, POST } from '@/app/api/backup/[filename]/route';

const BASE = 'http://localhost:3000';
const FILENAME = `${COMPANY_ID}_backup-2026-01-05.json`;
const URL_ = `${BASE}/api/backup/${FILENAME}?companyId=${COMPANY_ID}`;
const params = { params: Promise.resolve({ filename: FILENAME }) };

function get(url = URL_) {
  return GET(new NextRequest(url, { method: 'GET' }), params as never);
}

function post(url = `${BASE}/api/backup/${FILENAME}?companyId=${COMPANY_ID}`, body: unknown = { password: 'source-password-1' }) {
  return POST(
    new NextRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue('user-caller');
  mocks.userRole = { platformRole: 'employee' };
  mocks.membership = { role: 'viewer' };
  mocks.buildPortableRecoveryFile.mockResolvedValue({
    filename: `${COMPANY_ID}_backup-2026-01-05_recovery.json`,
    data: Buffer.from('sealed-container', 'utf8').toString('base64'),
    size: 16,
    payloadDigest: 'p'.repeat(64),
  });
  mocks.getBackupFile.mockReturnValue({ data: '{"internal":true}', size: 16 });
  mocks.audit.mockResolvedValue(undefined);
});

describe('GET /api/backup/[filename] — company_admin gate', () => {
  it.each(['viewer', 'employee'])('answers a real HTTP 403 to a %s caller and does no backup work', async (role) => {
    mocks.membership = { role };
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('gates before the password check and before the internal-read refusal', async () => {
    mocks.membership = { role: 'viewer' };
    // No password at all: an admin would get 400 RECOVERY_PASSWORD_REQUIRED.
    const noPassword = await get();
    expect(noPassword.status).toBe(403);
    // The closed internal read is not even evaluated for a non-admin.
    const internal = await get(`${URL_}&internal=1`);
    expect(internal.status).toBe(403);
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
  });

  it('refuses a caller without a session', async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
  });

  it('keeps serving a company admin (password still required)', async () => {
    mocks.membership = { role: 'company_admin' };
    const noPassword = await get();
    expect(noPassword.status).toBe(400);
    expect((await noPassword.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');

    mocks.buildPortableRecoveryFile.mockClear();
    const withPassword = await GET(
      new NextRequest(URL_, { method: 'GET', headers: { 'x-backup-password': 'source-password-1' } }),
      params as never,
    );
    expect(withPassword.status).toBe(200);
    expect(mocks.buildPortableRecoveryFile).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      filename: FILENAME,
      password: 'source-password-1',
    });
  });

  it('keeps accepting the platform super_admin bypass', async () => {
    mocks.userRole = { platformRole: 'super_admin' };
    mocks.membership = null;
    const response = await get();
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RECOVERY_PASSWORD_REQUIRED');
  });

  it('keeps the internal plaintext read closed for a company admin', async () => {
    mocks.membership = { role: 'company_admin' };
    const response = await get(`${URL_}&internal=1`);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INTERNAL_SNAPSHOT_DISABLED');
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/backup/[filename] — company_admin gate', () => {
  it.each(['viewer', 'employee'])('answers a real HTTP 403 to a %s caller with a valid-looking password', async (role) => {
    mocks.membership = { role };
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    // No password verification, no re-seal, no storage read happened.
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
    expect(mocks.getBackupFile).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('keeps serving a company admin', async () => {
    mocks.membership = { role: 'company_admin' };
    const response = await post();
    expect(response.status).toBe(200);
    expect((await response.json()).recoveryProtected).toBe(true);
    expect(mocks.buildPortableRecoveryFile).toHaveBeenCalledTimes(1);
  });

  it('still refuses a filename outside the caller company for an admin', async () => {
    mocks.membership = { role: 'company_admin' };
    const response = await POST(
      new NextRequest(`${BASE}/api/backup/other_backup.json?companyId=${COMPANY_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'source-password-1' }),
      }),
      { params: Promise.resolve({ filename: 'other_backup.json' }) } as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid filename');
    expect(mocks.buildPortableRecoveryFile).not.toHaveBeenCalled();
  });
});
