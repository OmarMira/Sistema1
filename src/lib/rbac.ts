import { ForbiddenError } from './api-error';
import { db } from './db';
import { requireCurrentUserId } from './context-storage';

export type CompanyRole = 'company_admin' | 'employee' | 'viewer';

export const COMPANY_ROLES: readonly CompanyRole[] = ['company_admin', 'employee', 'viewer'];

export async function requireCompanyRole(
  companyId: string,
  allowedRoles: readonly CompanyRole[],
): Promise<void> {
  const userId = requireCurrentUserId();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (user?.role === 'super_admin') {
    return;
  }

  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { role: true },
  });

  if (!membership) {
    throw new ForbiddenError('Forbidden');
  }

  const memberRole = membership.role as CompanyRole;

  if (!COMPANY_ROLES.includes(memberRole)) {
    throw new ForbiddenError('Forbidden');
  }

  if (!allowedRoles.includes(memberRole)) {
    throw new ForbiddenError('Forbidden');
  }
}
