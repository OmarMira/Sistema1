/**
 * Commercial entitlement guard — the single reusable gate for module access.
 *
 * Resolves ONLY commercial entitlement, and ONLY by delegating to the 11B
 * engine (resolveCompanyModuleEntitlement). The engine is the sole authority:
 * this guard never reads the database, never resolves dependencies, and never
 * computes entitlement locally.
 *
 * Deliberately NOT here (separate dimensions):
 * - authentication / session validation
 * - company membership validation
 * - RBAC / role checks (requireCompanyRole, requireActiveTenantAccess)
 */
import { ModuleEntitlementError } from '@/lib/api-error';
import { requireCompanyContext } from '@/lib/context-storage';
import type { ModuleKey } from '@/lib/constants/module-catalog';
import {
  resolveCompanyModuleEntitlement,
  type ModuleEntitlementResult,
} from '@/lib/services/module-entitlement-engine';

type ModuleEntitlementErrorCode =
  | 'MODULE_NOT_ENTITLED'
  | 'MODULE_UNAVAILABLE'
  | 'MODULE_DEPENDENCY_MISSING';

function reasonToCode(reason: string): ModuleEntitlementErrorCode {
  switch (reason) {
    case 'IMPLEMENTATION_UNAVAILABLE':
      return 'MODULE_UNAVAILABLE';
    case 'MISSING_DEPENDENCY':
      return 'MODULE_DEPENDENCY_MISSING';
    case 'NOT_CONFIGURED':
    case 'COMMERCIALLY_DISABLED':
      return 'MODULE_NOT_ENTITLED';
    default:
      // Fail closed: EFFECTIVE_ENABLED inconsistent with effectiveEnabled=false,
      // or any unexpected reason, denies with MODULE_NOT_ENTITLED.
      return 'MODULE_NOT_ENTITLED';
  }
}

/**
 * Explicit-companyId assertion for SSR pages and special routes.
 *
 * Resolves the module entitlement for the given company and returns the full
 * engine result when the module is effective. Throws ModuleEntitlementError
 * (HTTP 403) otherwise, mapping the 11B reason to a commercial error code.
 */
export async function assertCompanyModuleEntitlement(
  companyId: string,
  moduleKey: ModuleKey,
): Promise<ModuleEntitlementResult> {
  const result = await resolveCompanyModuleEntitlement(companyId, moduleKey);

  if (result.effectiveEnabled === true) {
    return result;
  }

  const code = reasonToCode(result.reason);
  throw new ModuleEntitlementError(
    `Module "${moduleKey}" is not available for this company (reason: ${result.reason}).`,
    code,
    {
      moduleKey,
      reason: result.reason,
      missingDependencies: result.missingDependencies,
    },
  );
}

/**
 * Contextual wrapper for API routes: derives companyId from the request
 * context via requireCompanyContext() — never from client-supplied input.
 */
export async function requireModuleEntitlement(
  moduleKey: ModuleKey,
): Promise<ModuleEntitlementResult> {
  const ctx = requireCompanyContext();
  return assertCompanyModuleEntitlement(ctx.companyId, moduleKey);
}
