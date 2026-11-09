import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { createSession } from '@/lib/sessions';
import { logger } from '@/lib/logger';
import { RUNTIME_FILES } from '@/lib/config/paths';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';
import {
  completePortableRecovery, createPostgresRecoveryChallengeStore, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps, type RecoveryRawClient,
} from '@/lib/backup-recovery-auth';
import { createPostgresRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { createRecoveryMailTransport } from '@/lib/backup-recovery-mail';
import {
  createPortableDestinationRestore, createPostgresProvenanceRecorder, loadRecoveryEvidence,
  RecoveryProvenanceError,
  type PortableDestinationClient, type ProvenanceRawClient,
} from '@/lib/backup-recovery-provenance';
import { PORTABLE_LIMITS, normalizeOwnerEmail } from '@/lib/backup-portable';

const MAX_BACKUP_SIZE = 50 * 1024 * 1024;
/** Base64 expands by 4/3; bound the encoded string BEFORE decoding it. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_BACKUP_SIZE * 4 / 3) + 256;

/**
 * POST /api/bootstrap/restore — first-install portable recovery (S1-S6).
 *
 * Two explicit stages, both anonymous because the installation is empty by
 * definition and nothing else can be authorized yet:
 *
 *  1. WITHOUT `token`: open the identity-bound portable file with the owner
 *     password, the owner email and the company name (the password alone cannot
 *     open it), prove the SOURCE owner from the sealed backup credential and
 *     email a single-use token to that owner address. No destination account has
 *     to exist first. Nothing is mutated except bounded attempt budgets and the
 *     challenge draft.
 *  2. WITH `token`: repeat every check, consume the token atomically and run the
 *     existing coordinated replacement in portable provenance mode.
 *
 * Fail closed: no mail channel, wrong password/email/company/token, an expired or
 * used token, a concurrent recovery lease or an uncertain commit never answer
 * success. A zero-company installation WITH retained audit history is recoverable
 * (that history is preserved byte-identical); an installation that already has
 * companies is not.
 */
interface Payload {
  fileText: string;
  password: string;
  companyName: string;
  ownerEmail: string;
  token: string;
}

function bad(code: string, message: string, status = 400): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error: message, code }, { status }) };
}

async function readPayload(
  request: NextRequest,
): Promise<{ ok: true; payload: Payload } | { ok: false; response: NextResponse }> {
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
      return bad('BACKUP_FILE_INVALID', 'No se pudo leer el formulario enviado.');
    }
    const file = formData.get('file');
    // A hostile client can send a plain string field named "file"; casting it to
    // File would crash on `.name`/`.size`. Validate the instance instead.
    if (!(file instanceof File) || file.size === 0) {
      return bad('BACKUP_FILE_REQUIRED', 'No se subió ningún archivo de respaldo.');
    }
    password = formData.get('password') ?? formData.get('recoveryPassword');
    companyName = formData.get('companyName');
    ownerEmail = formData.get('ownerEmail') ?? formData.get('owner_email');
    token = formData.get('token') ?? '';
    if (file.size > MAX_BACKUP_SIZE) {
      return bad('BACKUP_TOO_LARGE', 'El archivo de respaldo supera el tamaño máximo (50MB).');
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.backup')) {
      return bad('BACKUP_FILE_INVALID', 'Extensión inválida. Solo archivos .json y .backup.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0 || bytes[0] !== 0x7b) {
      return bad('BACKUP_FILE_INVALID', 'Archivo inválido: no es un respaldo portable válido.');
    }
    fileText = new TextDecoder().decode(bytes);
  } else {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return bad('BACKUP_FILE_INVALID', 'Cuerpo de solicitud inválido.');
    password = body.password ?? body.recoveryPassword;
    companyName = body.companyName;
    ownerEmail = body.ownerEmail ?? body.owner_email;
    token = body.token ?? '';
    if (typeof body.data === 'string') {
      if (body.data.length === 0) return bad('BACKUP_FILE_REQUIRED', 'Se requiere el archivo del respaldo.');
      if (body.data.length > MAX_BASE64_LENGTH) {
        return bad('BACKUP_TOO_LARGE', 'El archivo de respaldo supera el tamaño máximo (50MB).');
      }
      fileText = Buffer.from(body.data, 'base64').toString('utf-8');
    } else if (typeof body.text === 'string') {
      fileText = body.text;
    }
  }

  if (typeof fileText !== 'string' || fileText.length === 0) {
    return bad('BACKUP_FILE_REQUIRED', 'Se requiere el archivo del respaldo.');
  }
  if (Buffer.byteLength(fileText, 'utf8') > PORTABLE_LIMITS.fileMaxBytes) {
    return bad('BACKUP_TOO_LARGE', 'El archivo de respaldo supera el tamaño máximo admitido.');
  }
  if (typeof password !== 'string' || password.length === 0) {
    return bad('RECOVERY_PASSWORD_REQUIRED', 'La contraseña del propietario es obligatoria.');
  }
  // Length is bounded BEFORE any (synchronous) key derivation runs.
  if (password.length < PORTABLE_LIMITS.passwordMin || password.length > PORTABLE_LIMITS.passwordMax) {
    return bad('RECOVERY_PASSWORD_REQUIRED', 'La contraseña debe tener entre 8 y 256 caracteres.');
  }
  if (typeof companyName !== 'string' || companyName.trim().length === 0 || companyName.length > 320) {
    return bad(
      'RECOVERY_COMPANY_REQUIRED',
      'Escribí el nombre de la empresa tal como estaba cargado en el respaldo.',
    );
  }
  // The owner email is an input of the file's key derivation, not a lookup:
  // it must be supplied, normalized by the SAME helper the container uses.
  const normalizedEmail = typeof ownerEmail === 'string' ? normalizeOwnerEmail(ownerEmail) : '';
  if (normalizedEmail.length === 0 || normalizedEmail.length > PORTABLE_LIMITS.ownerEmailMax ||
      !PORTABLE_LIMITS.emailPattern.test(normalizedEmail)) {
    return bad(
      'RECOVERY_EMAIL_REQUIRED',
      'Escribí el email del superadministrador propietario registrado en el respaldo.',
    );
  }
  return {
    ok: true,
    payload: {
      fileText,
      password,
      companyName,
      ownerEmail: normalizedEmail,
      token: typeof token === 'string' ? token.trim() : '',
    },
  };
}

