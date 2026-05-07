import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Database-backed session store.
 * Sessions persist across server restarts.
 */

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  await db.session.create({
    data: { token, userId },
  });
  return token;
}

export async function getSessionUserId(request: NextRequest): Promise<string | null> {
  const token = getToken(request);
  if (!token) return null;

  try {
    const session = await db.session.findUnique({
      where: { token },
      select: { userId: true, createdAt: true },
    });
    if (!session) return null;

    // Session expired
    if (Date.now() - session.createdAt.getTime() > SESSION_DURATION_MS) {
      void db.session.delete({ where: { id: session.id } });
      return null;
    }

    return session.userId;
  } catch {
    return null;
  }
}

export async function destroySession(request: NextRequest): Promise<void> {
  const token = getToken(request);
  if (!token) return;
  try {
    await db.session.deleteMany({ where: { token } });
  } catch { /* ignore */ }
}

export function getToken(request: NextRequest): string | null {
  return (
    request.cookies.get('session')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '')
  );
}
