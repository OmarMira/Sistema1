import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import {
  openPortableContainer,
  normalizeCompanyName,
  normalizeOwnerEmail,
  type PortablePayload,
} from '@/lib/backup-portable';
import { createTestUser, createTestCompanyMember } from './factories';

/**
 * Fixture for the portable owner-verified backup contract.
 *
 * `POST /api/backup` only reads `password` and resolves the backup owner from
 * SERVER RECORDS: the owner must be an ACTIVE, VERIFIED `super_admin` who is a
 * member of the company, otherwise the route answers 409 RECOVERY_OWNER_MISSING
 * (or 409 RECOVERY_OWNER_AMBIGUOUS when two eligible owners share the earliest
 * creation time). Suites that only care about what a backup CONTAINS still need
 * that proven owner, so they seed one here instead of describing an owner the
 * server would never certify.
 */
export const DEFAULT_OWNER_PASSWORD = 'Clave.Owner.Respaldo.2026';

export interface SeededOwner {
  id: string;
  email: string;
  password: string;
}

export async function seedVerifiedOwner(
  companyId: string,
  options: { email?: string; password?: string } = {},
): Promise<SeededOwner> {
  const email = options.email ?? 'backup-owner@example.com';
  const password = options.password ?? DEFAULT_OWNER_PASSWORD;
  const owner = await createTestUser(email);
  await db.user.update({
    where: { id: owner.id },
    data: { passwordHash: await hashPassword(password), platformRole: 'super_admin' },
  });
  await createTestCompanyMember(owner.id, companyId);
  return { id: owner.id, email, password };
}

/** Identity the server binds a portable file to (same normalization it applies). */
export function ownerIdentity(owner: SeededOwner, companyLegalName: string) {
  return {
    ownerUserId: owner.id,
    ownerEmail: normalizeOwnerEmail(owner.email),
    companyLegalName: normalizeCompanyName(companyLegalName),
  };
}

/**
 * Open the encrypted portable file the route handed back and return the
 * snapshot it certifies. The response `data` is base64 of the AEAD container
 * (never the plaintext snapshot), so a suite that inspects backup CONTENT must
 * open it exactly the way a restoring installation does: with the owner
 * password and the identity the server resolved.
 */
export function openPortableSnapshot(
  base64Container: string,
  owner: SeededOwner,
  companyLegalName: string,
): PortablePayload {
  const text = Buffer.from(base64Container, 'base64').toString('utf-8');
  const opened = openPortableContainer(text, owner.password, ownerIdentity(owner, companyLegalName));
  return opened.payload;
}
