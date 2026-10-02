/**
 * Static commercial module catalog.
 *
 * This is a pure data module: it declares which commercial modules exist, how
 * each one is currently implemented, and its (placeholder) price. It performs
 * NO entitlement resolution, NO pricing computation, and NO subscription
 * handling — prices are deliberately plain decimal strings so no float
 * arithmetic can ever touch them.
 */

export type ModuleKey = 'accounting' | 'banking' | 'purchases' | 'sales' | 'inventory';

export type ImplementationStatus = 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';

export interface ModuleCatalogEntry {
  key: ModuleKey;
  displayName: string;
  implementationStatus: ImplementationStatus;
  /** Decimal string with exactly two decimals (e.g. '0.00'). Never a number. */
  price: string;
  dependencies: ModuleKey[];
}

export const MODULE_KEYS: readonly ModuleKey[] = [
  'accounting',
  'banking',
  'purchases',
  'sales',
  'inventory',
];

export const MODULE_CATALOG: readonly ModuleCatalogEntry[] = [
  {
    key: 'accounting',
    displayName: 'Accounting',
    implementationStatus: 'AVAILABLE',
    price: '0.00',
    dependencies: [],
  },
  {
    key: 'banking',
    displayName: 'Banking',
    implementationStatus: 'AVAILABLE',
    price: '0.00',
    dependencies: ['accounting'],
  },
  {
    key: 'purchases',
    displayName: 'Purchases',
    implementationStatus: 'PARTIAL',
    price: '0.00',
    dependencies: ['accounting'],
  },
  {
    key: 'sales',
    displayName: 'Sales',
    implementationStatus: 'PARTIAL',
    price: '0.00',
    dependencies: ['accounting'],
  },
  {
    key: 'inventory',
    displayName: 'Inventory',
    implementationStatus: 'UNAVAILABLE',
    price: '0.00',
    dependencies: [],
  },
];

export function isModuleKey(value: unknown): value is ModuleKey {
  return (MODULE_KEYS as readonly unknown[]).includes(value);
}
