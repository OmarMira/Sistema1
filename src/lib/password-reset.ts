import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { deleteAllUserSessions } from '@/lib/sessions';

/**
 * Superadministrator password recovery.
 *
 * Only the installation owner can recover itself: an ordinary user is told to
 * ask their administrator, which the admin user API already supports. Every
 * exported function here is deliberately silent about *why* a request was
 * discarded, so callers cannot accidentally leak the role of an account.
 */

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function resetTokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/**
 * Issue a token for an eligible account, or return null. Eligibility is exact:
 * active account, `super_admin` role, verified address. A previous outstanding
 * token is replaced, so at most one link is ever usable.
 */
export async function issueResetToken(
  email: string,
): Promise<{ token: string; userId: string } | null> {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, isActive: true, platformRole: true, emailVerifiedAt: true },
  });
  if (!user || !user.isActive || user.platformRole !== 'super_admin' || !user.emailVerifiedAt) {
    return null;
  }
  const token = newResetToken();
  await db.passwordResetToken.deleteMany({ where: { userId: user.id } });
  await db.passwordResetToken.create({
    data: {
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash: resetTokenDigest(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  });
  return { token, userId: user.id };
}

/** Non-consuming check used by the reset form to render its state. */
export async function findUsableResetToken(token: unknown): Promise<{ userId: string } | null> {
  if (!isWellFormedToken(token)) return null;
  const row = await db.passwordResetToken.findFirst({
    where: { tokenHash: resetTokenDigest(token), usedAt: null, expiresAt: { gt: new Date() } },
    select: { userId: true },
  });
  return row;
}

/** Drop a token that could not be delivered, so it never becomes usable. */
export async function discardResetToken(userId: string): Promise<void> {
  await db.passwordResetToken.deleteMany({ where: { userId } });
}

/**
 * Consume the token, set the new password and close every session of that user
 * in ONE transaction. Returns the user id, or null when the token is unknown,
 * expired or already used — the caller answers all three the same way.
 */
export async function consumeResetToken(
  token: unknown,
  passwordHash: string,
): Promise<string | null> {
  if (!isWellFormedToken(token)) return null;
  const tokenHash = resetTokenDigest(token);
  return db.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userId: true },
    });
    if (!row) return null;
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    // A stolen session must not survive the reset.
    await deleteAllUserSessions(row.userId, tx);
    return row.userId;
  });
}

/**
 * Audit every request, including the discarded ones. The token value is never
 * part of the record; only the outcome and the normalized address.
 */
export async function auditPasswordReset(
  action: string,
  email: string,
  detail?: string,
): Promise<void> {
  await createAuditLogWithRetry({
    userId: null,
    action,
    entity: 'User',
    entityId: null,
    details: JSON.stringify({ email, ...(detail ? { detail } : {}) }),
  });
}
