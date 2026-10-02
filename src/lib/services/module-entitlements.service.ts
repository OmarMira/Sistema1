import { db } from '@/lib/db';
import { isModuleKey, MODULE_CATALOG, type ModuleKey } from '@/lib/constants/module-catalog';
import { ValidationError } from '@/lib/api-error';

/**
 * Persistence primitives for per-company commercial module entitlements.
 *
 * Deliberately NOT here (separate concerns, later steps):
 * - authorization / RBAC
 * - dependency resolution
 * - audit logging
 *
 * Availability policy is enforced only at enable-time: enableCompanyModule
 * rejects modules whose catalog implementationStatus is UNAVAILABLE
 * (PARTIAL and AVAILABLE remain allowed).
 *
 * Every read and write is scoped by companyId: there is no code path that can
 * read or mutate a row without supplying the owning tenant.
 */

function assertModuleKey(moduleKey: string): ModuleKey {
  if (!isModuleKey(moduleKey)) {
    throw new ValidationError(`Unknown module key: ${moduleKey}`, { moduleKey });
  }
  return moduleKey;
}

export function listCompanyModuleEntitlements(companyId: string) {
  return db.companyModuleEntitlement.findMany({ where: { companyId } });
}

export function getCompanyModuleEntitlement(companyId: string, moduleKey: string) {
  const key = assertModuleKey(moduleKey);
  return db.companyModuleEntitlement.findFirst({ where: { companyId, moduleKey: key } });
}

export function enableCompanyModule(companyId: string, moduleKey: string) {
  const key = assertModuleKey(moduleKey);
  const catalogEntry = MODULE_CATALOG.find((entry) => entry.key === key);
  if (catalogEntry?.implementationStatus === 'UNAVAILABLE') {
    throw new ValidationError('Module cannot be enabled: implementation status is UNAVAILABLE', {
      moduleKey: key,
    });
  }
  return db.companyModuleEntitlement.upsert({
    where: { companyId_moduleKey: { companyId, moduleKey: key } },
    create: {
      companyId,
      moduleKey: key,
      enabled: true,
      activatedAt: new Date(),
      deactivatedAt: null,
    },
    update: {
      enabled: true,
      activatedAt: new Date(),
      deactivatedAt: null,
    },
  });
}

export function disableCompanyModule(companyId: string, moduleKey: string) {
  const key = assertModuleKey(moduleKey);
  // activatedAt is intentionally NOT touched: it records the last activation.
  return db.companyModuleEntitlement.updateMany({
    where: { companyId, moduleKey: key },
    data: { enabled: false, deactivatedAt: new Date() },
  });
}
