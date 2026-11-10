import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireActiveTenantAccess, requireCompanyRole } from '@/lib/rbac';
import { getSessionUserId } from '@/lib/sessions';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import { getBackupFile, validateBackupForCoordinatedRestore, type BackupData } from '@/lib/backup';
import { logger } from '@/lib/logger';
import { RUNTIME_FILES } from '@/lib/config/paths';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';
import {
  completePortableRecovery, createPostgresRecoveryChallengeStore, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps, type PortableRecoveryDestination, type RecoveryRawClient,
} from '@/lib/backup-recovery-auth';
import { createPostgresRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { createRecoveryMailTransport } from '@/lib/backup-recovery-mail';
import {
  createPortableDestinationRestore, createPostgresProvenanceRecorder, loadRecoveryEvidence,
  RecoveryProvenanceError,
  type PortableDestinationClient, type PortableDestinationTarget, type ProvenanceRawClient,
} from '@/lib/backup-recovery-provenance';
import { PORTABLE_FORMAT, PORTABLE_LIMITS, normalizeOwnerEmail } from '@/lib/backup-portable';

/**
 * Server-side snapshot lookup for the in-app restore (S11).
 *
 * The browser only names a backup: the snapshot text is read here, after the
 * name is validated against the caller's company, so the plaintext accounting
 * content never leaves the installation. Storage re-validates the name again
 * (format + no traversal + no links) and the restore source check re-proves the
 * tenant identity inside the transaction.
 */
type SnapshotLookup = { text: string } | { status: number; code: string; error: string };

function readOwnedSnapshot(companyId: string, filename: unknown): SnapshotLookup {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.startsWith(`${companyId}_`) ||
    !filename.endsWith('.json')
  ) {
    return { status: 400, code: 'INVALID_BACKUP_FILENAME', error: 'Invalid filename' };
  }
  const stored = getBackupFile(filename);
  if (!stored) return { status: 404, code: 'BACKUP_FILE_NOT_FOUND', error: 'Backup file not found' };
  return { text: stored.data };
}

