import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Reported failure (T10 / S14): `POST /api/backup` answered 400
 * RECOVERY_PASSWORD_REQUIRED while the UI the operator was running showed no
 * password field at all. The response itself is correct — a backup is created
 * WITH the portable owner credential (S3) — so these tests pin the required
 * behavior and prove the accepted password reaches the workflow unchanged and
 * is never stored, echoed or audited.
 */
const mocks = vi.hoisted(() => ({
  createPortableBackup: vi.fn(),
  audit: [] as unknown[],
  ownerLookups: [] as unknown[],
  ownerCredentialReads: 0,
}));

vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: 'admin-tenant', companyId: 'tenant' }),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: async () => undefined }));
vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: async (entry: unknown) => {
    mocks.audit.push(entry);
  },
}));
vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findMany: async (query: unknown) => {
        mocks.ownerLookups.push(query);
        return [];
      },
      findUnique: async () => {
        mocks.ownerCredentialReads += 1;
        throw new Error('no owner credential may be read for a rejected password');
      },
    },
  },
  withCompanyBackupTransaction: async () => {
    throw new Error('no snapshot may be taken for a rejected password');
  },
}));
vi.mock('@/lib/backup', () => ({
  createPortableBackup: mocks.createPortableBackup,
  buildPortableRecoveryFile: vi.fn(),
  getBackupFile: vi.fn(),
  listBackups: () => [],
  listBackupInventory: () => ({ backups: [], unreadable: [] }),
  deleteBackup: () => ({ status: 'not_found' }),
}));

import { POST } from '@/app/api/backup/route';

const BASE = 'http://localhost:3000';

function jsonRequest(body: unknown) {
  return new NextRequest(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.length = 0;
  mocks.ownerLookups.length = 0;
  mocks.ownerCredentialReads = 0;
});

describe('POST /api/backup — owner password is required', () => {
  it('refuses a missing password with the exact message and creates nothing', async () => {
    const response = await POST(jsonRequest({ companyId: 'tenant' }), {} as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Se requiere la contraseña del propietario (superadministrador) para proteger el respaldo.',
      code: 'RECOVERY_PASSWORD_REQUIRED',
    });
    expect(mocks.createPortableBackup).not.toHaveBeenCalled();
    expect(mocks.audit).toEqual([]);
  });

  it('rejects a short password before resolving any owner credential', async () => {
    const real = await vi.importActual<typeof import('@/lib/backup')>('@/lib/backup');

    for (const password of ['', 'corto7!', 'x'.repeat(257)]) {
      const error = await real
        .createPortableBackup({ companyId: 'tenant', createdByUserId: 'admin-tenant', password })
        .catch((failure: Error & { code?: string }) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('RECOVERY_PASSWORD_REQUIRED');
      expect(error.message).toBe(
        'RECOVERY_PASSWORD_REQUIRED: The source owner password must be between 8 and 256 characters',
      );
    }
    // Fail closed: no owner lookup, no credential read, no snapshot transaction.
    expect(mocks.ownerLookups).toEqual([]);
    expect(mocks.ownerCredentialReads).toBe(0);
  });

  it('delivers the accepted password to the workflow unchanged', async () => {
    mocks.createPortableBackup.mockResolvedValue({
      id: 'backup-1',
      filename: 'tenant_backup.json',
      recoveryFilename: 'tenant_backup_recovery.json',
      size: 10,
      portableSize: 20,
      createdAt: '2026-01-05T10:00:00.000Z',
      data: 'ZW5jcnlwdGVk',
      recordCounts: { company: 1 },
    });
    const password = '  Ñandú clave 1  ';

    const response = await POST(jsonRequest({ companyId: 'tenant', password }), {} as never);

    expect(response.status).toBe(200);
    expect(mocks.createPortableBackup).toHaveBeenCalledTimes(1);
    expect(mocks.createPortableBackup).toHaveBeenCalledWith({
      companyId: 'tenant',
      createdByUserId: 'admin-tenant',
      password,
    });
    // Never echoed and never audited.
    expect(JSON.stringify(await response.clone().json())).not.toContain(password);
    expect(JSON.stringify(mocks.audit)).not.toContain(password);
    expect(mocks.audit).toHaveLength(1);
  });
});
