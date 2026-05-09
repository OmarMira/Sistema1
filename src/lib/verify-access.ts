import { db } from '@/lib/db';

interface VerifyResult {
  ok: boolean;
  error?: string;
  membership?: {
    userId: string;
    companyId: string;
    role: string;
  };
}

/**
 * Verify that a user has an active membership in the specified company.
 * Returns the membership if valid, or an error description.
 * Use this at the top of every write API before any database mutation.
 */
export async function verifyCompanyAccess(
  userId: string,
  companyId: string,
): Promise<VerifyResult> {
  if (!userId) {
    return { ok: false, error: 'Unauthorized' };
  }

  if (!companyId) {
    return { ok: false, error: 'companyId is required' };
  }

  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });

  if (!membership) {
    return { ok: false, error: 'Forbidden' };
  }

  return {
    ok: true,
    membership: {
      userId: membership.userId,
      companyId: membership.companyId,
      role: membership.role,
    },
  };
}

/**
 * Helper to build a 403 response from verifyCompanyAccess.
 */
export function forbiddenResponse(error: string) {
  return { status: 403 as const, json: { error: string } };
}
