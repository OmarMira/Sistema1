import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { AppError, AuthError, ValidationError } from '@/lib/api-error';
import { LoginInput, RegisterInput } from '@/lib/validations/auth';
import { withTiming } from '@/lib/timing';
import { seedChartOfAccounts } from '@/lib/chart-of-accounts';
import { initializeDefaultCompanyModuleEntitlements } from '@/lib/services/module-entitlement-initialization';

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
    let id: string;
    if (existing) {
      // Only confirmation and the first-account role may change: keep password/business data.
      const user = await tx.user.update({ where: { id: existing.id }, data: {
        emailVerifiedAt: now,
        platformRole: established === 0 ? 'super_admin' : existing.platformRole,
      } });
      id = user.id;
    } else {
      if (!input) throw new ValidationError('Completa los datos del registro para confirmar tu cuenta.');
      const passwordHash = await hashPassword(input.password);
      const result = await AuthService.createAccount(tx, input, passwordHash, now, established === 0 ? 'super_admin' : 'user');
      id = result.user.id;
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
