/**
 * Default per-company module entitlement initialization.
 *
 * Seeds the fixed default profile for a newly created company:
 * accounting/banking enabled, purchases/sales/inventory disabled.
 *
 * Idempotent by construction: every write is an upsert keyed by
 * (companyId, moduleKey) with an EMPTY update payload, so a pre-existing
 * entitlement row is never overwritten and no duplicates can be created.
 */
import type { Prisma } from '@prisma/client';
import type { ModuleKey } from '@/lib/constants/module-catalog';

interface DefaultEntitlementProfileEntry {
  moduleKey: ModuleKey;
  enabled: boolean;
}

/**
 * Structural view of a (possibly extended) Prisma transaction client reduced
 * to the single operation this initializer performs. The app's `db` client is
 * `$extends`-wrapped, so its transaction callback parameter is not assignable
 * to `Prisma.TransactionClient`; this type accepts both the base and the
 * extended transaction clients without any cast at the call sites.
 */
export interface EntitlementInitializationClient {
  companyModuleEntitlement: {
    upsert(args: Prisma.CompanyModuleEntitlementUpsertArgs): PromiseLike<unknown>;
  };
}

export const DEFAULT_COMPANY_MODULE_ENTITLEMENT_PROFILE: readonly DefaultEntitlementProfileEntry[] = [
  { moduleKey: 'accounting', enabled: true },
  { moduleKey: 'banking', enabled: true },
  { moduleKey: 'purchases', enabled: false },
  { moduleKey: 'sales', enabled: false },
  { moduleKey: 'inventory', enabled: false },
];

export async function initializeDefaultCompanyModuleEntitlements(
  tx: EntitlementInitializationClient,
  companyId: string,
): Promise<void> {
  for (const { moduleKey, enabled } of DEFAULT_COMPANY_MODULE_ENTITLEMENT_PROFILE) {
    await tx.companyModuleEntitlement.upsert({
      where: { companyId_moduleKey: { companyId, moduleKey } },
      create: {
        companyId,
        moduleKey,
        enabled,
        activatedAt: enabled ? new Date() : null,
        deactivatedAt: null,
      },
      // Empty update: never overwrite a pre-existing entitlement row.
      update: {},
    });
  }
}
