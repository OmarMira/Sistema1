import {
  MODULE_CATALOG,
  type ModuleCatalogEntry,
  type ModuleKey,
} from '@/lib/constants/module-catalog';
import type { ViewName } from '@/store/auth-store';

export type NavEntitlementState = 'VISIBLE' | 'DISABLED' | 'HIDDEN' | 'UNRESTRICTED';

export type NavRenderDecision = 'RENDER' | 'RENDER_DISABLED' | 'HIDE';

export interface NavEntitlementRow {
  moduleKey: string;
  enabled: boolean;
}

export const NAV_VIEW_TO_MODULE: Partial<Record<ViewName, ModuleKey>> = {
  dashboard: 'accounting',
  'financial-dashboard': 'accounting',
  accounts: 'accounting',
  journal: 'accounting',
  reports: 'accounting',
  export: 'accounting',
  banks: 'banking',
  'bank-rules': 'banking',
  reconciliation: 'banking',
  'movement-summary': 'banking',
};

function findCatalogEntry(
  catalog: readonly ModuleCatalogEntry[],
  moduleKey: ModuleKey,
): ModuleCatalogEntry | undefined {
  return catalog.find((entry) => entry.key === moduleKey);
}

function isModuleEffective(
  moduleKey: ModuleKey,
  rowsByModule: ReadonlyMap<string, boolean>,
  catalog: readonly ModuleCatalogEntry[],
  visited: ReadonlySet<ModuleKey>,
): boolean {
  const entry = findCatalogEntry(catalog, moduleKey);
  if (!entry) return false;
  if (entry.implementationStatus === 'UNAVAILABLE') return false;
  if (rowsByModule.get(moduleKey) !== true) return false;
  for (const dependency of entry.dependencies) {
    if (visited.has(dependency)) continue;
    const nextVisited = new Set(visited);
    nextVisited.add(moduleKey);
    if (!isModuleEffective(dependency, rowsByModule, catalog, nextVisited)) return false;
  }
  return true;
}

export function resolveNavEntitlementState(
  view: ViewName,
  rows: readonly NavEntitlementRow[],
  catalog: readonly ModuleCatalogEntry[] = MODULE_CATALOG,
): NavEntitlementState {
  const moduleKey = NAV_VIEW_TO_MODULE[view];
  if (!moduleKey) return 'UNRESTRICTED';

  const entry = findCatalogEntry(catalog, moduleKey);
  if (!entry) return 'HIDDEN';
  if (entry.implementationStatus === 'UNAVAILABLE') return 'HIDDEN';

  const rowsByModule = new Map(rows.map((row) => [row.moduleKey, row.enabled]));
  if (!rowsByModule.has(moduleKey)) return 'DISABLED';
  if (rowsByModule.get(moduleKey) !== true) return 'HIDDEN';
  if (!isModuleEffective(moduleKey, rowsByModule, catalog, new Set())) return 'HIDDEN';
  return 'VISIBLE';
}

export function resolveNavRenderDecision(
  view: ViewName,
  entitlements: readonly NavEntitlementRow[] | null,
  status: { isLoading: boolean; error?: unknown },
): NavRenderDecision {
  if (!NAV_VIEW_TO_MODULE[view]) return 'RENDER';
  if (status.error !== undefined && status.error !== null) return 'HIDE';
  if (status.isLoading || entitlements === null) return 'HIDE';

  const state = resolveNavEntitlementState(view, entitlements);
  switch (state) {
    case 'UNRESTRICTED':
    case 'VISIBLE':
      return 'RENDER';
    case 'DISABLED':
      return 'RENDER_DISABLED';
    case 'HIDDEN':
      return 'HIDE';
  }
}
