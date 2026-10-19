import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Phase B — T4: protected, one-time bootstrap of the first super_admin.
//
// Contract (S4 of odd/tasks/identidad-recuperacion.md):
// - The role is never granted by registration, by userCount == 0, or by the first
//   verified email.
// - The operator generates a bootstrap token, stores only its digest in the
//   restricted "IdentityBootstrap" table, and presents the raw token once.
// - The mechanism is single use: consumption sets consumedAt and the row can
//   never become reusable.
// - The target user must already exist, be active and be verified
//   (emailVerifiedAt != null); pending registrations can neither block nor
//   consume the role.

export type BootstrapRow = {
  id: string;
  tokenDigest: string;
  consumedAt: Date | null;
  createdAt: Date;
};

export function bootstrapTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createBootstrapToken(): string {
  return randomBytes(32).toString('hex');
}

export function digestMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export type BootstrapUser = {
  id: string;
  emailVerifiedAt: Date | null;
  isActive: boolean;
  legacyUser: boolean;
  platformRole: string;
};

export type BootstrapOutcome =
  | { status: 'established'; userId: string }
  | { status: 'rejected'; reason: 'token_invalid' | 'token_consumed' | 'user_not_verified' | 'user_inactive' | 'already_super_admin' };

// The caller supplies the transaction boundary: the role update and the token
// consumption must be confirmed together, or neither persists.
export async function establishFirstSuperAdmin(
  rows: BootstrapRow[],
  token: string,
  user: BootstrapUser,
  updateRole: (tx: any, userId: string) => Promise<void>,
  consume: (tx: any, rowId: string, now: Date) => Promise<void>,
  tx: any,
  now: Date = new Date(),
): Promise<BootstrapOutcome> {
  if (user.platformRole === 'super_admin') return { status: 'rejected', reason: 'already_super_admin' };
  if (!user.isActive) return { status: 'rejected', reason: 'user_inactive' };
  if (user.emailVerifiedAt === null && !user.legacyUser) return { status: 'rejected', reason: 'user_not_verified' };

  const candidate = bootstrapTokenDigest(token);
  const row = rows.find(r => digestMatches(r.tokenDigest, candidate));
  if (!row) return { status: 'rejected', reason: 'token_invalid' };
  if (row.consumedAt) return { status: 'rejected', reason: 'token_consumed' };

  await updateRole(tx, user.id);
  await consume(tx, row.id, now);
  return { status: 'established', userId: user.id };
}
