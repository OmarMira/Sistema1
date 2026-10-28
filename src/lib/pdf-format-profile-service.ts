import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export async function findByFingerprint(
  companyId: string,
  fingerprint: string,
) {
  try {
    return await db.pdfLayoutProfile.findUnique({
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
    return await db.pdfLayoutProfile.upsert({
      where: { companyId_fingerprint: { companyId, fingerprint } },
      create: {
        companyId,
        fingerprint,
        bankName: profile.bankName ?? '',
        dateFormat: profile.dateFormat ?? '',
        mapping: profile.mapping ?? '',
      },
      update: {
        bankName: profile.bankName ?? '',
        dateFormat: profile.dateFormat ?? '',
        mapping: profile.mapping ?? '',
      },
    });
  } catch (error) {
    logger.warn('PDF layout profile persistence failed; import continues', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
