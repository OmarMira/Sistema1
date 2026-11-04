import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      description: [0.18, 0.8] as [number, number],
      amount: [0.8, 1.0] as [number, number],
    },
    metadata: {
      accountNumber: [],
      initialBalance: [],
      finalBalance: [],
    },
  },
};

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

function makeRawProfile(overrides: Record<string, any> = {}): any {
  return {
    id: 'profile-1',
    bankId: 'boa',
    companyId: null,
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
  BankProfileTenantScopeError,
  getBankProfile,
  getAllActiveProfiles,
  invalidateProfileCache,
  invalidateAllProfilesCache,
  upsertBankProfile,
  updateRequiresReviewStatus,
} from '@/lib/bank-profile-service';
import { logger } from '@/lib/logger';

const GLOBAL_LOOKUP = (bankId: string) => ({ where: { bankId, companyId: null }, take: 1 });

describe('bank-profile-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level in-memory cache before each test
    invalidateAllProfilesCache();
  });

  // ──────────────────────────────────────────────
  //  getBankProfile — no tenant context (global seeds only)
  // ──────────────────────────────────────────────
  describe('getBankProfile (global seed)', () => {
    it('returns null when no profile exists and logs nothing fatal', async () => {
      mockFindMany.mockResolvedValue([]);

      const result = await getBankProfile('nonexistent');

      expect(result).toBeNull();
      expect(mockFindMany).toHaveBeenCalledWith(GLOBAL_LOOKUP('nonexistent'));
      // Never a findUnique: a nullable companyId is not addressable by a unique input
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('fetches the global seed from the DB on first call and caches it', async () => {
      mockFindMany.mockResolvedValue([makeRawProfile()]);

      const first = await getBankProfile('boa');
      expect(first).not.toBeNull();
      expect(first!.bankId).toBe('boa');
      expect(first!.companyId).toBeNull();
      expect(first!.bankName).toBe('Bank of America');
      expect(first!.fingerprints).toEqual(['fp-1', 'fp-2']);
      expect(mockFindMany).toHaveBeenCalledTimes(1);

      mockFindMany.mockClear();
      const second = await getBankProfile('boa');
      expect(second).not.toBeNull();
      expect(second!.bankId).toBe('boa');
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('returns the typed profile shape including the resolved company scope', async () => {
      mockFindMany.mockResolvedValue([makeRawProfile()]);

      const result = await getBankProfile('boa');

      expect(result).toMatchObject({
        id: 'profile-1',
        bankId: 'boa',
        companyId: null,
        bankName: 'Bank of America',
        fingerprints: ['fp-1', 'fp-2'],
        isActive: true,
        requiresReview: false,
        config: expect.objectContaining({ layoutType: 'SINGLE_AMOUNT_COLUMN' }),
      });
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.updatedAt).toBeInstanceOf(Date);
    });

    it('skips a corrupt row with a logged warning instead of throwing', async () => {
      mockFindMany.mockResolvedValue([makeRawProfile({ config: JSON.stringify({ invalid: true }) })]);

      await expect(getBankProfile('boa')).resolves.toBeNull();

      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping unusable bank profile row',
        expect.objectContaining({ bankId: 'boa', companyId: null }),
      );
    });
  });

  // ──────────────────────────────────────────────
  //  getBankProfile — company-scoped lookup order
  // ──────────────────────────────────────────────
  describe('getBankProfile (company-scoped)', () => {
    it('prefers the company-scoped profile over the global seed', async () => {
      mockFindUnique.mockResolvedValue(
        makeRawProfile({ id: 'company-row', companyId: COMPANY_A, bankName: 'BOA (mine)' }),
      );

      const result = await getBankProfile('boa', COMPANY_A);

      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { bankId_companyId: { bankId: 'boa', companyId: COMPANY_A } },
      });
      expect(result!.id).toBe('company-row');
      expect(result!.companyId).toBe(COMPANY_A);
      // The global seed is never even queried when the company has a profile
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('falls back to the global read-only seed when the company has no profile', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindMany.mockResolvedValue([makeRawProfile({ id: 'global-row' })]);

      const result = await getBankProfile('boa', COMPANY_B);

      expect(result!.id).toBe('global-row');
      expect(result!.companyId).toBeNull();
      expect(mockFindMany).toHaveBeenCalledWith(GLOBAL_LOOKUP('boa'));
      // A read never writes
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('falls back to the global seed when the company row is corrupt', async () => {
      mockFindUnique.mockResolvedValue(
        makeRawProfile({ id: 'company-row', companyId: COMPANY_A, config: '{"broken":true}' }),
      );
      mockFindMany.mockResolvedValue([makeRawProfile({ id: 'global-row' })]);

      const result = await getBankProfile('boa', COMPANY_A);

      expect(result!.id).toBe('global-row');
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping unusable bank profile row',
        expect.objectContaining({ companyId: COMPANY_A }),
      );
    });
  });

  // ──────────────────────────────────────────────
  //  getAllActiveProfiles
  // ──────────────────────────────────────────────
  describe('getAllActiveProfiles', () => {
    it('reads only global seeds when no tenant is supplied', async () => {
      const raw1 = makeRawProfile({ bankId: 'boa', bankName: 'BOA' });
      const raw2 = makeRawProfile({ id: 'profile-2', bankId: 'citi', bankName: 'Citi' });
      mockFindMany.mockResolvedValue([raw1, raw2]);

      const results = await getAllActiveProfiles();

      expect(results).toHaveLength(3);
      expect(results.some((r) => r.bankId === 'boa')).toBe(true);
      expect(results.some((r) => r.bankId === 'citi')).toBe(true);
      expect(results.some((r) => r.bankId === 'boa-standard')).toBe(true);
      expect(mockFindMany).toHaveBeenCalledWith({ where: { isActive: true, companyId: null } });
    });

    it('merges the company scope with global seeds and lets the company win', async () => {
      mockFindMany.mockImplementation(async (args: any) => {
        if (args.where.OR) {
          return [
            makeRawProfile({ id: 'company-boa', bankId: 'boa', companyId: COMPANY_A, bankName: 'Mine' }),
            makeRawProfile({ id: 'global-boa', bankId: 'boa', bankName: 'Global BOA' }),
            makeRawProfile({ id: 'global-citi', bankId: 'citi', bankName: 'Global Citi' }),
          ];
        }
        return [];
      });

      const results = await getAllActiveProfiles(COMPANY_A);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { isActive: true, OR: [{ companyId: COMPANY_A }, { companyId: null }] },
      });
      const boa = results.filter((r) => r.bankId === 'boa');
      expect(boa).toHaveLength(1);
      expect(boa[0]!.id).toBe('company-boa');
      expect(boa[0]!.companyId).toBe(COMPANY_A);
      // Global seeds for bankIds the company has not overridden still apply
      expect(results.some((r) => r.id === 'global-citi')).toBe(true);
    });

    it('skips corrupt rows per profile and keeps the rest of the tenant list', async () => {
      mockFindMany.mockImplementation(async (args: any) => {
        if (args.where.OR) {
          return [
            makeRawProfile({ id: 'bad', bankId: 'boa', companyId: COMPANY_A, config: 'null' }),
            makeRawProfile({ id: 'good', bankId: 'citi', companyId: COMPANY_A }),
          ];
        }
        return [];
      });

      const results = await getAllActiveProfiles(COMPANY_A);

      expect(results.map((r) => r.id)).toContain('good');
      expect(results.map((r) => r.id)).not.toContain('bad');
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping unusable bank profile row',
        expect.objectContaining({ profileId: 'bad' }),
      );
    });

    it('caches per company and does not call the DB again', async () => {
      mockFindMany.mockResolvedValue([makeRawProfile()]);

      const first = await getAllActiveProfiles(COMPANY_A);
      expect(first.length).toBeGreaterThanOrEqual(1);

      mockFindMany.mockClear();
      const second = await getAllActiveProfiles(COMPANY_A);
      expect(second.length).toBeGreaterThanOrEqual(1);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('keeps sending the packaged fallback when the DB is empty', async () => {
      mockFindMany.mockResolvedValue([]);

      const results = await getAllActiveProfiles();

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.bankId === 'boa-standard')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  //  Cache invalidation
  // ──────────────────────────────────────────────
  describe('cache invalidation', () => {
    it('invalidateProfileCache(bankId) clears every cached resolution of that bankId', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindMany.mockResolvedValue([makeRawProfile()]);

      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      invalidateProfileCache('boa');

      mockFindUnique.mockClear();
      mockFindMany.mockClear();
      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });

    it('invalidateProfileCache(bankId, companyId) only drops that company entry', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindMany.mockResolvedValue([makeRawProfile()]);

      await getBankProfile('boa', COMPANY_A);
      await getBankProfile('boa', COMPANY_B);
      expect(mockFindUnique).toHaveBeenCalledTimes(2);

      mockFindUnique.mockClear();
      invalidateProfileCache('boa', COMPANY_A);

      // Company B still served from cache
      await getBankProfile('boa', COMPANY_B);
      expect(mockFindUnique).not.toHaveBeenCalled();

      // Company A re-reads
      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });

    it('invalidateAllProfilesCache clears every cache', async () => {
      const raw = makeRawProfile();
      const raw2 = makeRawProfile({ id: 'profile-2', bankId: 'citi' });
      mockFindMany.mockResolvedValue([raw, raw2]);
      mockFindUnique.mockResolvedValue(raw);

      await getBankProfile('boa', COMPANY_A);
      await getAllActiveProfiles(COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(mockFindMany).toHaveBeenCalledTimes(2);

      invalidateAllProfilesCache();

      mockFindUnique.mockClear();
      mockFindMany.mockClear();
      mockFindMany.mockResolvedValue([raw, raw2]);
      mockFindUnique.mockResolvedValue(raw);

      await getBankProfile('boa', COMPANY_A);
      await getAllActiveProfiles(COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(mockFindMany).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────
  //  upsertBankProfile — company-scoped writes only
  // ──────────────────────────────────────────────
  describe('upsertBankProfile', () => {
    it('upserts keyed on (bankId, companyId) with JSON-serialized fields', async () => {
      const raw = makeRawProfile({ companyId: COMPANY_A });
      mockUpsert.mockResolvedValue(raw);

      const result = await upsertBankProfile(
        'boa',
        'Bank of America',
        ['fp-1', 'fp-2'],
        VALID_CONFIG,
        false,
        COMPANY_A,
      );

      expect(mockUpsert).toHaveBeenCalledWith({
        where: { bankId_companyId: { bankId: 'boa', companyId: COMPANY_A } },
        create: {
          bankId: 'boa',
          companyId: COMPANY_A,
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
        companyId: COMPANY_A,
        bankName: 'Bank of America',
        fingerprints: ['fp-1', 'fp-2'],
      });
    });

    it('passes requiresReview when provided', async () => {
      mockUpsert.mockResolvedValue(makeRawProfile({ companyId: COMPANY_A, requiresReview: true }));

      await upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG, true, COMPANY_A);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ companyId: COMPANY_A, requiresReview: true }),
          update: expect.objectContaining({ requiresReview: true }),
        }),
      );
    });

    it('rejects a write without a company scope (global rows are read-only)', async () => {
      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG),
      ).rejects.toBeInstanceOf(BankProfileTenantScopeError);

      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG, false, null),
      ).rejects.toThrow(/requires a companyId/);

      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG, false, '   '),
      ).rejects.toThrow(/requires a companyId/);

      // Guard test: no write path ever targets companyId NULL
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('invalidates the cache after upsert for that company', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindMany.mockResolvedValue([makeRawProfile()]);
      mockUpsert.mockResolvedValue(makeRawProfile({ companyId: COMPANY_A }));

      // Warm cache
      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      // Upsert
      await upsertBankProfile('boa', 'BOA', ['fp-1'], VALID_CONFIG, false, COMPANY_A);

      // Should hit DB again (cache was invalidated)
      mockFindUnique.mockClear();
      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });

    it('throws ZodError when config is invalid', async () => {
      const invalidConfig = { invalid: true } as any;

      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], invalidConfig, false, COMPANY_A),
      ).rejects.toThrow();
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('throws ZodError for missing required config fields', async () => {
      const incompleteConfig = {
        layoutType: 'SINGLE_AMOUNT_COLUMN',
        // missing lineGroupingTolerancePx, numberFormat, rules
      } as any;

      await expect(
        upsertBankProfile('boa', 'BOA', ['fp-1'], incompleteConfig, false, COMPANY_A),
      ).rejects.toThrow();
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('parses fingerprints as a string array', async () => {
      mockUpsert.mockResolvedValue(
        makeRawProfile({ companyId: COMPANY_A, fingerprints: '["fp-a","fp-b"]' }),
      );

      const result = await upsertBankProfile('boa', 'BOA', ['fp-a', 'fp-b'], VALID_CONFIG, false, COMPANY_A);
      expect(result.fingerprints).toEqual(['fp-a', 'fp-b']);
    });
  });

  // ──────────────────────────────────────────────
  //  updateRequiresReviewStatus — company-scoped writes only
  // ──────────────────────────────────────────────
  describe('updateRequiresReviewStatus', () => {
    it('updates the requiresReview flag on the company-scoped row and invalidates its cache', async () => {
      mockUpdate.mockResolvedValue({});

      await updateRequiresReviewStatus('boa', true, COMPANY_A);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { bankId_companyId: { bankId: 'boa', companyId: COMPANY_A } },
        data: { requiresReview: true },
      });
    });

    it('rejects a write without a company scope (global rows are read-only)', async () => {
      await expect(updateRequiresReviewStatus('boa', true)).rejects.toBeInstanceOf(
        BankProfileTenantScopeError,
      );
      await expect(updateRequiresReviewStatus('boa', true, null)).rejects.toThrow(
        /requires a companyId/,
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('invalidates the cache after the update', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindMany.mockResolvedValue([makeRawProfile()]);
      mockUpdate.mockResolvedValue({});

      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);

      await updateRequiresReviewStatus('boa', true, COMPANY_A);

      mockFindUnique.mockClear();
      await getBankProfile('boa', COMPANY_A);
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────
  //  Fingerprints parsing
  // ──────────────────────────────────────────────
  describe('fingerprints parsing', () => {
    it('parses fingerprints from a JSON string', async () => {
      mockFindMany.mockResolvedValue([makeRawProfile({ fingerprints: '["fingerprint-x"]' })]);

      const result = await getBankProfile('boa');
      expect(result!.fingerprints).toEqual(['fingerprint-x']);
    });

    it('handles fingerprints as an array directly', async () => {
      mockFindMany.mockResolvedValue([
        makeRawProfile({ fingerprints: ['fp-arr-1', 'fp-arr-2'] }),
      ]);

      const result = await getBankProfile('boa');
      expect(result!.fingerprints).toEqual(['fp-arr-1', 'fp-arr-2']);
    });

    it('returns an empty array on a fingerprints parse error without dropping the profile', async () => {
      mockFindMany.mockResolvedValue([makeRawProfile({ fingerprints: 'not-valid-json' })]);

      const result = await getBankProfile('boa');
      expect(result).not.toBeNull();
      expect(result!.fingerprints).toEqual([]);
    });
  });
});
