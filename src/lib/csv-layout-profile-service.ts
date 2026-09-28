import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { CsvLayoutMapping } from '@/lib/csv-parser';

/**
 * CSV reusable format knowledge: tenant-scoped lookup and persistence of the
 * structural mapping discovered on a successful import.
 *
 * Strictly minimal on purpose: every read and every write is scoped by
 * companyId + fingerprint (the @@unique constraint), so one company's layout
 * knowledge can never be read or overwritten by another.
 *
 * Knowledge is best-effort: both operations degrade gracefully on any store
 * failure (table not yet migrated during a deployment skew, store
 * unavailable, ...) instead of failing the import that triggered them. A
 * lookup failure is treated as a cache miss (the caller rediscovers), and a
 * persistence failure simply leaves the knowledge unwritten.
 */

export async function findByCompanyAndFingerprint(
  companyId: string,
  fingerprint: string,
) {
  try {
    return await db.csvLayoutProfile.findUnique({
      where: { companyId_fingerprint: { companyId, fingerprint } },
    });
  } catch (error) {
    logger.warn('CSV layout profile lookup failed; treating as cache miss', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Upsert the discovered mapping for this tenant + layout identity.
 * Replaces any previous (stale) mapping for the same pair. Failure is
 * non-fatal: the import keeps its result and only the reusable knowledge
 * is skipped.
 */
export async function persistSuccessfulMapping(
  companyId: string,
  fingerprint: string,
  mapping: CsvLayoutMapping,
) {
  const data = {
    delimiter: mapping.delimiter,
    dateColumnIndex: mapping.dateColumnIndex,
    descriptionColumnIndex: mapping.descriptionColumnIndex,
    amountColumnIndex: mapping.amountColumnIndex,
    referenceColumnIndex: mapping.referenceColumnIndex,
  };

  try {
    return await db.csvLayoutProfile.upsert({
      where: { companyId_fingerprint: { companyId, fingerprint } },
      create: { companyId, fingerprint, ...data },
      update: data,
    });
  } catch (error) {
    logger.warn(
      'CSV layout profile persistence failed; import continues without reusable knowledge',
      {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}
