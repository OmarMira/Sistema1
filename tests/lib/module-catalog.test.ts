import { describe, it, expect } from 'vitest';
import {
  MODULE_CATALOG,
  MODULE_KEYS,
  isModuleKey,
} from '@/lib/constants/module-catalog';

const EXPECTED_KEYS = ['accounting', 'banking', 'purchases', 'sales', 'inventory'] as const;

describe('module catalog', () => {
  // C1
  it('MODULE_CATALOG has exactly 5 entries and MODULE_KEYS has length 5', () => {
    expect(MODULE_CATALOG).toHaveLength(5);
    expect(MODULE_KEYS).toHaveLength(5);
  });

  // C2
  it("keys are exactly ['accounting','banking','purchases','sales','inventory'] in both MODULE_KEYS and catalog", () => {
    expect([...MODULE_KEYS]).toEqual([...EXPECTED_KEYS]);
    expect(MODULE_CATALOG.map((entry) => entry.key)).toEqual([...EXPECTED_KEYS]);
  });

  // C3
  it('statuses match the contract per module', () => {
    const statusByKey = new Map(MODULE_CATALOG.map((entry) => [entry.key, entry.implementationStatus]));
    expect(statusByKey.get('accounting')).toBe('AVAILABLE');
    expect(statusByKey.get('banking')).toBe('AVAILABLE');
    expect(statusByKey.get('purchases')).toBe('PARTIAL');
    expect(statusByKey.get('sales')).toBe('PARTIAL');
    expect(statusByKey.get('inventory')).toBe('UNAVAILABLE');
  });

  // C4
  it('every price is a string with exactly two decimals', () => {
    const twoDecimals = /^\d+\.\d{2}$/;
    for (const entry of MODULE_CATALOG) {
      expect(typeof entry.price).toBe('string');
      expect(entry.price).toMatch(twoDecimals);
    }
  });

  // C5
  it('every dependency references an existing module key', () => {
    for (const entry of MODULE_CATALOG) {
      for (const dep of entry.dependencies) {
        expect(MODULE_KEYS).toContain(dep);
      }
    }
  });

  // C6
  it('dependencies are exact per module', () => {
    const depsByKey = new Map(MODULE_CATALOG.map((entry) => [entry.key, entry.dependencies]));
    expect(depsByKey.get('accounting')).toEqual([]);
    expect(depsByKey.get('banking')).toEqual(['accounting']);
    expect(depsByKey.get('purchases')).toEqual(['accounting']);
    expect(depsByKey.get('sales')).toEqual(['accounting']);
    expect(depsByKey.get('inventory')).toEqual([]);
  });

  // C7
  it('isModuleKey returns true for each of the 5 keys', () => {
    for (const key of EXPECTED_KEYS) {
      expect(isModuleKey(key)).toBe(true);
    }
  });

  // C8
  it('isModuleKey returns false for unknown and non-string values', () => {
    expect(isModuleKey('unknown')).toBe(false);
    expect(isModuleKey(42)).toBe(false);
  });
});
