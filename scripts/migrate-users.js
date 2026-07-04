import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const sqlite = new Database('C:\\Users\\PC Omar\\Downloads\\sistema-bk\\prisma\\dev.db');

const users = sqlite.prepare('SELECT id, email, "passwordHash", "firstName", "lastName", role, "isActive" FROM "User"').all();
console.log(`Found ${users.length} users in SQLite`);

const companies = sqlite.prepare('SELECT id, "legalName", "taxId", "entityType", "isActive", "isOnboardingComplete" FROM "Company"').all();
console.log(`Found ${companies.length} companies in SQLite`);

const members = sqlite.prepare('SELECT "userId", "companyId", role FROM "CompanyMember"').all();
console.log(`Found ${members.length} memberships in SQLite`);

sqlite.close();

const prisma = new PrismaClient();

for (const u of users) {
  const existing = await prisma.user.findUnique({ where: { email: u.email.toLowerCase() } });
  if (existing) {
    console.log(`User ${u.email} already exists, skipping`);
    continue;
  }
  await prisma.user.create({
    data: {
      id: u.id,
      email: u.email.toLowerCase(),
      passwordHash: u.passwordHash,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role || 'company_admin',
      isActive: u.isActive,
    },
  });
  console.log(`Created user: ${u.email}`);
}

for (const c of companies) {
  const existing = await prisma.company.findUnique({ where: { id: c.id } });
  if (existing) {
    console.log(`Company ${c.legalName} already exists, skipping`);
    continue;
  }
  await prisma.company.create({
    data: {
      id: c.id,
      legalName: c.legalName,
      taxId: c.taxId,
      entityType: c.entityType || 'BUSINESS',
      isActive: c.isActive ?? true,
      isOnboardingComplete: c.isOnboardingComplete ?? false,
    },
  });
  console.log(`Created company: ${c.legalName}`);
}

for (const m of members) {
  const existing = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: m.userId, companyId: m.companyId } },
  });
  if (existing) {
    console.log(`Membership ${m.userId} -> ${m.companyId} already exists, skipping`);
    continue;
  }
  await prisma.companyMember.create({
    data: {
      userId: m.userId,
      companyId: m.companyId,
      role: m.role || 'company_admin',
    },
  });
  console.log(`Created membership: ${m.userId} -> ${m.companyId}`);
}

await prisma.$disconnect();
console.log('Migration complete');
