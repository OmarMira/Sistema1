import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ----- MOCKS -----
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());
const mockUpsert = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: {
    bankProfile: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      upsert: mockUpsert,
      update: mockUpdate,
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    slowQuery: vi.fn(),
  },
}));

// ----- HELPERS -----
const VALID_CONFIG = {
  layoutType: 'SINGLE_AMOUNT_COLUMN' as const,
  lineGroupingTolerancePx: 5,
  numberFormat: {
    decimalSeparator: '.',
    thousandsSeparator: ',',
    negativeIndicator: 'MINUS_SIGN',
    negativePosition: 'PREFIX' as const,
  },
  rules: {
    anchor: {
      regex: '^\\d{2}/\\d{2}/\\d{2}$',
      columnRange: [0.0, 0.18] as [number, number],
    },
    columns: {
      date: [0.0, 0.18] as [number, number],
      description: [0.18, 0.80] as [number, number],
      amount: [0.80, 1.0] as [number, number],
    },
    metadata: {
      accountNumber: [],
      initialBalance: [],
      finalBalance: [],
    },
  },
};

function makeRawProfile(overrides: Record<string, any> = {}): any {
  return {
    id: 'profile-1',
    bankId: 'boa',
    bankName: 'Bank of America',
    fingerprints: '["fp-1","fp-2"]',
    isActive: true,
    requiresReview: false,
    config: JSON.stringify(VALID_CONFIG),
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
    ...overrides,
  };
}

// ----- IMPORT (after mocks) -----
import {
  getBankProfile,
  getAllActiveProfiles,
  invalidateProfileCache,
  invalidateAllProfilesCache,
  upsertBankProfile,
  updateRequiresReviewStatus,
} from '@/lib/bank-profile-service';

import { BankProfileConfigSchema } from '@/lib/bank-profile-schema';

