import { db } from '@/lib/db';
import { isModuleKey, type ModuleKey } from '@/lib/constants/module-catalog';
import { ValidationError } from '@/lib/api-error';

/**
 * Persistence primitives for per-company commercial module entitlements.
 *
 * Deliberately NOT here (separate concerns, later steps):
 * - authorization / RBAC
 * - availability policy (AVAILABLE / PARTIAL / UNAVAILABLE)
 * - dependency resolution
 * - audit logging
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
