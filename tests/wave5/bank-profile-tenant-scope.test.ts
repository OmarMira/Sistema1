/**
 * S1 (Wave 5) — BankProfile tenant scoping.
 *
 * Before this change "BankProfile"."bankId" was globally unique and the LLM
 * auto-create/heal path (pdf-parser → createProfileFromPdf → upsertBankProfile)
 * wrote to it unconditionally. One tenant's crafted PDF could therefore create or
 * overwrite the parsing profile every other tenant used.
 *
 * These tests pin the new contract on the real fixture database:
 *  (a) a crafted PDF learned for tenant A creates a company-A-scoped profile only —
 *      tenant B's parsing and the global seed row stay byte-identical;
 *  (b) a company-scoped profile wins over the global fallback for the same bankId;
 *  (c) a company without a profile falls back to the global read-only seed;
 *  (d) no write ever targets companyId NULL;
 *  (e) a corrupt profile row is skipped with a logged warning and parsing falls
 *      back instead of throwing;
 *  (f) a write invalidates that company's cache entry inside the same process
 *      without disturbing another tenant's entry.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  BankProfileTenantScopeError,
  getAllActiveProfiles,
  getBankProfile,
  invalidateAllProfilesCache,
  updateRequiresReviewStatus,
  upsertBankProfile,
} from '@/lib/bank-profile-service';
import { createProfileFromPdf } from '@/lib/bank-profile-onboarding';
import { parsePDF } from '@/lib/pdf-parser';
import { createTestCompany } from '../helpers/factories';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const BANK_PREFIX = `wave5-s1-${RUN}`;

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
    anchor: { regex: '^\\d{2}/\\d{2}/\\d{2}$', columnRange: [0.0, 0.18] as [number, number] },
    columns: {
      date: [0.0, 0.18] as [number, number],
      description: [0.18, 0.8] as [number, number],
      amount: [0.8, 1.0] as [number, number],
    },
    metadata: { accountNumber: [], initialBalance: [], finalBalance: [] },
  },
};

const COMPANY_IDS: string[] = [];

async function makeCompany(label: string): Promise<string> {
  const company = await createTestCompany(`Wave5 S1 ${label} ${RUN}`, 'BUSINESS', {
    seedEntitlements: false,
  });
  COMPANY_IDS.push(company.id);
  return company.id;
}

/** Direct DB seed: global rows are only ever created by migrations/fixtures. */
async function seedGlobalProfile(bankId: string, bankName: string, config: unknown = VALID_CONFIG) {
  return db.bankProfile.create({
    data: {
      bankId,
      companyId: null,
      bankName,
      fingerprints: JSON.stringify([`${bankId}-fingerprint`]),
      config: JSON.stringify(config),
      isActive: true,
      requiresReview: false,
    },
  });
}

