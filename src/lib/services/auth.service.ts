import type { Prisma } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { AppError, AuthError, ValidationError } from '@/lib/api-error';
import { LoginInput, RegisterInput } from '@/lib/validations/auth';
import { withTiming } from '@/lib/timing';
import { seedChartOfAccounts } from '@/lib/chart-of-accounts';
import { initializeDefaultCompanyModuleEntitlements } from '@/lib/services/module-entitlement-initialization';
import { createAuditLogWithRetry } from '@/lib/audit';

// ─────────────────────────────────────────────────────────────────────────────
// S10 — first-admin bootstrap hardening
//
// The first confirmed registration is still promoted to platform super_admin,
// but when the operator sets BOOTSTRAP_SETUP_TOKEN the promotion additionally
// requires that token. Registration (the challenge request) is the only place
// the operator token is presented, while the promotion happens later at
// verification, so the accepted token is recorded as one short-lived, single-use
// grant bound to the registering email and consumed inside the confirmation
// transaction. Without BOOTSTRAP_SETUP_TOKEN nothing changes for single-user
// local installs and the promotion is recorded as a security audit event.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a token-accepted registration may take to be confirmed. */
export const FIRST_ADMIN_BOOTSTRAP_GRANT_TTL_MS = 30 * 60 * 1000;

/** SystemConfig key of the bootstrap grant (no secret material is stored). */
export function firstAdminBootstrapGrantKey(email: string): string {
  return `auth:first-admin-bootstrap:${email.toLowerCase().trim()}`;
}

/**
 * Compares the presented setup token with the configured one exactly like
 * /api/bootstrap/restore: SHA-256 digests + timingSafeEqual.
 */
export function setupTokenMatches(received: string): boolean {
  const expected = process.env.BOOTSTRAP_SETUP_TOKEN;
  if (!expected || !received) return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const receivedHash = createHash('sha256').update(received).digest();
  return expectedHash.length === receivedHash.length && timingSafeEqual(expectedHash, receivedHash);
}

/** Records that an operator who knew the setup token authorized this email's promotion. */
export async function grantFirstAdminBootstrap(email: string, now: Date = new Date()): Promise<void> {
  const key = firstAdminBootstrapGrantKey(email);
  const value = JSON.stringify({
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FIRST_ADMIN_BOOTSTRAP_GRANT_TTL_MS).toISOString(),
  });
  await db.systemConfig.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/**
 * Consumes the grant inside the confirmation transaction. The caller already
 * holds the first-registration advisory lock, so the grant can never be used
 * twice. Returns true only for a present, unexpired grant.
 */
async function consumeFirstAdminBootstrapGrant(
  tx: Prisma.TransactionClient, email: string, now: Date,
): Promise<boolean> {
  const key = firstAdminBootstrapGrantKey(email);
  const row = await tx.systemConfig.findUnique({ where: { key } });
  if (!row) return false;
  await tx.systemConfig.delete({ where: { key } });
  try {
    const grant = JSON.parse(row.value) as { expiresAt?: string };
    return typeof grant.expiresAt === 'string' && new Date(grant.expiresAt).getTime() > now.getTime();
  } catch {
    return false;
  }
}