describe('bank-profile-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level in-memory cache before each test
    invalidateAllProfilesCache();
  });

  // ──────────────────────────────────────────────
  //  getBankProfile
  // ──────────────────────────────────────────────
  describe('getBankProfile', () => {
    it('should return null when profile not found', async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await getBankProfile('nonexistent');

      expect(result).toBeNull();
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { bankId: 'nonexistent' } });
    });

    it('should fetch from DB on first call and cache on second', async () => {
      const raw = makeRawProfile();
      mockFindUnique.mockResolvedValue(raw);

      // First call -> hits DB
      const first = await getBankProfile('boa');
      expect(first).not.toBeNull();
      expect(first!.bankId).toBe('boa');
      expect(first!.bankName).toBe('Bank of America');
      expect(first!.fingerprints).toEqual(['fp-1', 'fp-2']);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      // Second call -> serves from cache (no additional DB call)
      mockFindUnique.mockClear();
      const second = await getBankProfile('boa');
      expect(second).not.toBeNull();
      expect(second!.bankId).toBe('boa');
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('should return typed profile with FingerprintTyped shape', async () => {
      const raw = makeRawProfile();
      mockFindUnique.mockResolvedValue(raw);

      const result = await getBankProfile('boa');

      expect(result).toMatchObject({
        id: 'profile-1',
        bankId: 'boa',
        bankName: 'Bank of America',
        fingerprints: ['fp-1', 'fp-2'],
        isActive: true,
        requiresReview: false,
        config: expect.objectContaining({
          layoutType: 'SINGLE_AMOUNT_COLUMN',
        }),
      });
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.updatedAt).toBeInstanceOf(Date);
    });

    it('should throw when DB config is invalid', async () => {
      const raw = makeRawProfile({
        config: JSON.stringify({ invalid: true }),
      });
      mockFindUnique.mockResolvedValue(raw);

      await expect(getBankProfile('boa')).rejects.toThrow(
        'Bank profile "boa" has invalid configuration in database',
      );
    });
  });

  // ──────────────────────────────────────────────
  //  getAllActiveProfiles
  // ──────────────────────────────────────────────
  describe('getAllActiveProfiles', () => {
    it('should fetch all active profiles from DB', async () => {
      const raw1 = makeRawProfile({ bankId: 'boa', bankName: 'BOA' });
      const raw2 = makeRawProfile({ id: 'profile-2', bankId: 'citi', bankName: 'Citi' });
      mockFindMany.mockResolvedValue([raw1, raw2]);

      const results = await getAllActiveProfiles();

      expect(results).toHaveLength(2);
      expect(results[0].bankId).toBe('boa');
      expect(results[1].bankId).toBe('citi');
      expect(mockFindMany).toHaveBeenCalledWith({ where: { isActive: true } });
    });

    it('should cache results and not call DB again', async () => {
      const raw = makeRawProfile();
      mockFindMany.mockResolvedValue([raw]);

      const first = await getAllActiveProfiles();
      expect(first).toHaveLength(1);

      mockFindMany.mockClear();
      const second = await getAllActiveProfiles();
      expect(second).toHaveLength(1);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('should return empty array when no active profiles', async () => {
      mockFindMany.mockResolvedValue([]);

      const results = await getAllActiveProfiles();
      expect(results).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────
  //  Cache invalidation
  // ──────────────────────────────────────────────
  describe('cache invalidation', () => {
    it('invalidateProfileCache should clear single profile and all profiles cache', async () => {
      const raw = makeRawProfile();
      mockFindUnique.mockResolvedValue(raw);

      // Warm cache
      await getBankProfile('boa');
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      // Invalidate
      invalidateProfileCache('boa');

      // Should hit DB again
      mockFindUnique.mockClear();
      mockFindUnique.mockResolvedValue(raw);
      await getBankProfile('boa');
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });

    it('invalidateAllProfilesCache should clear all caches', async () => {
      const raw = makeRawProfile();
      const raw2 = makeRawProfile({ id: 'profile-2', bankId: 'citi' });
      mockFindUnique.mockResolvedValue(raw);
      mockFindMany.mockResolvedValue([raw, raw2]);

      // Warm both caches
      await getBankProfile('boa');
      await getAllActiveProfiles();
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(mockFindMany).toHaveBeenCalledTimes(1);

      // Invalidate all
      invalidateAllProfilesCache();

      // Should hit DB again for both
      mockFindUnique.mockClear();
      mockFindMany.mockClear();
      mockFindUnique.mockResolvedValue(raw);
      mockFindMany.mockResolvedValue([raw, raw2]);

      await getBankProfile('boa');
      await getAllActiveProfiles();
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(mockFindMany).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────
  //  upsertBankProfile
  // ──────────────────────────────────────────────
  describe('upsertBankProfile', () => {
    it('should upsert profile with validated config and JSON-serialized fields', async () => {
      const raw = makeRawProfile();
      mockUpsert.mockResolvedValue(raw);

      const result = await upsertBankProfile('boa', 'Bank of America', ['fp-1', 'fp-2'], VALID_CONFIG);

      expect(mockUpsert).toHaveBeenCalledWith({
        where: { bankId: 'boa' },
        create: {
          bankId: 'boa',
          bankName: 'Bank of America',
          fingerprints: JSON.stringify(['fp-1', 'fp-2']),
          config: JSON.stringify(VALID_CONFIG),
          isActive: true,
          requiresReview: false,
        },
        update: {
          bankName: 'Bank of America',
          fingerprints: JSON.stringify(['fp-1', 'fp-2']),
          config: JSON.stringify(VALID_CONFIG),
          isActive: true,
          requiresReview: false,
        },
      });

      expect(result).toMatchObject({
        bankId: 'boa',
        bankName: 'Bank of America',
        fingerprints: ['fp-1', 'fp-2'],
      });
    });

    it('should pass requiresReview when provided', async () => {
      const raw = makeRawProfile({ requiresReview: true });
      mockUpsert.mockResolvedValue(raw);

      await upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG, true);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ requiresReview: true }),
          update: expect.objectContaining({ requiresReview: true }),
        }),
      );
    });

    it('should invalidate cache after upsert', async () => {
      const raw = makeRawProfile();
      mockFindUnique.mockResolvedValue(raw);
      mockUpsert.mockResolvedValue(raw);

      // Warm cache
      await getBankProfile('boa');
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      // Upsert
      await upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG);

      // Should hit DB again (cache was invalidated)
      mockFindUnique.mockClear();
      mockFindUnique.mockResolvedValue(raw);
      await getBankProfile('boa');
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });

    it('should throw ZodError when config is invalid', async () => {
      const invalidConfig = { invalid: true } as any;

      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], invalidConfig),
      ).rejects.toThrow();
    });

    it('should throw ZodError for missing required config fields', async () => {
      const incompleteConfig = {
        layoutType: 'SINGLE_AMOUNT_COLUMN',
        // missing lineGroupingTolerancePx, numberFormat, rules
      } as any;

      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], incompleteConfig),
      ).rejects.toThrow();
    });

    it('should parse fingerprints as string array', async () => {
      const raw = makeRawProfile({ fingerprints: '["fp-a","fp-b"]' });
      mockUpsert.mockResolvedValue(raw);

      const result = await upsertBankProfile('boa', 'BOA', ['fp-a', 'fp-b'], VALID_CONFIG);
      expect(result.fingerprints).toEqual(['fp-a', 'fp-b']);
    });
  });

  // ──────────────────────────────────────────────
  //  updateRequiresReviewStatus
  // ──────────────────────────────────────────────
  describe('updateRequiresReviewStatus', () => {
    it('should update the requiresReview flag and invalidate cache', async () => {
      mockUpdate.mockResolvedValue({});

      await updateRequiresReviewStatus('boa', true);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { bankId: 'boa' },
        data: { requiresReview: true },
      });
    });

    it('should invalidate cache after update', async () => {
      const raw = makeRawProfile();
      mockFindUnique.mockResolvedValue(raw);
      mockUpdate.mockResolvedValue({});

      // Warm cache
      await getBankProfile('boa');
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      // Update status -> invalidates cache
      await updateRequiresReviewStatus('boa', true);

      // Should hit DB again
      mockFindUnique.mockClear();
      mockFindUnique.mockResolvedValue(raw);
      const result = await getBankProfile('boa');
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
    });
  });

  // ──────────────────────────────────────────────
  //  Fingerprints parsing
  // ──────────────────────────────────────────────
  describe('fingerprints parsing', () => {
    it('should parse fingerprints from JSON string', async () => {
      mockFindUnique.mockResolvedValue(
        makeRawProfile({ fingerprints: '["fingerprint-x"]' }),
      );

      const result = await getBankProfile('boa');
      expect(result!.fingerprints).toEqual(['fingerprint-x']);
    });

    it('should handle fingerprints as array directly', async () => {
      mockFindUnique.mockResolvedValue(
        makeRawProfile({ fingerprints: ['fp-arr-1', 'fp-arr-2'] }),
      );

      const result = await getBankProfile('boa');
      expect(result!.fingerprints).toEqual(['fp-arr-1', 'fp-arr-2']);
    });

    it('should return empty array on parse error', async () => {
      mockFindUnique.mockResolvedValue(
        makeRawProfile({ fingerprints: 'not-valid-json' }),
      );

      const result = await getBankProfile('boa');
      expect(result!.fingerprints).toEqual([]);
    });
  });
});