/** Field-level snapshot used to prove a row was not touched at all. */
async function globalProfileSnapshot() {
  const rows = await db.bankProfile.findMany({
    where: { companyId: null },
    orderBy: { bankId: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    bankId: row.bankId,
    companyId: row.companyId,
    bankName: row.bankName,
    fingerprints: row.fingerprints,
    config: row.config,
    isActive: row.isActive,
    requiresReview: row.requiresReview,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

beforeEach(() => {
  invalidateAllProfilesCache();
});

afterAll(async () => {
  invalidateAllProfilesCache();
  await db.bankProfile.deleteMany({ where: { bankId: { startsWith: BANK_PREFIX } } });
  // Learned profiles use the deterministic "auto-<hash>" bankId, so clean by company too.
  if (COMPANY_IDS.length > 0) {
    await db.bankProfile.deleteMany({ where: { companyId: { in: COMPANY_IDS } } });
    await db.company.deleteMany({ where: { id: { in: COMPANY_IDS } } });
  }
});

describe('S1 — BankProfile tenant scoping', () => {
  it('(a) a PDF learned for tenant A creates a company-A-scoped profile only', async () => {
    const companyA = await makeCompany('A');
    const before = await globalProfileSnapshot();

    // The crafted statement text drives the same learning path a PDF upload uses.
    const learned = await createProfileFromPdf(
      {
        fullText: 'Crafted Statement Bank\nTotal control of the layout',
        pageWidth: 612,
        firstPageSample: 'Crafted Statement Bank',
        blocksWithCoordinates: [
          { text: '01/02/26 Crafted row 10.00', x: 40, y: 700, width: 200, page: 1 },
        ],
      },
      companyA,
    );

    const companyRows = await db.bankProfile.findMany({ where: { companyId: companyA } });
    expect(companyRows).toHaveLength(1);
    expect(companyRows[0]!.bankId).toBe(learned.bankId);
    // The write is scoped to the importing company, never to the global seed space
    expect(companyRows[0]!.companyId).toBe(companyA);

    const globalRowsForBank = await db.bankProfile.findMany({
      where: { bankId: learned.bankId, companyId: null },
    });
    expect(globalRowsForBank).toHaveLength(0);

    // Tenant B never receives tenant A's learned row
    const companyB = await makeCompany('B');
    const tenantBProfiles = await getAllActiveProfiles(companyB);
    expect(tenantBProfiles.some((p) => p.bankId === learned.bankId)).toBe(false);

    // ... and the global seeds are byte-identical before/after the crafted upload
    expect(await globalProfileSnapshot()).toEqual(before);
  }, 60000);

  it('(a) tenant B keeps parsing with the unchanged global seed after tenant A learns', async () => {
    const companyA = await makeCompany('parseA');
    const companyB = await makeCompany('parseB');
    const before = await globalProfileSnapshot();

    await createProfileFromPdf(
      {
        fullText: 'Another crafted statement\nNothing in common with the shipped seeds',
        pageWidth: 612,
        firstPageSample: 'Another crafted statement',
        blocksWithCoordinates: [
          { text: '01/03/26 Another crafted row 25.00', x: 40, y: 680, width: 200, page: 1 },
        ],
      },
      companyA,
    );

    const pdf = readFileSync(
      join(__dirname, '..', 'fixtures', 'boa-statements', 'eStmt_2025-03-31.pdf'),
    );
    const parsed = await parsePDF(pdf, { companyId: companyB });

    expect(parsed.transactions.length).toBeGreaterThan(0);
    expect(await globalProfileSnapshot()).toEqual(before);
  }, 60000);

  it('(b) the company-scoped profile wins over the global fallback for the same bankId', async () => {
    const bankId = `${BANK_PREFIX}-shared`;
    const companyA = await makeCompany('precedence');
    await seedGlobalProfile(bankId, 'Global Seed Definition');
    await db.bankProfile.create({
      data: {
        bankId,
        companyId: companyA,
        bankName: 'Company A Definition',
        fingerprints: JSON.stringify([`${bankId}-fingerprint`]),
        config: JSON.stringify(VALID_CONFIG),
        isActive: true,
        requiresReview: false,
      },
    });

    const resolved = await getBankProfile(bankId, companyA);
    expect(resolved!.bankName).toBe('Company A Definition');
    expect(resolved!.companyId).toBe(companyA);

    const active = await getAllActiveProfiles(companyA);
    const forBank = active.filter((p) => p.bankId === bankId);
    expect(forBank).toHaveLength(1);
    expect(forBank[0]!.bankName).toBe('Company A Definition');
  });

  it('(c) a company without a profile falls back to the global read-only seed', async () => {
    const bankId = `${BANK_PREFIX}-fallback`;
    const companyC = await makeCompany('fallback');
    const globalRow = await seedGlobalProfile(bankId, 'Global Read-Only Seed');

    const resolved = await getBankProfile(bankId, companyC);

    expect(resolved!.id).toBe(globalRow.id);
    expect(resolved!.bankName).toBe('Global Read-Only Seed');
    expect(resolved!.companyId).toBeNull();

    const sameForTenant = await getBankProfile(bankId);
    expect(sameForTenant!.id).toBe(globalRow.id);
  });

  it('(d) no write path ever targets companyId NULL', async () => {
    const bankId = `${BANK_PREFIX}-guard`;
    const companyD = await makeCompany('guard');
    await seedGlobalProfile(bankId, 'Guarded Global Seed');
    const before = await globalProfileSnapshot();

    await expect(
      upsertBankProfile(bankId, 'Attempted Overwrite', ['fp'], VALID_CONFIG),
    ).rejects.toBeInstanceOf(BankProfileTenantScopeError);
    await expect(
      upsertBankProfile(bankId, 'Attempted Overwrite', ['fp'], VALID_CONFIG, false, null),
    ).rejects.toThrow(/requires a companyId/);
    await expect(updateRequiresReviewStatus(bankId, false)).rejects.toBeInstanceOf(
      BankProfileTenantScopeError,
    );

    // Nothing was written: the global row and the tenant's (empty) scope are unchanged
    expect(await globalProfileSnapshot()).toEqual(before);
    expect(await db.bankProfile.findMany({ where: { companyId: companyD } })).toHaveLength(0);

    // A scoped write lands on the company row, leaving the global seed untouched
    await upsertBankProfile(bankId, 'Tenant Copy', ['fp'], VALID_CONFIG, false, companyD);
    expect(await globalProfileSnapshot()).toEqual(before);
    const scoped = await db.bankProfile.findMany({ where: { bankId, companyId: companyD } });
    expect(scoped).toHaveLength(1);
  });

  it('(e) a corrupt profile row is skipped with a logged warning and parsing falls back', async () => {
    const bankId = `${BANK_PREFIX}-corrupt`;
    const companyE = await makeCompany('corrupt');
    const globalRow = await seedGlobalProfile(bankId, 'Healthy Global Seed');
    const corrupt = await db.bankProfile.create({
      data: {
        bankId,
        companyId: companyE,
        bankName: 'Corrupt Tenant Row',
        fingerprints: JSON.stringify(['fp']),
        config: '{"this":"is not a bank profile config"}',
        isActive: true,
        requiresReview: false,
      },
    });
    const warn = vi.spyOn(logger, 'warn');

    try {
      const resolved = await getBankProfile(bankId, companyE);
      // Falls back to the healthy global seed instead of throwing for everyone
      expect(resolved!.id).toBe(globalRow.id);

      const active = await getAllActiveProfiles(companyE);
      expect(active.some((p) => p.id === corrupt.id)).toBe(false);
      expect(active.some((p) => p.id === globalRow.id)).toBe(true);

      expect(warn).toHaveBeenCalledWith(
        'Skipping unusable bank profile row',
        expect.objectContaining({ bankId, companyId: companyE, profileId: corrupt.id }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('(f) a write invalidates that company cache entry without disturbing another tenant', async () => {
    const bankId = `${BANK_PREFIX}-cache`;
    const companyA = await makeCompany('cacheA');
    const companyB = await makeCompany('cacheB');
    await seedGlobalProfile(bankId, 'Cache Global Seed');

    // Warm both tenants on the global seed
    expect((await getBankProfile(bankId, companyA))!.bankName).toBe('Cache Global Seed');
    expect((await getBankProfile(bankId, companyB))!.bankName).toBe('Cache Global Seed');

    const readSpy = vi.spyOn(db.bankProfile, 'findUnique');
    try {
      await upsertBankProfile(bankId, 'Tenant A Learned', ['fp'], VALID_CONFIG, false, companyA);

      // Company A must observe its own write inside the same process...
      expect((await getBankProfile(bankId, companyA))!.bankName).toBe('Tenant A Learned');

      // ...while company B keeps its cached resolution (no extra read, same value)
      const callsBefore = readSpy.mock.calls.length;
      const forB = await getBankProfile(bankId, companyB);
      expect(forB!.bankName).toBe('Cache Global Seed');
      expect(readSpy.mock.calls.length).toBe(callsBefore);
    } finally {
      readSpy.mockRestore();
    }
  });
});
