import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';

const sqlite = new Database('C:\\Users\\PC Omar\\Downloads\\sistema\\db\\custom.db');
const users = sqlite.prepare('SELECT id, email, passwordHash, firstName, lastName, role, isActive FROM User').all();
const companies = sqlite.prepare('SELECT id, legalName, taxId, isActive FROM Company').all();
const members = sqlite.prepare('SELECT userId, companyId, role FROM CompanyMember').all();
sqlite.close();

console.log(`Backup: ${users.length} users, ${companies.length} companies, ${members.length} memberships`);

const prisma = new PrismaClient();

for (const u of users) {
  const existing = await prisma.user.findUnique({ where: { email: u.email.toLowerCase() } });
  if (existing) { console.log(`Skip user ${u.email} (exists)`); continue; }
  await prisma.user.create({
    data: {
      id: u.id, email: u.email.toLowerCase(), passwordHash: u.passwordHash,
      firstName: u.firstName, lastName: u.lastName, role: u.role || 'company_admin', isActive: u.isActive === true || u.isActive === 1 ? true : false,
    },
  });
  console.log(`User restored: ${u.email}`);
}

for (const c of companies) {
  const existing = await prisma.company.findUnique({ where: { id: c.id } });
  if (existing) { console.log(`Skip company ${c.legalName} (exists)`); continue; }
  await prisma.company.create({
    data: {
      id: c.id, legalName: c.legalName, taxId: c.taxId,
      entityType: 'BUSINESS', isActive: c.isActive === true || c.isActive === 1 ? true : false, isOnboardingComplete: false,
    },
  });
  console.log(`Company restored: ${c.legalName}`);
}

for (const m of members) {
  const existing = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId: m.userId, companyId: m.companyId } } });
  if (existing) { console.log(`Skip membership ${m.userId}->${m.companyId} (exists)`); continue; }
  await prisma.companyMember.create({ data: { userId: m.userId, companyId: m.companyId, role: m.role || 'company_admin' } });
  console.log(`Membership restored: ${m.userId} -> ${m.companyId}`);
}

await prisma.$disconnect();
console.log('Restore complete.');
