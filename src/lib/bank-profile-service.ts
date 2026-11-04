import type { BankProfile } from '@prisma/client';
import { logger } from '@/lib/logger';
import { db } from './db';
import {
  BankProfileConfig,
  BankProfileConfigSchema,
  BankProfileTyped,
} from './bank-profile-schema';
import boaStandardRaw from './bank-profiles/boa-standard.json';
export type { BankProfileTyped };

/**
 * S1 (Wave 5) — bank profiles are company-scoped.
 *
 * A profile row either belongs to one company (`companyId` NOT NULL) or is a
 * GLOBAL read-only seed (`companyId` NULL) that every tenant may read. The
 * resolution order everywhere is: company-scoped profile first, global seed
 * second, packaged structural definition last.
 *
 * Write paths (`upsertBankProfile`, `updateRequiresReviewStatus`) reject a
 * missing companyId, so no code path can ever create or modify a global row.
 * A tenant's uploaded PDF can therefore never pollute the profile another
 * tenant parses with.
 */
export type ScopedBankProfile = BankProfileTyped & { companyId: string | null };

/** Cache sentinel used when no tenant context is supplied. */
const GLOBAL_SCOPE = '\u0000global';

// In-memory caches. Every entry is keyed by companyId + bankId (or companyId
// alone for the "all active profiles" list) so one tenant's write can never
// invalidate or poison another tenant's entry.
const profileCache = new Map<string, ScopedBankProfile>();
const allActiveProfilesCache = new Map<string, ScopedBankProfile[]>();

// Registry-backed packaged structural profiles (non-persistent fallback)
// Only the shipped structural definitions in bank-profiles/ are referenced;
// fingerprint matching remains the parser's responsibility (S2, S1).
const packagedProfiles = new Map<string, ScopedBankProfile>();

function cacheKey(bankId: string, companyId?: string | null): string {
  return `${companyId ?? GLOBAL_SCOPE}::${bankId}`;
}

