import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

const SESSION_COOKIE = 'session_token';

/**
 * SHA-256 hash a session token for secure DB storage.
 * The raw token is sent to the client; only the hash is persisted.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Extract the raw session token from a NextRequest (cookie or Authorization header).
 */
function extractToken(request: NextRequest): string | null {
  return (
    request.cookies.get(SESSION_COOKIE)?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '') ??
    null
  );
}

/**
 * Creates a new session for a user, storing only the SHA-256 hash.
 * Returns the raw token (to be sent to the client).
 */
export async function createSession(
  userId: string,
  expiresAt?: Date,
): Promise<{ rawToken: string; sessionId: string }> {
  // 32-byte random token
  const { randomBytes } = await import('crypto');
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  const session = await db.session.create({
    data: {
      userId,
      token: tokenHash,
      expiresAt: expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  });

  return { rawToken, sessionId: session.id };
}

/**
 * Look up a session by its raw token (hashes it first, then searches by hash).
 */
export async function getSessionUserId(
  request: NextRequest,
): Promise<string | null> {
  const rawToken = extractToken(request);
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  const session = await db.session.findUnique({ where: { token: tokenHash } });
  if (!session) return null;

  // Expired session cleanup
  if (session.expiresAt && session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } });
    return null;
  }

  return session.userId;
}
