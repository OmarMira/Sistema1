import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  const r = await db.systemConfig.deleteMany();
  console.log('Deleted:', r.count);
} catch (e) {
  console.error(e);
} finally {
  await db.$disconnect();
}
