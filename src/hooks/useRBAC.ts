import config from '../../rules/rbac-config.json';

export type UserAuthContext = {
  userId: string;
  companyId: string;
  role: string;
};

export function useRBAC(
  authCtx: UserAuthContext | null,
  resource: string,
  action: string,
): boolean {
  if (!authCtx) return false;

  const permissions = config.permissions as Record<string, Record<string, string[]>> | undefined;
  const allowedRoles = permissions?.[resource]?.[action] || [];
  return allowedRoles.includes(authCtx.role);
}
