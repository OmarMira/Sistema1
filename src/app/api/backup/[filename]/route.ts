import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { buildPortableRecoveryFile } from '@/lib/backup';
import { PortableRecoveryError } from '@/lib/backup-portable';
import { createAuditLogWithRetry } from '@/lib/audit';

/**
 * Backup file transport.
 *
 * A backup contains the full ledger and PII, so the DOWNLOAD path never hands
 * out the internal plaintext snapshot: it returns the real encrypted portable
 * file, re-sealed from the stored snapshot with the owner password supplied by
 * the caller (reauthenticated server-side). Without a password nothing leaves
 * the server.
 *
 * AUTHORIZATION (unchanged from the internal path): both verbs require
 * `company_admin` for the caller's company, and the role gate runs BEFORE any
 * filename validation result, password handling, storage read or attempt budget
 * — a read-only or employee caller gets 403 and no work is done on its behalf.
 *
 * The in-app restore flow does NOT read the snapshot here: `?internal=1` used
 * to hand the plaintext snapshot to the browser and is refused. Restore and
 * preview resolve the stored snapshot server-side from a validated filename
 * (see /api/backup/restore), so no plaintext accounting data ever travels to
 * the client on this path.
 */
function invalidFilename(companyId: string, filename: string): boolean {
  return (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.startsWith(`${companyId}_`) ||
    !filename.endsWith('.json')
  );
}

async function respondPortable(
  companyId: string,
  userId: string,
  filename: string,
  password: unknown,
) {
  if (typeof password !== 'string' || password.length === 0) {
    return NextResponse.json(
      {
        error: 'Se requiere la contraseña del propietario para descargar el respaldo cifrado.',
        code: 'RECOVERY_PASSWORD_REQUIRED',
      },
      { status: 400 },
    );
  }
  let file: Awaited<ReturnType<typeof buildPortableRecoveryFile>>;
  try {
    file = await buildPortableRecoveryFile({ companyId, filename, password });
  } catch (error) {
    if (error instanceof PortableRecoveryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }
  if (!file) {
    return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
  }
  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'SECURITY_BACKUP_DOWNLOADED',
    entity: 'Backup',
    entityId: filename,
    details: JSON.stringify({
      contractVersion: 1,
      filename,
      size: file.size,
      portable: true,
    }),
  });
  return NextResponse.json({
    filename: file.filename,
    size: file.size,
    data: file.data,
    recoveryProtected: true,
  });
}

/** GET /api/backup/[filename]?companyId=xxx[&internal=1] */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { filename } = await context.params;

  await requireCompanyRole(companyId, ['company_admin']);

  if (invalidFilename(companyId, filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  if (request.nextUrl.searchParams.get('internal') === '1') {
    // CLOSED (S11): the stored snapshot is never serialized to the browser, not
    // even as base64. The in-app flows call /api/backup/restore and
    // /api/backup/restore/preview with `{ filename }`, which look the file up
    // server-side after the same tenant/format validation used here.
    return NextResponse.json(
      {
        error:
          'La lectura interna del respaldo está deshabilitada. Usá la restauración del servidor con el nombre del archivo.',
        code: 'INTERNAL_SNAPSHOT_DISABLED',
      },
      { status: 400 },
    );
  }

  return respondPortable(companyId, userId, filename, request.headers.get('x-backup-password'));
});

/** POST /api/backup/[filename] — the encrypted portable download (no query secrets). */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { filename } = await context.params;

  await requireCompanyRole(companyId, ['company_admin']);

  if (invalidFilename(companyId, filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }
  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  return respondPortable(companyId, userId, filename, body?.password);
});
