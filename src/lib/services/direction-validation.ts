// src/lib/services/direction-validation.ts
// Centralized validation for GL account direction profiles
// Ensures that the debit and credit GL accounts match their direction profile constraints

import { db } from '@/lib/db';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '@/lib/logger';

/**
 * Load direction profiles from rules/direction-profiles.json
 * Format: { "asset": { "normalBalance": "debit", "deviationThreshold": 0.85, "allowOpposite": true }, ... }
 */
function loadDirectionProfiles(): Record<
  string,
  { normalBalance: 'credit' | 'debit'; deviationThreshold: number; allowOpposite?: boolean }
> {
  const defaultProfiles: Record<
    string,
    { normalBalance: 'credit' | 'debit'; deviationThreshold: number; allowOpposite?: boolean }
  > = {
    asset: { normalBalance: 'debit', deviationThreshold: 0.85, allowOpposite: true },
    liability: { normalBalance: 'credit', deviationThreshold: 0.9, allowOpposite: true },
    equity: { normalBalance: 'credit', deviationThreshold: 0.9, allowOpposite: true },
    revenue: { normalBalance: 'credit', deviationThreshold: 0.9 },
    expense: { normalBalance: 'debit', deviationThreshold: 0.85 },
  };

  try {
    const profilePath = join(process.cwd(), 'rules/direction-profiles.json');
    if (existsSync(profilePath)) {
      const loaded = JSON.parse(readFileSync(profilePath, 'utf-8'));
      return loaded;
    }
  } catch (err) {
    logger.warn('DIRECTION_PROFILES_LOAD_FAILED', { error: String(err) });
  }

  return defaultProfiles;
}

/**
 * Validate that the provided GL account IDs match the expected direction profile.
 *
 * @param companyId - The company to which the accounts belong.
 * @param debitGlAccountId - GL account ID used for debit transactions (optional).
 * @param creditGlAccountId - GL account ID used for credit transactions (optional).
 * @returns true if validation passes, otherwise throws an error with detailed message.
 */
export async function validateDirectionProfile(
  companyId: string,
  debitGlAccountId?: string | null,
  creditGlAccountId?: string | null,
): Promise<boolean> {
  const profiles = loadDirectionProfiles();

  // Helper to fetch an account and validate against its direction profile
  const validateAccount = async (
    accountId: string,
    direction: 'debit' | 'credit',
  ): Promise<void> => {
    const acct = await db.glAccount.findFirst({
      where: { id: accountId, companyId },
    });
    if (!acct) {
      throw new Error(`GL account not found or does not belong to this company`);
    }

    const accountClass = acct.accountType;
    if (!accountClass) {
      throw new Error(`GL account "${acct.name}" (${acct.code}) has no accountType defined`);
    }

    const profile = profiles[accountClass];
    if (!profile) {
      // No profile exists for this class; allow it
      return;
    }

    // Check if the account's normal balance matches the direction
    const expectedBalance = profile.normalBalance;
    const isOpposite =
      direction === 'debit' ? expectedBalance === 'credit' : expectedBalance === 'debit';

    if (isOpposite && !profile.allowOpposite) {
      const directionLabel = direction === 'debit' ? 'débito' : 'crédito';
      const balanceLabel = expectedBalance === 'debit' ? 'débito' : 'crédito';
      throw new Error(
        `GL account "${acct.name}" (${acct.code}) has a normal balance of ${balanceLabel} ` +
          `but is being used for ${directionLabel} transactions. ` +
          `Please select an account with matching direction profile or enable opposite transactions.`,
      );
    }
  };

  // Validate debit account if provided
  if (debitGlAccountId) {
    await validateAccount(debitGlAccountId, 'debit');
  }

  // Validate credit account if provided
  if (creditGlAccountId) {
    await validateAccount(creditGlAccountId, 'credit');
  }

  return true;
}