/**
 * POST /api/backup/restore — Restore from backup (in-app, session-authenticated)
 *
 * Two doors, one route (no second endpoint):
 *
 *  A. INTERNAL SNAPSHOT (unchanged): `filename` (server-side lookup) or `data`
 *     (base64) or a multipart upload, validated by
 *     `validateBackupForCoordinatedRestore` and replaced through the existing
 *     coordinated restore for the caller's company. Byte-identical behavior:
 *     same guards, same messages, same validation order.
 *
 *  B. PORTABLE OWNER-VERIFIED CONTAINER (S23/S24): declared with
 *     `?mode=portable&door=admin|settings`. It reuses the SAME engine the
 *     anonymous first-installation page uses (challenge token by email, single
 *     use/expiry/binding, throttling, identity mapping, retained-history
 *     preservation and the provenance archive), with two differences that only
 *     the door decides:
 *       - the session replaces the identity entry stage: the authenticated
 *         user's email must be the backup's owner email (S23/S25);
 *       - the destination is explicit. `door=admin` (Administración de Empresas)
 *         adds the BACKUP'S OWN company, which is why it works on a zero-company
 *         installation; `door=settings` (Configuración → Respaldos) requires the
 *         backup's company to be the ACTIVE company and replaces its data.
 *
 * Authorization runs BEFORE the body is parsed, so the internal path keeps its
 * exact refusal precedence. `apiHandler` is declared `requireMembership: false`
 * because the admin door is legitimately reachable with zero companies (a
 * session with no companyId); every branch below re-establishes the tenant and
 * role verification explicitly.
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('mode') === 'portable') {
    return handlePortableDoor(request, searchParams.get('door'));
  }

  const { userId, companyId } = requireCompanyContext();
  // `apiHandler` no longer performs the tenant check for this route (it must not
  // require a company for the admin door), so the internal path re-establishes
  // exactly the same guarantee before reading anything.
  const actor = await db.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });
  await requireActiveTenantAccess(companyId, {
    userId,
    role: typeof actor?.platformRole === 'string' ? actor.platformRole : '',
  });
  await requireCompanyRole(companyId, ['company_admin']);

  let backupData: BackupData;

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    // Handle FormData upload
    const formData = await request.formData();

    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const MAX_BACKUP_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_BACKUP_SIZE) {
      return NextResponse.json(
        { error: 'Backup file exceeds maximum size (50MB)' },
        { status: 400 },
      );
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.backup')) {
      return NextResponse.json(
        { error: 'Invalid file extension. Only .json and .backup files are allowed' },
        { status: 400 },
      );
    }

    const fileBuffer = await file.arrayBuffer();
    const firstByte = new Uint8Array(fileBuffer.slice(0, 1))[0];
    if (firstByte !== 0x7b && firstByte !== 0x5b) {
      return NextResponse.json({ error: 'Invalid backup file: not a JSON file' }, { status: 400 });
    }

    const jsonString = new TextDecoder().decode(fileBuffer);

    try {
      backupData = JSON.parse(jsonString) as BackupData;
    } catch {
      return NextResponse.json({ error: 'Invalid backup file: not valid JSON' }, { status: 400 });
    }
  } else {
    // Handle JSON body: either a server-side filename lookup or base64 data.
    const body = await request.json();

    if (body?.filename !== undefined) {
      const located = readOwnedSnapshot(companyId, body.filename);
      if ('status' in located) {
        return NextResponse.json(
          { error: located.error, code: located.code },
          { status: located.status },
        );
      }
      try {
        backupData = JSON.parse(located.text) as BackupData;
      } catch {
        return NextResponse.json(
          { error: 'Invalid backup data: not valid JSON', code: 'INVALID_BACKUP_DATA' },
          { status: 400 },
        );
      }
    } else {
      const base64Data = body.data;

      if (!base64Data) {
        return NextResponse.json({ error: 'companyId and data are required' }, { status: 400 });
      }

      try {
        const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8');
        backupData = JSON.parse(jsonString) as BackupData;
      } catch {
        return NextResponse.json(
          { error: 'Invalid backup data: not valid base64/JSON' },
          { status: 400 },
        );
      }
    }
  }

  // Validate backup structure. Company-format snapshots (2.x) are admitted here
  // and validated in depth by parseSnapshot inside the coordinated restore;
  // legacy versions still pass the full structural validator.
  const validation = validateBackupForCoordinatedRestore(backupData);
  if (!validation.valid) {
    return NextResponse.json(
      { error: `Invalid backup: ${validation.errors.join(', ')}` },
      { status: 400 },
    );
  }

  // Execute restore. The restored user role 'super_admin' is only preserved
  // when the authenticated actor is itself a global super_admin (RC2-3). The
  // authority context is derived from the current DB user, never from the
  // backup payload.
  const result = await restoreCompanyBackupCoordinated(companyId, JSON.stringify(backupData));

  if (result.status === 'aborted' || result.status === 'reconciliation_required') {
    return NextResponse.json({ error: result.error ?? 'Restore failed', status: result.status }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    scope: result.scope,
    status: result.status,
    message: 'Restore completed',
    restoredCounts: result.counts,
    operationId: result.operationId,
    safetyFilename: result.safetyFilename,
  });
}, { requireMembership: false });

/* ─── Portable owner-verified door (S23 / S24) ──────────────────────── */

const MAX_PORTABLE_SIZE = 50 * 1024 * 1024;
/** Base64 expands by 4/3; bound the encoded string BEFORE decoding it. */
const MAX_PORTABLE_BASE64 = Math.ceil(MAX_PORTABLE_SIZE * 4 / 3) + 256;

interface UploadedPortable {
  fileText: string;
  password: string;
  companyName: string;
  ownerEmail: string;
  token: string;
}

type PortableUpload =
  | { ok: true; payload: UploadedPortable }
  | { ok: false; response: NextResponse };

function badUpload(code: string, message: string, status = 400): PortableUpload {
  return { ok: false, response: NextResponse.json({ error: message, code }, { status }) };
}

/**
 * Structural read of the portable upload only. The authoritative envelope,
 * KDF and AEAD validation belongs to the engine (`readPortableHeader` /
 * `openPortableContainer`), so the two doors cannot drift from the bootstrap
 * door: everything that can be refused by the engine is refused by the engine.
 */
