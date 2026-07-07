import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function hasCompanyAccess(userId: string, companyId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, isActive: true },
  });

  if (!user?.isActive) return false;

  if (user.role === 'super_admin') {
    return true;
  }

  const [membership, company] = await Promise.all([
    db.companyMember.findUnique({
      where: {
        userId_companyId: { userId, companyId },
      },
    }),
    db.company.findUnique({
      where: { id: companyId },
      select: { isActive: true },
    }),
  ]);

  return !!membership && !!company?.isActive;
}
