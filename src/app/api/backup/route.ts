import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { createBackup, listBackups, deleteBackup } from '@/lib/backup';
import { createAuditLogWithRetry } from '@/lib/audit';
import { verifyPassword } from '@/lib/auth';

/**
 * S7 — sudo-style creation. The authenticated administrator must re-enter their
 * own password; only the derived verifier (scrypt, inside the sealed manifest)
 * is written into the backup. The received password is used for the bcrypt
 * comparison and the verifier derivation, then discarded: it is never stored,
 * never audited and never echoed.
 */
async function requestedPassword(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('multipart/form-data')) {
      return (await request.formData()).get('password');
    }
    const body = (await request.json()) as { password?: unknown } | null;
    return body?.password;
  } catch {
    // No readable body: treated as a missing password, never as success.
    return undefined;
  }
}

/**
 * POST /api/backup — Create a full backup for a company
 * Body: { password: string } — the caller's own password (re-entered).
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  await requireCompanyRole(companyId, ['company_admin']);

  const password = await requestedPassword(request);
  if (typeof password !== 'string' || password.length === 0) {
    return NextResponse.json(
      { error: 'Ingresá tu contraseña para crear el respaldo.', code: 'BACKUP_PASSWORD_REQUIRED' },
      { status: 400 },
    );
  }

  const actor = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!actor?.passwordHash || !(await verifyPassword(password, actor.passwordHash))) {
    return NextResponse.json(
      { error: 'La contraseña no es correcta. No se creó el respaldo.', code: 'INVALID_BACKUP_PASSWORD' },
      { status: 400 },
    );
  }

  const result = await createBackup(companyId, undefined, { ownerPassword: password });

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
    }),
  });

  return NextResponse.json({
    id: result.id,
    filename: result.filename,
    size: result.size,
    createdAt: result.createdAt,
    data: result.data,
    recordCounts: result.recordCounts,
  });
});

/**
 * GET /api/backup — List backups for a company
 * Query: ?companyId=xxx
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const backups = listBackups(companyId);

  return NextResponse.json({ backups });
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
