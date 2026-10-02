/**
 * Commercial module entitlement resolver.
 *
 * Pure read-only resolution: combines the static module catalog (availability
 * policy and dependencies) with the tenant-scoped entitlement row (commercial
 * state) to decide whether a module is effectively enabled for a company.
 *
 * The resolver NEVER mutates data and deliberately contains NO RBAC,
 * NO AuditLog, and NO SystemConfig access — those concerns belong to callers.
 */
import {
  MODULE_CATALOG,
  isModuleKey,
  type ImplementationStatus,
  type ModuleCatalogEntry,
  type ModuleKey,
} from '@/lib/constants/module-catalog';
import { ValidationError } from '@/lib/api-error';
import { getCompanyModuleEntitlement } from '@/lib/services/module-entitlements.service';

export type ModuleEntitlementReason =
  | 'EFFECTIVE_ENABLED'
  | 'NOT_CONFIGURED'
  | 'COMMERCIALLY_DISABLED'
  | 'IMPLEMENTATION_UNAVAILABLE'
  | 'MISSING_DEPENDENCY';

export interface ModuleEntitlementResult {
  moduleKey: ModuleKey;
  implementationStatus: ImplementationStatus;
  configured: boolean;
  commercialEnabled: boolean;
  effectiveEnabled: boolean;
  reason: ModuleEntitlementReason;
  missingDependencies: ModuleKey[];
}

function findCatalogEntry(moduleKey: ModuleKey): ModuleCatalogEntry {
  const entry = MODULE_CATALOG.find((candidate) => candidate.key === moduleKey);
  if (!entry) {
    // Unreachable: isModuleKey guarantees membership in MODULE_CATALOG.
    throw new ValidationError(`Unknown module key: ${moduleKey}`, { moduleKey });
  }
  return entry;
}

async function resolveEntry(
  companyId: string,
  moduleKey: ModuleKey,
  visited: ReadonlySet<ModuleKey>,
): Promise<ModuleEntitlementResult> {
  const entry = findCatalogEntry(moduleKey);
  const implementationStatus = entry.implementationStatus;
  const row = await getCompanyModuleEntitlement(companyId, moduleKey);

  // 4. No entitlement row for this tenant.
  if (!row) {
    return {
      moduleKey,
      implementationStatus,
      configured: false,
      commercialEnabled: false,
      effectiveEnabled: false,
      reason: 'NOT_CONFIGURED',
      missingDependencies: [],
    };
  }

  // 5. Implementation unavailable — checked BEFORE the commercial flag, so an
  //    UNAVAILABLE module always resolves to IMPLEMENTATION_UNAVAILABLE
  //    regardless of `enabled`.
  if (implementationStatus === 'UNAVAILABLE') {
    return {
      moduleKey,
      implementationStatus,
      configured: true,
      commercialEnabled: row.enabled,
      effectiveEnabled: false,
      reason: 'IMPLEMENTATION_UNAVAILABLE',
      missingDependencies: [],
    };
  }

  // 6. Commercially disabled.
  if (!row.enabled) {
    return {
      moduleKey,
      implementationStatus,
      configured: true,
      commercialEnabled: false,
      effectiveEnabled: false,
      reason: 'COMMERCIALLY_DISABLED',
      missingDependencies: [],
    };
  }

  // 7. Dependencies: satisfied ONLY when the dependency's own full recursive
  //    resolution reaches effectiveEnabled=true. The catalog is a static
  //    acyclic graph; the visited set is a recursion guard only.
  const nextVisited = new Set(visited);
  nextVisited.add(moduleKey);
  const missingDependencies: ModuleKey[] = [];
  for (const dependency of entry.dependencies) {
    if (nextVisited.has(dependency)) {
      // Cycle guard — unreachable with the current acyclic catalog.
      continue;
    }
    const dependencyResult = await resolveEntry(companyId, dependency, nextVisited);
    if (!dependencyResult.effectiveEnabled) {
      missingDependencies.push(dependency);
    }
  }

  // 8. At least one dependency is not satisfied.
  if (missingDependencies.length > 0) {
    return {
      moduleKey,
      implementationStatus,
      configured: true,
      commercialEnabled: true,
      effectiveEnabled: false,
      reason: 'MISSING_DEPENDENCY',
      missingDependencies,
    };
  }

  // 9. Everything is satisfied.
  return {
    moduleKey,
    implementationStatus,
    configured: true,
    commercialEnabled: true,
    effectiveEnabled: true,
    reason: 'EFFECTIVE_ENABLED',
    missingDependencies: [],
  };
}

export async function resolveCompanyModuleEntitlement(
  companyId: string,
  moduleKey: string,
): Promise<ModuleEntitlementResult> {
  // 1. Validate the module key.
  if (!isModuleKey(moduleKey)) {
    throw new ValidationError(`Unknown module key: ${moduleKey}`, { moduleKey });
  }
  return resolveEntry(companyId, moduleKey, new Set());
}
