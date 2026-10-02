import { describe, it, expect } from 'vitest';
import { resolveNavEntitlementState, type NavEntitlementRow } from '@/lib/nav-entitlements';
import { MODULE_CATALOG, type ModuleCatalogEntry } from '@/lib/constants/module-catalog';

const accountingOnly: NavEntitlementRow[] = [{ moduleKey: 'accounting', enabled: true }];
const accountingDisabled: NavEntitlementRow[] = [{ moduleKey: 'accounting', enabled: false }];
const accountingAndBanking: NavEntitlementRow[] = [
  { moduleKey: 'accounting', enabled: true },
  { moduleKey: 'banking', enabled: true },
];
const bankingWithoutAccounting: NavEntitlementRow[] = [{ moduleKey: 'banking', enabled: true }];
const noRows: NavEntitlementRow[] = [];

describe('resolveNavEntitlementState — nav gating contract', () => {
  it('T1: accounting effective => accounting item VISIBLE', () => {
    expect(resolveNavEntitlementState('accounts', accountingOnly)).toBe('VISIBLE');
    expect(resolveNavEntitlementState('dashboard', accountingOnly)).toBe('VISIBLE');
    expect(resolveNavEntitlementState('reports', accountingOnly)).toBe('VISIBLE');
  });

  it('T2: accounting enabled=false => accounting item HIDDEN', () => {
    expect(resolveNavEntitlementState('accounts', accountingDisabled)).toBe('HIDDEN');
    expect(resolveNavEntitlementState('journal', accountingDisabled)).toBe('HIDDEN');
  });

  it('T3: banking enabled=true + accounting effective => banking VISIBLE', () => {
    expect(resolveNavEntitlementState('banks', accountingAndBanking)).toBe('VISIBLE');
    expect(resolveNavEntitlementState('reconciliation', accountingAndBanking)).toBe('VISIBLE');
  });

  it('T4: banking enabled=true + accounting ineffective => banking HIDDEN', () => {
    expect(resolveNavEntitlementState('banks', bankingWithoutAccounting)).toBe('HIDDEN');
    expect(resolveNavEntitlementState('bank-rules', bankingWithoutAccounting)).toBe('HIDDEN');
  });

  it('T5: missing entitlement row => DISABLED (NOT_CONFIGURED)', () => {
    expect(resolveNavEntitlementState('accounts', noRows)).toBe('DISABLED');
    expect(resolveNavEntitlementState('movement-summary', noRows)).toBe('DISABLED');
  });

  it('T6: settings => UNRESTRICTED regardless of rows', () => {
    expect(resolveNavEntitlementState('settings', noRows)).toBe('UNRESTRICTED');
    expect(resolveNavEntitlementState('settings', accountingDisabled)).toBe('UNRESTRICTED');
  });

  it('UNAVAILABLE implementation status => HIDDEN (even with enabled row)', () => {
    const catalog: ModuleCatalogEntry[] = MODULE_CATALOG.map((entry) =>
      entry.key === 'accounting'
        ? { ...entry, implementationStatus: 'UNAVAILABLE' as const }
        : entry,
    );
    expect(resolveNavEntitlementState('accounts', accountingOnly, catalog)).toBe('HIDDEN');
    expect(resolveNavEntitlementState('accounts', noRows, catalog)).toBe('HIDDEN');
  });

  it('banking accounting dependency comes from MODULE_CATALOG, not hardcoded', () => {
    const bankingEntry = MODULE_CATALOG.find((entry) => entry.key === 'banking');
    expect(bankingEntry?.dependencies).toContain('accounting');
    expect(bankingEntry?.implementationStatus).toBe('AVAILABLE');
  });
});