async function readPortableUpload(request: NextRequest): Promise<PortableUpload> {
  const contentType = request.headers.get('content-type') ?? '';
  let fileText: string | undefined;
  let password: unknown;
  let companyName: unknown;
  let ownerEmail: unknown;
  let token: unknown;

  if (contentType.includes('multipart/form-data')) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return badUpload('BACKUP_FILE_INVALID', 'No se pudo leer el formulario enviado.');
    }
    const file = formData.get('file');
    // A hostile client can send a plain string field named "file"; casting it to
    // File would crash on `.name`/`.size`. Validate the instance instead.
    if (!(file instanceof File) || file.size === 0) {
      return badUpload('BACKUP_FILE_REQUIRED', 'No se subió ningún archivo de respaldo portable.');
    }
    if (file.size > MAX_PORTABLE_SIZE) {
      return badUpload('BACKUP_TOO_LARGE', 'El archivo de respaldo supera el tamaño máximo (50MB).');
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.backup')) {
      return badUpload('BACKUP_FILE_INVALID', 'Extensión inválida. Solo archivos .json y .backup.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0 || bytes[0] !== 0x7b) {
      return badUpload('BACKUP_FILE_INVALID', 'Archivo inválido: no es un respaldo portable válido.');
    }
    fileText = new TextDecoder().decode(bytes);
    password = formData.get('password') ?? formData.get('recoveryPassword');
    companyName = formData.get('companyName');
    ownerEmail = formData.get('ownerEmail') ?? formData.get('owner_email');
    token = formData.get('token') ?? '';
  } else {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return badUpload('BACKUP_FILE_INVALID', 'Cuerpo de solicitud inválido.');
    password = body.password ?? body.recoveryPassword;
    companyName = body.companyName;
    ownerEmail = body.ownerEmail ?? body.owner_email;
    token = body.token ?? '';
    if (typeof body.data === 'string') {
      if (body.data.length === 0) return badUpload('BACKUP_FILE_REQUIRED', 'Se requiere el archivo del respaldo.');
      if (body.data.length > MAX_PORTABLE_BASE64) {
        return badUpload('BACKUP_TOO_LARGE', 'El archivo de respaldo supera el tamaño máximo (50MB).');
      }
      fileText = Buffer.from(body.data, 'base64').toString('utf-8');
    } else if (typeof body.text === 'string') {
      fileText = body.text;
    }
  }

  if (typeof fileText !== 'string' || fileText.length === 0) {
    return badUpload('BACKUP_FILE_REQUIRED', 'Se requiere el archivo del respaldo.');
  }
  if (Buffer.byteLength(fileText, 'utf8') > PORTABLE_LIMITS.fileMaxBytes) {
    return badUpload('BACKUP_TOO_LARGE', 'El archivo de respaldo supera el tamaño máximo admitido.');
  }
  // Detection only (no decryption): an internal snapshot posted to the portable
  // door is refused here instead of being fed to the KDF.
  if (!looksPortable(fileText)) {
    return badUpload(
      'RECOVERY_FILE_UNSUPPORTED',
      'El archivo seleccionado no es un respaldo portable cifrado del propietario.',
    );
  }
  return {
    ok: true,
    payload: {
      fileText,
      password: typeof password === 'string' ? password : '',
      companyName: typeof companyName === 'string' ? companyName : '',
      ownerEmail: normalizeOwnerEmail(typeof ownerEmail === 'string' ? ownerEmail : ''),
      token: typeof token === 'string' ? token.trim() : '',
    },
  };
}

/** Format string only: the engine performs the authoritative structural read. */
function looksPortable(fileText: string): boolean {
  try {
    const parsed = JSON.parse(fileText) as Record<string, unknown> | null;
    return !!parsed && typeof parsed === 'object' && parsed.format === PORTABLE_FORMAT;
  } catch {
    return false;
  }
}

