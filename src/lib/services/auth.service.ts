import { db } from '@/lib/db';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { AuthError, ValidationError } from '@/lib/api-error';
import { LoginInput, RegisterInput } from '@/lib/validations/auth';
import { withTiming } from '@/lib/timing';
import { seedChartOfAccounts } from '@/lib/chart-of-accounts';

export class AuthService {
  static login = withTiming(async (input: LoginInput) => {
    const { email, password } = input;
    const user = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        passwordHash: true,
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

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new AuthError('Correo electrónico o contraseña inválidos');
    }

    const companies = user.companyMemberships.map((m) => m.company);
    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
      companies,
    };
  }, 'AuthService.login');

  static register = withTiming(async (input: RegisterInput) => {
    const { email, password, firstName, lastName, companyName, taxId, entityType } = input;
    const normalizedEmail = email.toLowerCase().trim();

    // Hash password (done before TX — pure function, no side effects on DB)
    const passwordHash = await hashPassword(password);

    // Create user and company in a transaction
    const result = await db.$transaction(async (tx) => {
      // Check if user already exists (inside TX — prevents race conditions)
      const existingUser = await tx.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUser) {
        throw new ValidationError('Ya existe una cuenta con este correo electrónico');
      }

      // Create user
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          role: 'company_admin',
        },
      });

      // Create company
      const company = await tx.company.create({
        data: {
          legalName: companyName.trim(),
          entityType: entityType ?? 'BUSINESS',
          taxId: taxId?.trim() || null,
        },
      });

      // Create company membership
      await tx.companyMember.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: 'company_admin',
        },
      });

      // Seed chart of accounts
       
      await seedChartOfAccounts(tx as any, company.id);

      return { user, company };
    });

    return result;
  }, 'AuthService.register');
}
