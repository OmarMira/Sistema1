import type { Prisma } from '@prisma/client';
import { tokenDigest } from './crypto';

type Tx = Pick<Prisma.TransactionClient, '$executeRaw'>;

// Same namespaces as issuance. Take these BEFORE User row locks so verification
// and recovery cannot recreate access state halfway through an account deletion.
export async function lockIdentityForDeletion(tx: Tx, email: string): Promise<void> {
  for (const namespace of ['registration', 'recovery-email']) {
    const key = `${namespace}:${tokenDigest(email)}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
  }
}

// Caller owns the transaction and identity/User locks. Keep opaque audit events
// and anti-abuse budgets: neither is a credential nor a pending registration.
export async function deleteIdentityAccess(tx: Tx, userId: string, email: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "IdentityChallenge"
    WHERE (purpose = 'RECOVERY' AND "subjectId" = ${userId})
       OR (purpose = 'VERIFICATION' AND "subjectId" IN (
         SELECT id::text FROM "IdentityPendingRegistration" WHERE email = ${email}
       ))
  `;
  await tx.$executeRaw`DELETE FROM "IdentityPendingRegistration" WHERE email = ${email}`;
  // Preserve company/accounting relationships (clean_identity_keep_minimal_audit).
  // Do NOT delete Company/CompanyMember; the user access/state is removed,
  // but accounting records and company ownership remain intact.
}