async function handlePortableDoor(request: NextRequest, door: string | null): Promise<NextResponse> {
  if (door !== 'admin' && door !== 'settings') {
    return NextResponse.json(
      { error: 'Recovery door is required', code: 'RECOVERY_DOOR_REQUIRED' },
      { status: 400 },
    );
  }

  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, platformRole: true },
  });
  const sessionEmail = typeof user?.email === 'string' ? normalizeOwnerEmail(user.email) : '';
  if (sessionEmail.length === 0) {
    return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
  }
  const platformRole = typeof user?.platformRole === 'string' ? user.platformRole : '';

  let destination: PortableRecoveryDestination;
  if (door === 'admin') {
    // S23/S25: adding the backup's own company is the installation owner's
    // action. Nothing is promoted: any other account gets the existing refusal.
    if (platformRole !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
    }
    destination = { mode: 'owner-admin' };
  } else {
    const { companyId } = requireCompanyContext();
    await requireActiveTenantAccess(companyId, { userId, role: platformRole });
    await requireCompanyRole(companyId, ['company_admin']);
    destination = { mode: 'active-company', companyId };
  }

  const uploaded = await readPortableUpload(request);
  if (!uploaded.ok) return uploaded.response;
  const { fileText, password, companyName, ownerEmail, token } = uploaded.payload;

  const entry = {
    fileText,
    password,
    companyLegalName: companyName,
    ownerEmail,
    destination,
    sessionEmail,
  };
  const deps = createRecoveryDeps(destination);

  // ── Stage 1: authorize the source owner and email the token ───────────
  if (!token) {
    const result = await requestPortableRecoveryChallenge(deps, entry);
    if ('code' in result) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    }
    return NextResponse.json({
      stage: 'challenge_sent',
      expiresAt: result.expiresAt,
      message: 'Te enviamos un código al email del propietario registrado en el respaldo.',
    });
  }

  // ── Stage 2: consume the token and restore ───────────────────────────
  const result = await completePortableRecovery(deps, { ...entry, token });

  if (result.status === 'reconciliation_required') {
    logger.error('backup.recovery: restore needs operator reconciliation', {
      operationId: result.operationId,
      code: result.code,
    });
    return NextResponse.json(
      {
        error:
          'La restauración quedó pendiente de reconciliación y el sistema está en mantenimiento. ' +
          'No reintentes: contactá al soporte técnico con este identificador de operación ' +
          `${result.operationId}.`,
        code: result.code,
        operationId: result.operationId,
      },
      { status: 500 },
    );
  }
  if (result.status !== 'restored') {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }

  // The session already exists: this door never mints a new one. The caller
  // refreshes its own company list (the admin door reloads it, the settings door
  // refreshes its backup history).
  return NextResponse.json({
    success: true,
    stage: 'restored',
    operationId: result.operationId,
    restoredCounts: result.counts,
  });
}

/** Fence the installation when a post-commit proof cannot be produced. */
async function closeMaintenanceAfterUnprovenRestore(): Promise<void> {
  const gate = createMaintenanceGate(path.join(path.dirname(RUNTIME_FILES.companyConfig), 'backup-maintenance'));
  const owner = gate.beginMaintenance();
  await owner.drain({ timeoutMs: 5000 });
  // Deliberately never released: an unproven restore needs reconciliation.
}

/** The door decides the destination; everything else is the shared engine. */
function destinationTargetOf(destination: PortableRecoveryDestination): PortableDestinationTarget {
  if (destination.mode === 'owner-admin') return { mode: 'company', createIfAbsent: true };
  if (destination.mode === 'active-company') return { mode: 'company', companyId: destination.companyId };
  return { mode: 'initialize' };
}

function createRecoveryDeps(destination: PortableRecoveryDestination): PortableRecoveryDeps {
  return {
    now: () => new Date(),
    challenges: createPostgresRecoveryChallengeStore(db as unknown as RecoveryRawClient),
    lock: createPostgresRecoveryLockStore(db as unknown as RecoveryRawClient),
    // Existing installation mail configuration; undefined means "no channel" and
    // recovery is blocked instead of silently skipping verification.
    mail: createRecoveryMailTransport(process.env),
    installationState: async () => {
      const [companies, audits] = await Promise.all([db.company.count(), db.auditLog.count()]);
      return { companies, audits };
    },
    restore: createPortableDestinationRestore({
      client: db as unknown as PortableDestinationClient,
      provenance: createPostgresProvenanceRecorder(db as unknown as ProvenanceRawClient),
      hashPassword,
      verifyPassword,
      closeMaintenance: closeMaintenanceAfterUnprovenRestore,
      target: destinationTargetOf(destination),
      // Retained destination audit rows are preserved, never re-signed. Their only
      // alternative certification is the archive written by an earlier portable
      // recovery on this installation. A table that does not exist yet means "no
      // archive here"; any other read failure refuses.
      readAuditArchive: async () => {
        try {
          const archive = await loadRecoveryEvidence('audit', null);
          return archive.size > 0 ? archive : undefined;
        } catch (error) {
          if (error instanceof RecoveryProvenanceError && error.code === 'RECOVERY_PROVENANCE_ABSENT') {
            return undefined;
          }
          throw error;
        }
      },
      coordinatedRestore: (companyId, text, mode, identityMap) =>
        restoreCompanyBackupCoordinated(companyId, text, mode, identityMap),
    }),
  };
}
