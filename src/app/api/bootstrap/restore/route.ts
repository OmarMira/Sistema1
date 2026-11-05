import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { validateBackupForCoordinatedRestore, type BackupData } from '@/lib/backup';
import { isCompanyFormat } from '@/lib/backup-format';
import { restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import { assertBackupOwnership } from '@/lib/backup-ownership';
import { AppError } from '@/lib/api-error';
import { hashPassword } from '@/lib/auth';
import { createSession } from '@/lib/sessions';
import { logger } from '@/lib/logger';

// B3.4: recovery password follows the SAME new-password policy as the product
// (min 8 chars — same rule as registerSchema.password and /api/settings/password).
const recoveryPasswordSchema = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres');

const MAX_BACKUP_SIZE = 50 * 1024 * 1024;

/**
 * Documented refusals of the restore core. They reach this handler either as a
 * typed AppError (`LegacyBackupFormatError`, `BackupOwnershipError`) or as the
 * core's own `RESTORE_<CODE>: <detail>` message, which the shared error handler
 * cannot recover a code from. Reporting the family code instead of a generic
 * `RESTORE_FAILED` keeps the operator's Spanish explanation and the machine
 * code the rest of the product already answers for the same refusal.
 *
 * Anything else (an unparsable payload, a missing section, an unexpected
 * transport fault) keeps the generic handling below: this map never invents a
 * refusal code and never changes whether a payload is admitted.
 */
const KNOWN_RESTORE_REFUSALS = [
  'RESTORE_LEGACY_FORMAT',
  'RESTORE_OWNERSHIP',
  'RESTORE_CHAIN',
  'RESTORE_SHELL',
] as const;

type KnownRestoreRefusal = (typeof KNOWN_RESTORE_REFUSALS)[number];

function isKnownRestoreRefusal(code: string): code is KnownRestoreRefusal {
  return (KNOWN_RESTORE_REFUSALS as readonly string[]).includes(code);
}

/**
 * The refusal as the operator should see it, or `null` for unknown errors.
 * The message is passed through verbatim: no wrapping, no re-translation.
 */
function knownRestoreRefusal(
  error: unknown,
): { code: KnownRestoreRefusal; message: string; status: number; details?: unknown } | null {
  const appCode = error instanceof AppError ? error.code : undefined;
  if (typeof appCode === 'string' && isKnownRestoreRefusal(appCode)) {
    return {
      code: appCode,
      message: (error as AppError).message,
      status: (error as AppError).statusCode,
      details: (error as AppError).details,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const prefixed = /^(RESTORE_[A-Z_]+):/.exec(message)?.[1];
  if (prefixed && isKnownRestoreRefusal(prefixed)) {
    return { code: prefixed, message, status: 400 };
  }

  return null;
}

/** Company entity types the shell company can be created with. */
const ENTITY_TYPES = ['INDIVIDUAL', 'BUSINESS'] as const;
function entityTypeOf(backupData: BackupData): (typeof ENTITY_TYPES)[number] {
  const candidates = [
    (backupData.data?.company?.[0] as { entityType?: unknown } | undefined)?.entityType,
    (backupData.manifest?.companyInfo as { entityType?: unknown } | undefined)?.entityType,
  ];
  const match = candidates.find((value): value is (typeof ENTITY_TYPES)[number] =>
    typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value),
  );
  return match ?? 'BUSINESS';
}

/**
 * Remove the minimum bootstrap state created moments ago by THIS request when
 * the restore refuses the payload before mutating anything. Without it a failed
 * attempt would leave a Company row behind and the (correct) empty-system gate
 * would answer 409 DB_NOT_EMPTY on every retry, bricking the first install.
 * Only the two rows this handler created are touched — never tenant data.
 */
async function discardBootstrapShell(companyId: string, userId: string): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await tx.companyMember.deleteMany({ where: { companyId, userId } });
      await tx.company.deleteMany({ where: { id: companyId } });
      await tx.user.deleteMany({ where: { id: userId } });
    });
  } catch (error) {
    logger.error('bootstrap.restore: could not discard bootstrap shell', {
      companyId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/bootstrap/restore — first-install restore ("Sistema vacío detectado").
 *
 * Admission is the EMPTY DATABASE itself: `company.count() === 0`, checked before
 * anything else. Nobody can call this endpoint on a system that has data (409
 * DB_NOT_EMPTY), and a first-install system is empty by definition — that is
 * enough, so no operator-exported setup token is required any more. Requiring an
 * environment variable that a non-technical user cannot set made the feature
 * unusable (503 before the request was even read).
 *
 * The payload must be the CURRENT company-format backup (2.x, the only format
 * this app produces). Legacy 1.x files keep their historical note: they cannot
 * be ingested on first install.
 *
 * A 2.1.0 backup is restored through the battle-tested coordinated path
 * (`restoreCompanyBackupCoordinated`): HMAC seals, maintenance gate, fidelity,
 * audit receipt and file reconciliation. That path requires the destination
 * company + user + membership to exist, so this handler first creates that
 * minimal shell in one transaction, using the ids/e-mail carried by the backup.
 * The restore then replaces the rows with the payload's (it never touches the
 * User credentials) — the recovery password typed by the operator is what makes
 * the restored installation owner able to log in.
 *
 * Body (multipart/form-data): `file` + `recoveryPassword` + `ownerPassword`
 * Body (JSON): { data: <base64 snapshot>, recoveryPassword, ownerPassword }
 *
 * S1/S2: `ownerPassword` is the credential of the super admin who created the
 * backup. It is verified BEFORE the bootstrap shell exists, so a stolen file
 * cannot install itself even on an empty system.
 */
export const POST = apiHandler(
  async (request: NextRequest) => {
    // 1. The empty-system gate is the whole authorization for this endpoint.
    const companyCount = await db.company.count();
    if (companyCount > 0) {
      return NextResponse.json(
        { error: 'El sistema ya tiene datos. No se puede inicializar desde un respaldo.', code: 'DB_NOT_EMPTY' },
        { status: 409 },
      );
    }

    // 2. Read the payload (multipart upload or base64 JSON) — unchanged limits.
    let backupData: BackupData;
    let recoveryPassword: unknown;
    let ownerPassword: unknown;

    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json({ error: 'No se subió ningún archivo' }, { status: 400 });
      }
      recoveryPassword = formData.get('recoveryPassword');
      const ownership = formData.get('ownerPassword');
      ownerPassword = typeof ownership === 'string' ? ownership : undefined;

      if (file.size > MAX_BACKUP_SIZE) {
        return NextResponse.json({ error: 'El archivo de respaldo supera el tamaño máximo (50MB)' }, { status: 400 });
      }

      const name = file.name.toLowerCase();
      if (!name.endsWith('.json') && !name.endsWith('.backup')) {
        return NextResponse.json({ error: 'Extensión inválida. Solo archivos .json y .backup' }, { status: 400 });
      }

      const fileBuffer = await file.arrayBuffer();
      const firstByte = new Uint8Array(fileBuffer.slice(0, 1))[0];
      if (firstByte !== 0x7b && firstByte !== 0x5b) {
        return NextResponse.json({ error: 'Archivo inválido: no es un JSON válido' }, { status: 400 });
      }

      const jsonString = new TextDecoder().decode(fileBuffer);
      try {
        backupData = JSON.parse(jsonString) as BackupData;
      } catch {
        return NextResponse.json({ error: 'Archivo inválido: no es un JSON válido' }, { status: 400 });
      }
    } else {
      const body = await request.json();
      const base64Data = body.data;
      if (typeof base64Data !== 'string' || base64Data.length === 0) {
        return NextResponse.json({ error: 'Se requiere data en base64' }, { status: 400 });
      }
      recoveryPassword = body.recoveryPassword;
      ownerPassword = typeof body.ownerPassword === 'string' ? body.ownerPassword : undefined;
      try {
        const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8');
        backupData = JSON.parse(jsonString) as BackupData;
      } catch {
        return NextResponse.json({ error: 'Datos inválidos: no es base64/JSON válido' }, { status: 400 });
      }
    }

    // 3. Structural admission. Company-format snapshots (2.x) are validated in
    //    depth by parseSnapshot inside the coordinated restore; anything else
    //    still goes through the legacy structural validator.
    const validation = validateBackupForCoordinatedRestore(backupData);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Respaldo inválido: ${validation.errors.join(', ')}`, code: 'BACKUP_INVALID' },
        { status: 400 },
      );
    }

    const version = backupData?.manifest?.version ?? '';
    if (!isCompanyFormat(version)) {
      return NextResponse.json(
        {
          error:
            `Este respaldo usa un formato anterior (${version || 'desconocido'}) que no se puede ` +
            'restaurar en una instalación nueva. Usá un respaldo generado por esta versión del sistema.',
          code: 'BACKUP_FORMAT_UNSUPPORTED',
        },
        { status: 400 },
      );
    }

    const companyId = backupData.manifest.companyId;
    const firstUser = backupData.data?.users?.[0] as
      | { id?: unknown; email?: unknown; firstName?: unknown; lastName?: unknown }
      | undefined;
    if (typeof companyId !== 'string' || companyId.length === 0) {
      return NextResponse.json(
        { error: 'El respaldo no indica la empresa a restaurar.', code: 'BACKUP_INVALID' },
        { status: 400 },
      );
    }
    if (typeof firstUser?.id !== 'string' || firstUser.id.length === 0 ||
        typeof firstUser?.email !== 'string' || firstUser.email.length === 0) {
      return NextResponse.json(
        { error: 'El respaldo no contiene usuarios', code: 'BACKUP_INVALID' },
        { status: 400 },
      );
    }

    // 4. Required known recovery password — validated BEFORE any mutation. The
    //    received value is never echoed or logged.
    const passwordCheck = recoveryPasswordSchema.safeParse(recoveryPassword);
    if (!passwordCheck.success) {
      return NextResponse.json(
        {
          error: 'La contraseña de recuperación es obligatoria y debe tener al menos 8 caracteres.',
          code: 'RECOVERY_PASSWORD_REQUIRED',
        },
        { status: 400 },
      );
    }

    const userId = firstUser.id;

    // 4b. Ownership proof (S1/S2) — the restorer must know the password of the
    //     super admin who CREATED this backup. Asserted after the required
    //     recovery password (no plaintext stored anywhere) but BEFORE the
    //     bootstrap shell is created, so a refused attempt leaves the system
    //     verifiably empty and never has to be undone.
    assertBackupOwnership(backupData.manifest, ownerPassword);

    const companyInfo = backupData.manifest.companyInfo as
      | { legalName?: unknown; taxId?: unknown }
      | undefined;
    const legalName =
      typeof companyInfo?.legalName === 'string' && companyInfo.legalName
        ? companyInfo.legalName
        : companyId;
    const taxId =
      typeof companyInfo?.taxId === 'string' && companyInfo.taxId ? companyInfo.taxId : null;

    // 5. Minimum destination state the coordinated restore needs: the company,
    //    the installation owner (legacyUser so the session guard accepts it
    //    immediately) and their administrative membership.
    try {
      await db.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            email: firstUser.email as string,
            passwordHash: await hashPassword(passwordCheck.data),
            firstName: typeof firstUser.firstName === 'string' ? firstUser.firstName : '',
            lastName: typeof firstUser.lastName === 'string' ? firstUser.lastName : '',
            platformRole: 'super_admin',
            emailVerifiedAt: new Date(),
            legacyUser: true,
          },
        });
        await tx.company.create({
          data: {
            id: companyId,
            legalName,
            entityType: entityTypeOf(backupData),
            taxId,
          },
        });
        await tx.companyMember.create({
          data: { userId, companyId, role: 'company_admin' },
        });
      });
    } catch (error) {
      logger.error('bootstrap.restore: could not create bootstrap state', {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      await discardBootstrapShell(companyId, userId);
      return NextResponse.json(
        {
          error: 'No se pudo preparar la restauración. Revisá el respaldo e intentá nuevamente.',
          code: 'RESTORE_FAILED',
        },
        { status: 400 },
      );
    }

    // 6. Coordinated restore: it deletes the shell rows and installs the payload.
    //    A thrown error means it refused the payload BEFORE mutating (any path
    //    that had already started the recovery journal returns a result object
    //    instead), so the shell can be discarded and the system stays empty.
    let result: Awaited<ReturnType<typeof restoreCompanyBackupCoordinated>>;
    try {
      result = await restoreCompanyBackupCoordinated(companyId, JSON.stringify(backupData), {
        ownerPassword: typeof ownerPassword === 'string' ? ownerPassword : undefined,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('bootstrap.restore: coordinated restore refused the payload', { companyId, error: detail });
      await discardBootstrapShell(companyId, userId);
      // T7 (S3): report the refusal the core actually made (legacy plain-text
      // file, ownership credential, uncertifiable history, non-empty shell)
      // instead of flattening it into a generic failure. Same 400, same
      // Spanish message, no change to what is admitted.
      const refusal = knownRestoreRefusal(error);
      if (refusal) {
        return NextResponse.json(
          {
            error: refusal.message,
            code: refusal.code,
            ...(refusal.details === undefined ? {} : { details: refusal.details }),
          },
          { status: refusal.status },
        );
      }
      return NextResponse.json(
        { error: `No se pudo restaurar el sistema: ${detail}`, code: 'RESTORE_FAILED' },
        { status: 400 },
      );
    }

    if (result.status !== 'committed') {
      // The database outcome is uncertain: never delete evidence, never retry.
      logger.error('bootstrap.restore: restore needs operator reconciliation', {
        companyId,
        status: result.status,
        operationId: result.operationId,
        error: result.error,
      });
      return NextResponse.json(
        {
          error:
            'La restauración quedó pendiente de reconciliación y el sistema está en mantenimiento. ' +
            'No reintentes: contactá al soporte técnico con este identificador de operación ' +
            `${result.operationId}.`,
          code: 'RESTORE_RECONCILIATION_REQUIRED',
          operationId: result.operationId,
        },
        { status: 500 },
      );
    }

    // 7. Session for the restored owner, same contract as the login route.
    const token = await createSession(userId);

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, lastName: true, platformRole: true },
    });

    let companies;
    if (user?.platformRole === 'super_admin') {
      // Global authority contract (mirror /api/auth/me super_admin branch):
      // all active companies with role=null. Never invent memberships.
      companies = (
        await db.company.findMany({
          where: { isActive: true },
          select: {
            id: true,
            legalName: true,
            entityType: true,
            taxId: true,
            isOnboardingComplete: true,
          },
          orderBy: { legalName: 'asc' },
        })
      ).map((company) => ({ ...company, role: null }));
    } else {
      // Tenant contract (mirror /api/auth/me member branch):
      // Company.role = CompanyMember.role, already fetched above — no extra query.
      const memberships = await db.companyMember.findMany({
        where: { userId },
        include: {
          company: {
            select: { id: true, legalName: true, entityType: true, taxId: true, isOnboardingComplete: true },
          },
        },
      });
      companies = memberships.map((m) => ({ ...m.company, role: m.role }));
    }

    const response = NextResponse.json({
      success: true,
      message: 'Sistema restaurado exitosamente',
      scope: result.scope,
      operationId: result.operationId,
      restoredCounts: result.counts,
      user: user
        ? {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.platformRole,
          }
        : user,
      companies,
    });

    const isProd = process.env.NODE_ENV === 'production';
    response.cookies.set(isProd ? '__Host-session' : 'session', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return response;
  },
  { allowAnonymous: true, requireMembership: false },
);
