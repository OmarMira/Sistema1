import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';

/**
 * DB-backed session store — stores SHA-256 hashes only.
 */

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function createSession(userId: string): Promise<string> {
  const rawToken = crypto.randomUUID();
  const hashedToken = hashToken(rawToken);

  // Sessions expire after 7 days
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.session.create({
    data: {
      token: hashedToken,
      userId,
      expiresAt,
    },
  });

  return rawToken;
}

export async function getSessionUserId(request: NextRequest): Promise<string | null> {
  return getSessionUserIdFromToken(getSessionToken(request));
}

/**
 * Resuelve el userId desde un token de sesión crudo (cookie o Bearer).
 * Reutilizada por getSessionUserId (API) y por el gate SSR.
 */
export async function getSessionUserIdFromToken(rawToken: string | null): Promise<string | null> {
  if (!rawToken) return null;

  const hashedToken = hashToken(rawToken);

  const session = await db.session.findUnique({
    where: { token: hashedToken },
    include: { user: { select: { isActive: true } } },
  });

  if (!session) return null;

  // Check if expired
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { token: hashedToken } }).catch(() => {});
    return null;
  }

  // F-6: deactivated users lose access to all existing sessions (401 upstream)
  if (!session.user?.isActive) return null;

  return session.userId;
}

export async function destroySession(rawToken: string): Promise<void> {
  const hashedToken = hashToken(rawToken);
  await db.session.delete({ where: { token: hashedToken } }).catch(() => {});
}

type SessionStore = {
  session: {
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
};

export async function deleteAllUserSessions(
  userId: string,
  client: SessionStore = db,
): Promise<number> {
  const result = await client.session.deleteMany({ where: { userId } });
  return result.count;
}

export function getSessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-session' : 'session';
}

export function getSessionToken(request: NextRequest): string | null {
  return (
    request.cookies.get(getSessionCookieName())?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '') ??
    null
  );
}
