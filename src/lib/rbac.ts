import { ForbiddenError } from './api-error';
import { db } from './db';
import { requireCurrentUserId } from './context-storage';

export type CompanyRole = 'company_admin' | 'employee' | 'viewer';

export const COMPANY_ROLES: readonly CompanyRole[] = ['company_admin', 'employee', 'viewer'];

/**
 * Internal authenticated context built by apiHandler from the validated
 * session and the already-fetched user role. NOT a public parameter: it is
 * derived from server-side state, never from request input.
 */
export interface AuthenticatedUserContext {
  userId: string;
  role: string;
}

/**
 * F-6: tenant-level access gate. Single source of truth for:
 *   - super_admin bypass (platform operator keeps access to deactivated tenants);
 *   - Company.isActive (deactivated tenant blocks normal members, 403);
 *   - CompanyMember existence (removed membership, 403).
 * User.isActive is validated at session resolution (getSessionUserId), not here.
 */
export async function requireActiveTenantAccess(
  companyId: string,
  auth: AuthenticatedUserContext,
): Promise<void> {
  if (auth.role === 'super_admin') {
    return;
  }

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { isActive: true },
  });
  if (!company?.isActive) {
    throw new ForbiddenError('Company is deactivated');
  }

  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId: auth.userId, companyId } },
    select: { id: true },
  });
  if (!membership) {
    throw new ForbiddenError('Forbidden');
  }
}

export async function requireCompanyRole(
  companyId: string,
  allowedRoles: readonly CompanyRole[],
): Promise<void> {
  const userId = requireCurrentUserId();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });

  if (user?.platformRole === 'super_admin') {
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

/**
 * Gate de rol global para recursos administrativos/configuración.
 * Reutilizado en config/ai y config/ai/verify para imponer la misma política de rol.
 * Contrato RC2: User.role solo representa autoridad global => unico acceso es super_admin.
 */
export async function requireGlobalAdminRole(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });
  if (!user || user.platformRole !== 'super_admin') {
    throw new ForbiddenError('Access denied');
  }
}
