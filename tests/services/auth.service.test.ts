import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from '@/lib/services/auth.service';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';

describe('AuthService', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe registrar un usuario y crear su empresa y cuentas contables correctas', async () => {
    const result = await AuthService.register({
      email: 'newuser@example.com',
      password: 'password123',
      firstName: 'John',
      lastName: 'Doe',
      companyName: 'Johns Accounting LLC',
      taxId: '99-888888',
      entityType: 'BUSINESS',
    });

    expect(result.user).toBeDefined();
    expect(result.user.email).toBe('newuser@example.com');
    expect(result.company.legalName).toBe('Johns Accounting LLC');

    // Verificar que se crearon cuentas contables US GAAP
    const accountsCount = await db.glAccount.count({
      where: { companyId: result.company.id },
    });
    expect(accountsCount).toBeGreaterThan(10);
  });

  it('registers a company with exactly 5 default module entitlements', async () => {
    const result = await AuthService.register({
      email: 'default-entitlements@example.com',
      password: 'password123',
      firstName: 'Jane',
      lastName: 'Doe',
      companyName: 'Default Entitlements LLC',
      taxId: '77-123456',
      entityType: 'BUSINESS',
    });

    const rows = await db.companyModuleEntitlement.findMany({
      where: { companyId: result.company.id },
    });
    expect(rows).toHaveLength(5);

    const byKey = new Map(rows.map((row) => [row.moduleKey, row]));
    expect(byKey.get('accounting')?.enabled).toBe(true);
    expect(byKey.get('banking')?.enabled).toBe(true);
    expect(byKey.get('purchases')?.enabled).toBe(false);
    expect(byKey.get('sales')?.enabled).toBe(false);
    expect(byKey.get('inventory')?.enabled).toBe(false);

    expect(byKey.get('accounting')?.activatedAt).not.toBeNull();
    expect(byKey.get('accounting')?.deactivatedAt).toBeNull();
    expect(byKey.get('purchases')?.activatedAt).toBeNull();
    expect(byKey.get('purchases')?.deactivatedAt).toBeNull();
  });

  it('debe iniciar sesión con credenciales correctas', async () => {
    const passwordHash = await bcrypt.hash('password123', 10);
    const user = await db.user.create({
      data: {
        email: 'login@example.com',
        passwordHash,
        firstName: 'John',
        lastName: 'Doe',
      },
    });

    const company = await createTestCompany();
    await createTestCompanyMember(user.id, company.id);

    const result = await AuthService.login({
      email: 'login@example.com',
      password: 'password123',
    });

    expect(result.user.id).toBe(user.id);
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0].id).toBe(company.id);
  });

  it('debe fallar al iniciar sesión con contraseña incorrecta', async () => {
    const passwordHash = await bcrypt.hash('password123', 10);
    await db.user.create({
      data: {
        email: 'wrongpass@example.com',
        passwordHash,
        firstName: 'John',
        lastName: 'Doe',
      },
    });

    await expect(
      AuthService.login({
        email: 'wrongpass@example.com',
        password: 'incorrect_password',
      })
    ).rejects.toThrow('Correo electrónico o contraseña inválidos');
  });
});
