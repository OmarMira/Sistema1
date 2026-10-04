import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { ValidationError } from '@/lib/api-error';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { isModuleKey } from '@/lib/constants/module-catalog';
import {
  enableCompanyModule,
  disableCompanyModule,
} from '@/lib/services/module-entitlements.service';
import { resolveCompanyModuleEntitlement } from '@/lib/services/module-entitlement-engine';
import { createAuditLogWithRetry } from '@/lib/audit';

/**
 * PATCH /api/company/entitlements/[moduleKey] — commercial module write contract.
 *
 * Company admins enable/disable a module for their own tenant. The route is a
 * thin orchestrator: availability policy (UNAVAILABLE rejection), persistence
 * and dependency resolution stay in the 11A service and the 11B engine. No
 * dependency auto-enable and no parallel PARTIAL rejection: mutations may
 * persist even when a dependency is missing, and the engine remains the sole
 * authority on effectiveEnabled.
 */
export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  // Tenant comes exclusively from the validated company context set by
  // apiHandler (requireActiveTenantAccess); never from body/path/headers here.
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);

  const { moduleKey } = await context.params;
  if (!isModuleKey(moduleKey)) {
    throw new ValidationError(`Unknown module key: ${moduleKey}`, { moduleKey });
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const { enabled } = parsedBody as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    throw new ValidationError('Field "enabled" must be a boolean');
  }

  if (enabled) {
    // Service rejects UNAVAILABLE modules (400); PARTIAL/AVAILABLE allowed.
    await enableCompanyModule(companyId, moduleKey);
  } else {
    await disableCompanyModule(companyId, moduleKey);
  }

  // Final state comes from the 11B engine (never the persisted row alone):
  // reports MISSING_DEPENDENCY + missingDependencies when deps are unsatisfied.
  const entitlement = await resolveCompanyModuleEntitlement(companyId, moduleKey);

  await createAuditLogWithRetry({
    companyId,
    userId,
    action: enabled ? 'MODULE_ENTITLEMENT_ENABLED' : 'MODULE_ENTITLEMENT_DISABLED',
    entity: 'CompanyModuleEntitlement',
    entityId: moduleKey,
    details: JSON.stringify({
      moduleKey,
      enabled,
      effectiveEnabled: entitlement.effectiveEnabled,
      reason: entitlement.reason,
      missingDependencies: entitlement.missingDependencies,
    }),
  });

  return NextResponse.json({ companyId, entitlement });
});
