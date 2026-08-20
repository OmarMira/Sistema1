import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { requestContext } from '@/lib/context-storage';
import { requireCompanyRole, COMPANY_ROLES } from '@/lib/rbac';
import { createTestUser, createTestCompany, clearDatabase } from '../helpers/factories';

const ALLOWED: readonly (typeof COMPANY_ROLES)[number][] = ['company_admin'];

async function runAs(userId: string, companyId: string, fn: () => Promise<void>) {
  return requestContext.run({ userId, companyId }, fn);
}

function expectForbidden(p: Promise<void>) {
  return expect(p).rejects.toMatchObject({ statusCode: 403 });
}

describe('requireCompanyRole — primitiva RBAC server-side', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('permite super_admin sin membresía (bypass global)', async () => {
    const admin = await createTestUser('rbac-super@example.com');
    await db.user.update({ where: { id: admin.id }, data: { platformRole: 'super_admin' } });
    const company = await createTestCompany('RBAC Co');

    await runAs(admin.id, company.id, () => requireCompanyRole(company.id, ALLOWED));
  });

  it('permite company_admin miembro', async () => {
    const user = await createTestUser('rbac-admin@example.com');
    const company = await createTestCompany('RBAC Co');
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, role: 'company_admin' },
    });

    await runAs(user.id, company.id, () => requireCompanyRole(company.id, ALLOWED));
  });

  it('bloquea employee con 403', async () => {
    const user = await createTestUser('rbac-employee@example.com');
    const company = await createTestCompany('RBAC Co');
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, role: 'employee' },
    });

    await expectForbidden(
      runAs(user.id, company.id, () => requireCompanyRole(company.id, ALLOWED)),
    );
  });

  it('bloquea viewer con 403', async () => {
    const user = await createTestUser('rbac-viewer@example.com');
    const company = await createTestCompany('RBAC Co');
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, role: 'viewer' },
    });

    await expectForbidden(
      runAs(user.id, company.id, () => requireCompanyRole(company.id, ALLOWED)),
    );
  });

  it('bloquea sin membresía con 403', async () => {
    const user = await createTestUser('rbac-nomember@example.com');
    const company = await createTestCompany('RBAC Co');

    await expectForbidden(
      runAs(user.id, company.id, () => requireCompanyRole(company.id, ALLOWED)),
    );
  });

  it('bloquea roles desconocidos con 403 (fail-closed)', async () => {
    const user = await createTestUser('rbac-unknown@example.com');
    const company = await createTestCompany('RBAC Co');
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, role: 'accountant' },
    });

    await expectForbidden(
      runAs(user.id, company.id, () => requireCompanyRole(company.id, ALLOWED)),
    );
  });

  it('rechaza con 401 cuando no hay usuario autenticado en el contexto', async () => {
    await expect(requireCompanyRole('company-x', ALLOWED)).rejects.toMatchObject({ statusCode: 401 });
  });
});