/** Fence the installation when a post-commit proof cannot be produced. */
async function closeMaintenanceAfterUnprovenRestore(): Promise<void> {
  const gate = createMaintenanceGate(path.join(path.dirname(RUNTIME_FILES.companyConfig), 'backup-maintenance'));
  const owner = gate.beginMaintenance();
  await owner.drain({ timeoutMs: 5000 });
  // Deliberately never released: an unproven restore needs reconciliation.
}

export const POST = apiHandler(
  async (request: NextRequest) => {
    const parsed = await readPayload(request);
    if (!parsed.ok) return parsed.response;
    const { fileText, password, companyName, ownerEmail, token } = parsed.payload;

    const deps: PortableRecoveryDeps = {
      now: () => new Date(),
      challenges: createPostgresRecoveryChallengeStore(db as unknown as RecoveryRawClient),
      lock: createPostgresRecoveryLockStore(db as unknown as RecoveryRawClient),
      // Existing installation mail configuration; undefined means "no channel"
      // and recovery is blocked instead of silently skipping verification.
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
        // Retained destination audit rows are preserved, never re-signed. Their
        // only alternative certification is the archive written by an earlier
        // portable recovery on this installation. A table that does not exist
        // yet means "no archive here"; any other read failure refuses.
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

    // ── Stage 1: authorize and deliver the owner token ────────────────────
    if (!token) {
      const result = await requestPortableRecoveryChallenge(deps, {
        fileText,
        password,
        companyLegalName: companyName,
        ownerEmail,
      });
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
    const result = await completePortableRecovery(deps, {
      fileText,
      password,
      companyLegalName: companyName,
      ownerEmail,
      token,
    });

    if (result.status === 'reconciliation_required') {
      logger.error('bootstrap.recovery: restore needs operator reconciliation', {
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

    return buildSessionResponse(result.operationId, result.counts, result.sessionUserId);
  },
  { allowAnonymous: true, requireMembership: false },
);

/**
 * Session for the restored owner, identical to the login contract. The id comes
 * from the proven identity (source owner, or the proven local account when the
 * same person already had one), never from the request body.
 */
async function buildSessionResponse(
  operationId: string,
  counts: Record<string, number | boolean>,
  sessionUserId: string,
) {
  const sessionToken = await createSession(sessionUserId);
  const restoredUser = await db.user.findUnique({
    where: { id: sessionUserId },
    select: { id: true, email: true, firstName: true, lastName: true, platformRole: true },
  });

  const companies = restoredUser?.platformRole === 'super_admin'
    ? (await db.company.findMany({
        where: { isActive: true },
        select: { id: true, legalName: true, entityType: true, taxId: true, isOnboardingComplete: true },
        orderBy: { legalName: 'asc' },
      })).map((company) => ({ ...company, role: null }))
    : (await db.companyMember.findMany({
        where: { userId: sessionUserId },
        include: {
          company: { select: { id: true, legalName: true, entityType: true, taxId: true, isOnboardingComplete: true } },
        },
      })).map((membership) => ({ ...membership.company, role: membership.role }));

  const response = NextResponse.json({
    success: true,
    stage: 'restored',
    message: 'Sistema restaurado exitosamente',
    scope: 'database-and-company-config',
    operationId,
    restoredCounts: counts,
    user: restoredUser
      ? {
          id: restoredUser.id,
          email: restoredUser.email,
          firstName: restoredUser.firstName,
          lastName: restoredUser.lastName,
          role: restoredUser.platformRole,
        }
      : restoredUser,
    companies,
  });

  const isProd = process.env.NODE_ENV === 'production';
  response.cookies.set(isProd ? '__Host-session' : 'session', sessionToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  return response;
}