function registerPackagedProfile(raw: unknown): void {
  try {
    const bankId: string = (raw as any)?.bankId;
    if (!bankId || typeof bankId !== 'string') return;
    const bankName: string = (raw as any)?.bankName || bankId;
    const fingerprints: string[] = Array.isArray((raw as any)?.fingerprints) ? (raw as any)?.fingerprints : [];
    const config: BankProfileConfig = BankProfileConfigSchema.parse(raw);
    packagedProfiles.set(bankId, {
      id: `${bankId}-packaged`,
      bankId,
      companyId: null,
      bankName,
      fingerprints,
      isActive: true,
      requiresReview: false,
      config,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e) {
    logger.warn('Packaged profile registration failed', { error: String(e) });
  }
}

registerPackagedProfile(boaStandardRaw);

/** Raised when a write is attempted without a tenant scope. */
export class BankProfileTenantScopeError extends Error {
  readonly code = 'BANK_PROFILE_TENANT_SCOPE_REQUIRED';

  constructor(operation: string) {
    super(
      `BankProfile write rejected: ${operation} requires a companyId. ` +
        'Global profiles (companyId NULL) are read-only seeds and must never be written.',
    );
    this.name = 'BankProfileTenantScopeError';
  }
}

function requireWriteScope(
  operation: string,
  companyId?: string | null,
): string {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new BankProfileTenantScopeError(operation);
  }
  return companyId;
}

/**
 * Transforms a raw database BankProfile model into the strictly typed interface.
 * Throws on an invalid stored configuration — callers that must stay resilient
 * go through {@link tryMapToTypedProfile}.
 */
function mapToTypedProfile(raw: BankProfile): ScopedBankProfile {
  let parsedFingerprints: string[] = [];
  try {
    parsedFingerprints =
      typeof raw.fingerprints === 'string' ? JSON.parse(raw.fingerprints) : raw.fingerprints;
  } catch (e) {
    logger.error('Error parsing fingerprints for profile', { bankId: raw.bankId, error: e });
  }

  let parsedConfig: unknown = {};
  try {
    parsedConfig = typeof raw.config === 'string' ? JSON.parse(raw.config) : raw.config;
  } catch (e) {
    logger.error('Error parsing config for profile', { bankId: raw.bankId, error: e });
  }

  // Validate the configuration using Zod
  const validation = BankProfileConfigSchema.safeParse(parsedConfig);
  if (!validation.success) {
    logger.error('INVALID CONFIG for profile', { bankId: raw.bankId, zodError: validation.error });
    throw new Error(
      `Bank profile "${raw.bankId}" has invalid configuration in database. Please fix or deactivate it.`,
    );
  }

  return {
    id: raw.id,
    bankId: raw.bankId,
    companyId: raw.companyId ?? null,
    bankName: raw.bankName,
    fingerprints: parsedFingerprints,
    isActive: raw.isActive,
    requiresReview: raw.requiresReview,
    config: validation.data,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Per-profile failure isolation (S1.4): one corrupt row is logged and skipped
 * instead of throwing and breaking parsing for every tenant.
 */
function tryMapToTypedProfile(raw: BankProfile): ScopedBankProfile | null {
  try {
    return mapToTypedProfile(raw);
  } catch (e) {
    logger.warn('Skipping unusable bank profile row', {
      bankId: raw.bankId,
      companyId: raw.companyId ?? null,
      profileId: raw.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Company-scoped lookup: the tenant's own profile for this bankId, if any. */
async function findCompanyProfile(
  bankId: string,
  companyId: string,
): Promise<ScopedBankProfile | null> {
  const raw = await db.bankProfile.findUnique({
    where: { bankId_companyId: { bankId, companyId } },
  });
  if (!raw) return null;
  return tryMapToTypedProfile(raw);
}

/** Global seed lookup (companyId NULL). Reads only — never a write target. */
async function findGlobalProfile(bankId: string): Promise<ScopedBankProfile | null> {
  const rows = await db.bankProfile.findMany({
    where: { bankId, companyId: null },
    take: 1,
  });
  const raw = rows[0];
  if (!raw) return null;
  return tryMapToTypedProfile(raw);
}

/**
 * Retrieve a specific bank profile by bankId for a tenant.
 * Order: company-scoped profile → global read-only seed → packaged definition.
 */
export async function getBankProfile(
  bankId: string,
  companyId?: string | null,
): Promise<ScopedBankProfile | null> {
  const key = cacheKey(bankId, companyId);
  const cached = profileCache.get(key);
  if (cached) {
    return cached;
  }

  const companyProfile = companyId ? await findCompanyProfile(bankId, companyId) : null;
  if (companyProfile) {
    profileCache.set(key, companyProfile);
    return companyProfile;
  }

  const globalProfile = await findGlobalProfile(bankId);
  if (globalProfile) {
    profileCache.set(key, globalProfile);
    return globalProfile;
  }

  const packaged = packagedProfiles.get(bankId) ?? null;
  if (packaged) {
    profileCache.set(key, packaged);
    return packaged;
  }

  return null;
}

/**
 * Retrieve all active bank profiles visible to a tenant.
 *
 * Company-scoped rows take precedence over the global seed for the same bankId;
 * global seeds for bankIds the company has not overridden are included. Without
 * a companyId only global seeds are visible.
 */
export async function getAllActiveProfiles(
  companyId?: string | null,
): Promise<ScopedBankProfile[]> {
  const key = companyId ?? GLOBAL_SCOPE;
  const cached = allActiveProfilesCache.get(key);
  if (cached) {
    return cached;
  }

  const rawProfiles = await db.bankProfile.findMany({
    where: companyId
      ? { isActive: true, OR: [{ companyId }, { companyId: null }] }
      : { isActive: true, companyId: null },
  });

  const companyProfiles: ScopedBankProfile[] = [];
  const globalProfiles: ScopedBankProfile[] = [];
  for (const raw of rawProfiles) {
    // Corrupt rows are skipped (logged), never fatal for the whole tenant.
    const typed = tryMapToTypedProfile(raw);
    if (!typed) continue;
    if (typed.companyId === null) {
      globalProfiles.push(typed);
    } else {
      companyProfiles.push(typed);
    }
  }

  // Company-scoped profile wins over the global seed for the same bankId.
  const companyBankIds = new Set(companyProfiles.map((p) => p.bankId));
  const typedProfiles: ScopedBankProfile[] = [
    ...companyProfiles,
    ...globalProfiles.filter((p) => !companyBankIds.has(p.bankId)),
  ];

  const presentBankIds = new Set(typedProfiles.map((p) => p.bankId));
  const packagedBankIds = Array.from(packagedProfiles.keys()).filter(
    (id) => !presentBankIds.has(id),
  );
  if (packagedBankIds.length > 0) {
    const existingInDb = await db.bankProfile.findMany({
      where: { bankId: { in: packagedBankIds } },
      select: { bankId: true },
    });
    const suppressed = new Set(existingInDb.map((r) => r.bankId));
    for (const bankId of packagedBankIds) {
      if (!suppressed.has(bankId)) {
        const packaged = packagedProfiles.get(bankId)!;
        typedProfiles.push(packaged);
      }
    }
  }

  allActiveProfilesCache.set(key, typedProfiles);
  return typedProfiles;
}

/**
 * Invalidates the cache entry for one bank profile.
 *
 * With a companyId only that company's entries are dropped (company-scoped
 * resolution plus its all-active list) — other tenants keep their cache.
 * Without one, every cached resolution of that bankId is dropped.
 */
export function invalidateProfileCache(bankId: string, companyId?: string | null): void {
  if (companyId) {
    profileCache.delete(cacheKey(bankId, companyId));
    allActiveProfilesCache.delete(companyId);
    logger.info('In-memory cache invalidated for company bank profile', { bankId, companyId });
    return;
  }

  const suffix = `::${bankId}`;
  for (const key of Array.from(profileCache.keys())) {
    if (key.endsWith(suffix)) {
      profileCache.delete(key);
    }
  }
  allActiveProfilesCache.clear();
  logger.info('In-memory cache invalidated for bank profile', { bankId });
}

/**
 * Invalidates the entire bank profile cache (global and individual).
 */
export function invalidateAllProfilesCache(): void {
  profileCache.clear();
  allActiveProfilesCache.clear();
  logger.info('Global in-memory bank profile cache invalidated');
}

/**
 * Upsert a COMPANY-SCOPED bank profile, validating configuration and
 * invalidating that company's cache entry.
 *
 * The upsert keys on (bankId, companyId) and rejects a missing companyId: the
 * global seed rows (companyId NULL) are read-only and no write path may reach
 * them.
 */
export async function upsertBankProfile(
  bankId: string,
  bankName: string,
  fingerprints: string[],
  config: BankProfileConfig,
  requiresReview: boolean = false,
  companyId?: string | null,
): Promise<ScopedBankProfile> {
  const scopeCompanyId = requireWriteScope('upsertBankProfile', companyId);

  // Enforce Zod validation before saving
  const validatedConfig = BankProfileConfigSchema.parse(config);

  const rawProfile = await db.bankProfile.upsert({
    where: { bankId_companyId: { bankId, companyId: scopeCompanyId } },
    create: {
      bankId,
      companyId: scopeCompanyId,
      bankName,
      fingerprints: JSON.stringify(fingerprints),
      config: JSON.stringify(validatedConfig),
      isActive: true,
      requiresReview,
    },
    update: {
      bankName,
      fingerprints: JSON.stringify(fingerprints),
      config: JSON.stringify(validatedConfig),
      isActive: true,
      requiresReview,
    },
  });

  const typedProfile = mapToTypedProfile(rawProfile);

  // Invalidate cache reactively, for this company only
  invalidateProfileCache(bankId, scopeCompanyId);

  return typedProfile;
}

/**
 * Updates the requiresReview flag for a company-scoped bank profile.
 * Global seeds are read-only and are rejected as a write target.
 */
export async function updateRequiresReviewStatus(
  bankId: string,
  requiresReview: boolean,
  companyId?: string | null,
): Promise<void> {
  const scopeCompanyId = requireWriteScope('updateRequiresReviewStatus', companyId);

  await db.bankProfile.update({
    where: { bankId_companyId: { bankId, companyId: scopeCompanyId } },
    data: { requiresReview },
  });
  invalidateProfileCache(bankId, scopeCompanyId);
}
