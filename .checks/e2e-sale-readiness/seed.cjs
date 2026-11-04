/* T16 / S16 — E2E fixture seed (verification only; never run against the ambient DB).
 *
 * Usage (from the repo root):
 *   DATABASE_URL='postgresql://postgres@127.0.0.1:54497/accountexpress_test?schema=public' \
 *   node .checks/e2e-sale-readiness/seed.cjs
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const PASSWORD = 'E2ePassword!123';
const COMPANY_ID = 'e2e-company-1';

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!/54497\/accountexpress_test/.test(url)) {
    throw new Error(`Refusing to seed: DATABASE_URL is not the disposable fixture (${url.replace(/:[^:@]*@/, ':***@')})`);
  }

  const db = new PrismaClient({ datasources: { db: { url } } });

  const company = await db.company.upsert({
    where: { id: COMPANY_ID },
    update: { isActive: true, isOnboardingComplete: true },
    create: {
      id: COMPANY_ID,
      legalName: 'E2E Sale Readiness SA',
      entityType: 'BUSINESS',
      taxId: 'E2E-30-12345678-1',
      isActive: true,
      isOnboardingComplete: true,
    },
  });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const admin = await db.user.upsert({
    where: { email: 'e2e-admin@example.test' },
    update: { passwordHash, emailVerifiedAt: new Date(), legacyUser: false, isActive: true, platformRole: 'super_admin' },
    create: {
      id: 'e2e-admin-user',
      email: 'e2e-admin@example.test',
      passwordHash,
      firstName: 'E2E',
      lastName: 'Admin',
      platformRole: 'super_admin',
      emailVerifiedAt: new Date(),
      legacyUser: false,
      isActive: true,
    },
  });

  const viewer = await db.user.upsert({
    where: { email: 'e2e-viewer@example.test' },
    update: { passwordHash, emailVerifiedAt: new Date(), legacyUser: false, isActive: true, platformRole: 'user' },
    create: {
      id: 'e2e-viewer-user',
      email: 'e2e-viewer@example.test',
      passwordHash,
      firstName: 'E2E',
      lastName: 'Viewer',
      platformRole: 'user',
      emailVerifiedAt: new Date(),
      legacyUser: false,
      isActive: true,
    },
  });

  await db.companyMember.upsert({
    where: { userId_companyId: { userId: admin.id, companyId: company.id } },
    update: { role: 'company_admin' },
    create: { userId: admin.id, companyId: company.id, role: 'company_admin' },
  });

  await db.companyMember.upsert({
    where: { userId_companyId: { userId: viewer.id, companyId: company.id } },
    update: { role: 'viewer' },
    create: { userId: viewer.id, companyId: company.id, role: 'viewer' },
  });

  await db.glAccount.upsert({
    where: { companyId_code: { companyId: company.id, code: '1100' } },
    update: { isActive: true },
    create: {
      companyId: company.id,
      code: '1100',
      name: 'Caja E2E',
      accountType: 'ASSET',
      normalBalance: 'DEBIT',
      isActive: true,
    },
  });

  const counts = {
    users: await db.user.count(),
    companies: await db.company.count(),
    members: await db.companyMember.count({ where: { companyId: company.id } }),
    glAccounts: await db.glAccount.count({ where: { companyId: company.id } }),
  };

  await db.$disconnect();
  console.log(JSON.stringify({
    ok: true,
    companyId: company.id,
    adminId: admin.id,
    adminEmail: admin.email,
    viewerId: viewer.id,
    viewerEmail: viewer.email,
    password: PASSWORD,
    counts,
  }, null, 2));
}

main().catch((error) => {
  console.error('SEED FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
