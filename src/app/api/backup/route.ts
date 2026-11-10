import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { createPortableBackup, listBackupInventory, deleteBackup } from '@/lib/backup';
import { PortableRecoveryError } from '@/lib/backup-portable';
import { createAuditLogWithRetry } from '@/lib/audit';

/**
 * POST /api/backup — Create a full backup for a company.
 *
 * A backup is the artifact that later authorizes a first-install recovery, so it
 * is created WITH its portable owner-verified credential (S3). The password must
 * be the SOURCE owner account password: the server resolves the owner from its
 * own records, verifies the password with the canonical helper and only then
 * writes the AEAD envelope. The received password is never echoed or stored.
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  await requireCompanyRole(companyId, ['company_admin']);

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) {
    return NextResponse.json(
      {
        error: 'Se requiere la contraseña del propietario (superadministrador) para proteger el respaldo.',
        code: 'RECOVERY_PASSWORD_REQUIRED',
      },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof createPortableBackup>>;
  try {
    result = await createPortableBackup({ companyId, createdByUserId: userId, password });
  } catch (error) {
    if (error instanceof PortableRecoveryError) {
      const status = error.code === 'RECOVERY_OWNER_MISSING' || error.code === 'RECOVERY_OWNER_AMBIGUOUS'
        ? 409
        : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }

  // Audit Contract v1 — BACKUP_CREATED
  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'BACKUP_CREATED',
    entity: 'Backup',
    entityId: result.id,
    details: JSON.stringify({
      contractVersion: 1,
      filename: result.filename,
      size: result.size,
      recordCounts: result.recordCounts,
      recoveryProtected: true,
      portable: true,
      catalogVerified: !result.catalogWarning,
    }),
  });

  // `data` is the encrypted portable file (the whole accounting payload is
  // AEAD-sealed under the owner password); `filename` stays the internal catalog
  // entry used for history/retention. The owner email is never echoed.
  // `catalogWarning` is present only when the snapshot was stored but the
  // catalog/retention maintenance had to be skipped (uncertain inventory): the
  // operator sees the uncertainty instead of a silent partial success, and no
  // other tenant's file name is ever included.
  const payload: Record<string, unknown> = {
    id: result.id,
    filename: result.filename,
    recoveryFilename: result.recoveryFilename,
    size: result.size,
    portableSize: result.portableSize,
    createdAt: result.createdAt,
    data: result.data,
    recordCounts: result.recordCounts,
    recoveryProtected: true,
  };
  if (result.catalogWarning) payload.catalogWarning = result.catalogWarning;
  return NextResponse.json(payload);
});

/**
 * GET /api/backup — List backups for a company
 * Query: ?companyId=xxx (informational; the tenant comes from the session context)
 *
 * The answer is scoped to the caller company: another company's unreadable file
 * can no longer fail this request, and this company's own unreadable files are
 * listed under `unreadable` so the loss stays visible instead of becoming a 500.
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const { backups, unreadable } = listBackupInventory(companyId);

  // Resolve the creator name for display only. Unknown or deleted accounts stay
  // unnamed instead of inventing an identity; the id itself is never exposed.
  const creatorIds = [...new Set(backups.map((b) => b.createdBy).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const creators = creatorIds.length > 0
    ? await db.user.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const nameById = new Map(creators.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email]));
  const withCreators = backups.map((backup) => {
    const name = backup.createdBy ? nameById.get(backup.createdBy) : undefined;
    return name ? { ...backup, createdByName: name } : backup;
  });

  return NextResponse.json({ backups: withCreators, unreadable });
});

/**
 * DELETE /api/backup — Delete a specific backup
 * Body: { companyId: string, filename: string }
 */
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  await requireCompanyRole(companyId, ['company_admin']);

  const body = await request.json();
  const { filename } = body;

  if (!filename) {
    return NextResponse.json({ error: 'companyId and filename are required' }, { status: 400 });
  }

  // Ownership and path safety are delegated to deleteBackup (single source of
  // truth in lib/backup.ts). A malformed or cross-tenant filename is treated
  // as a single neutral state to avoid leaking backup existence.
  const result = deleteBackup(filename, companyId);

  if (result.status === 'invalid') {
    return NextResponse.json({ error: 'Invalid backup filename' }, { status: 400 });
  }

  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
  }

  // Audit Contract v1 — BACKUP_DELETED
  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'BACKUP_DELETED',
    entity: 'Backup',
    entityId: filename,
    details: JSON.stringify({
      contractVersion: 1,
      filename,
    }),
  });

  return NextResponse.json({ success: true, message: 'Backup deleted' });
});