/**
 * S4 — precomputed bcrypt digest (cost 12) used ONLY to flatten login timing.
 *
 * Without it, an unknown or deactivated email returned before bcrypt, so a
 * response for "account does not exist" was measurably faster than
 * "wrong password" and login became an account-enumeration oracle. The digest
 * is a real hash of a value nobody can supply, so the comparison always fails
 * and its result is discarded; the error above stays byte-identical.
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$Q6ZTt6dHZdfFXXlo4Esaee6C3XcAESD3dqKpUnik.7SifTASvZfZK';

export class AuthService {
  static login = withTiming(async (input: LoginInput, options?: { resumeVerification: boolean }) => {
    const { email, password } = input;
    const user = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        platformRole: true,
        isActive: true,
        passwordHash: true,
        emailVerifiedAt: true,
        legacyUser: true,
        companyMemberships: {
          where: { company: { isActive: true } },
          include: {
            company: {
              select: {
                id: true,
                legalName: true,
                taxId: true,
                isActive: true,
                isOnboardingComplete: true,
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      // S4: pay the bcrypt cost even when there is no account to compare against.
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new AuthError('Correo electrónico o contraseña inválidos');
    }
    const pending = user.emailVerifiedAt === null && !(user.legacyUser ?? false);
    // Keep the original internal contract unless the login endpoint requests resume.
    if (pending && !options?.resumeVerification) {
      throw new AuthError('Correo electrónico o contraseña inválidos');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new AuthError('Correo electrónico o contraseña inválidos');
    }

    if (pending) {
      // Never reveal account status until its password has actually been verified.
      throw new AppError(403, 'Confirma tu correo electrónico para continuar.',
        'EMAIL_VERIFICATION_REQUIRED', { email: user.email });
    }

    const companies = user.companyMemberships.map((m) => m.company);
    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.platformRole,
      },
      companies,
    };
  }, 'AuthService.login');

  private static async createAccount(
    tx: Prisma.TransactionClient, input: RegisterInput, passwordHash: string,
    verifiedAt?: Date, role: 'user' | 'super_admin' = 'user',
  ) {
    const user = await tx.user.create({ data: {
      email: input.email.toLowerCase().trim(), passwordHash,
      firstName: input.firstName.trim(), lastName: input.lastName.trim(),
      platformRole: role, ...(verifiedAt ? { emailVerifiedAt: verifiedAt } : {}),
    } });
    const company = await tx.company.create({ data: {
      legalName: input.companyName.trim(), entityType: input.entityType ?? 'BUSINESS',
      taxId: input.taxId?.trim() || null,
    } });
    await tx.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'company_admin' } });
    await seedChartOfAccounts(tx as any, company.id);
    await initializeDefaultCompanyModuleEntitlements(tx, company.id);
    return { user, company };
  }

  // The caller supplies the challenge transaction; never open another transaction here.
  static async finalizeRegistration(tx: Prisma.TransactionClient, email: string, now: Date, input?: RegisterInput) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('auth:first-confirmed-registration',0))`;
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing && (!existing.isActive || existing.emailVerifiedAt || existing.legacyUser)) {
      throw new AuthError('No se puede confirmar esta solicitud de registro.');
    }
    const established = await tx.user.count({ where: { OR: [
      { emailVerifiedAt: { not: null } }, { legacyUser: true }, { platformRole: 'super_admin' },
    ] } });
    // S10: the promotion is still advisory-lock serialized; with an operator
    // token configured it additionally requires the matching single-use grant.
    const bootstrapTokenRequired = Boolean(process.env.BOOTSTRAP_SETUP_TOKEN);
    let bootstrapGrantConsumed = false;
    let firstAdmin = established === 0;
    if (firstAdmin && bootstrapTokenRequired) {
      bootstrapGrantConsumed = await consumeFirstAdminBootstrapGrant(tx, email, now);
      firstAdmin = bootstrapGrantConsumed;
    }
    let id: string;
    if (existing) {
      // Only confirmation and the first-account role may change: keep password/business data.
      const user = await tx.user.update({ where: { id: existing.id }, data: {
        emailVerifiedAt: now,
        platformRole: firstAdmin ? 'super_admin' : existing.platformRole,
      } });
      id = user.id;
    } else {
      if (!input) throw new ValidationError('Completa los datos del registro para confirmar tu cuenta.');
      const passwordHash = await hashPassword(input.password);
      const result = await AuthService.createAccount(tx, input, passwordHash, now, firstAdmin ? 'super_admin' : 'user');
      id = result.user.id;
    }
    if (firstAdmin) {
      // SecurityEvent: the platform-wide role is granted here and nowhere else.
      await createAuditLogWithRetry({
        companyId: null,
        userId: id,
        action: 'SECURITY_FIRST_ADMIN_PROMOTED',
        entity: 'User',
        entityId: id,
        details: JSON.stringify({
          contractVersion: 1,
          reason: 'first-confirmed-registration',
          bootstrapTokenRequired,
          bootstrapGrantConsumed,
        }),
      }, tx);
    }
    return tx.user.findUniqueOrThrow({ where: { id }, include: {
      companyMemberships: { where: { company: { isActive: true } }, include: { company: { select: {
        id: true, legalName: true, entityType: true, taxId: true, isOnboardingComplete: true,
      } } } },
    } });
  }

  static register = withTiming(async (input: RegisterInput) => {
    const email = input.email.toLowerCase().trim();
    const passwordHash = await hashPassword(input.password);
    return db.$transaction(async tx => {
      if (await tx.user.findUnique({ where: { email } })) {
        throw new ValidationError('Ya existe una cuenta con este correo electrónico');
      }
      // Prisma's result extensions change delegate types, not these auth model operations.
      return AuthService.createAccount(tx as unknown as Prisma.TransactionClient, input, passwordHash);
    });
  }, 'AuthService.register');
}
