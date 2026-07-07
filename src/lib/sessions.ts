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
  const rawToken = getSessionToken(request);
  if (!rawToken) return null;

  const hashedToken = hashToken(rawToken);

  const session = await db.session.findUnique({
    where: { token: hashedToken },
  });

  if (!session) return null;

  // Check if expired
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { token: hashedToken } }).catch(() => {});
    return null;
  }

  return session.userId;
}

export async function destroySession(rawToken: string): Promise<void> {
  const hashedToken = hashToken(rawToken);
  await db.session.delete({ where: { token: hashedToken } }).catch(() => {});
}

export function getSessionToken(request: NextRequest): string | null {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieName = isProd ? '__Host-session' : 'session';
  return (
    request.cookies.get(cookieName)?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '') ??
    null
  );
}
