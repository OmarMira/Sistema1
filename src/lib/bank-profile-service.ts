import { Prisma } from '@prisma/client';
import { logger } from '@/lib/logger';
import { db } from './db';
import {
  BankProfileConfig,
  BankProfileConfigSchema,
  BankProfileTyped,
} from './bank-profile-schema';
export type { BankProfileTyped };

// In-memory cache variables
const profileCache = new Map<string, BankProfileTyped>();
let allActiveProfilesCache: BankProfileTyped[] | null = null;

/**
 * Transforms a raw database BankProfile model into the strictly typed BankProfileTyped interface.
 */
function mapToTypedProfile(raw: Prisma.BankProfileGetPayload<{}>): BankProfileTyped {
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
 * Retrieve a specific bank profile by bankId, leveraging in-memory cache.
 */
export async function getBankProfile(bankId: string): Promise<BankProfileTyped | null> {
  if (profileCache.has(bankId)) {
    return profileCache.get(bankId) || null;
  }

  const rawProfile = await db.bankProfile.findUnique({
    where: { bankId },
  });

  if (!rawProfile) {
    return null;
  }

  const typedProfile = mapToTypedProfile(rawProfile);
  profileCache.set(bankId, typedProfile);
  return typedProfile;
}

/**
 * Retrieve all active bank profiles, leveraging in-memory cache.
 */
export async function getAllActiveProfiles(): Promise<BankProfileTyped[]> {
  if (allActiveProfilesCache !== null) {
    return allActiveProfilesCache;
  }

  const rawProfiles = await db.bankProfile.findMany({
    where: { isActive: true },
  });

  const typedProfiles = rawProfiles.map(mapToTypedProfile);
  allActiveProfilesCache = typedProfiles;
  return allActiveProfilesCache;
}

/**
 * Invalidates cache for a specific bank profile.
 */
export function invalidateProfileCache(bankId: string): void {
  profileCache.delete(bankId);
  allActiveProfilesCache = null;
  logger.info('In-memory cache invalidated for bank profile', { bankId });
}

/**
 * Invalidates the entire bank profile cache (global and individual).
 */
export function invalidateAllProfilesCache(): void {
  profileCache.clear();
  allActiveProfilesCache = null;
  logger.info('Global in-memory bank profile cache invalidated');
}

/**
 * Upsert a bank profile, validating configuration and invalidating relevant cache.
 */
export async function upsertBankProfile(
  bankId: string,
  bankName: string,
  fingerprints: string[],
  config: BankProfileConfig,
  requiresReview: boolean = false,
): Promise<BankProfileTyped> {
  // Enforce Zod validation before saving
  const validatedConfig = BankProfileConfigSchema.parse(config);

  const rawProfile = await db.bankProfile.upsert({
    where: { bankId },
    create: {
      bankId,
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

  // Invalidate cache reactively
  invalidateProfileCache(bankId);

  return typedProfile;
}

/**
 * Updates the requiresReview flag for a specific bank profile.
 */
export async function updateRequiresReviewStatus(
  bankId: string,
  requiresReview: boolean,
): Promise<void> {
  await db.bankProfile.update({
    where: { bankId },
    data: { requiresReview },
  });
  invalidateProfileCache(bankId);
}
