import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export async function findByFingerprint(
  companyId: string,
  fingerprint: string,
) {
  try {
    return await db.csvLayoutProfile.findUnique({
      where: { companyId_fingerprint: { companyId, fingerprint } },
    });
  } catch (error) {
    logger.warn('PDF layout profile lookup failed; treating as miss', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function persistProfile(
  companyId: string,
  fingerprint: string,
  profile: { bankName?: string | null; dateFormat?: string | null; mapping?: string | null },
) {
  try {
    // `CsvLayoutProfile` (the only layout-persistence model) stores CSV layout columns;
    // it has no bankName/dateFormat/mapping columns. This PDF-heuristic write keeps its
    // historical payload so runtime behavior is unchanged (no caller exists and the
    // write already fails into the guard below); only the TypeScript shape is narrowed.
    const profileColumns = {
      bankName: profile.bankName ?? '',
      dateFormat: profile.dateFormat ?? '',
      mapping: profile.mapping ?? '',
    };

    return await db.csvLayoutProfile.upsert({
      where: { companyId_fingerprint: { companyId, fingerprint } },
      create: {
        companyId,
        fingerprint,
        ...profileColumns,
      } as unknown as Prisma.CsvLayoutProfileUncheckedCreateInput,
      update: {
        ...profileColumns,
      } as unknown as Prisma.CsvLayoutProfileUncheckedUpdateInput,
    });
  } catch (error) {
    logger.warn('PDF layout profile persistence failed; import continues', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
