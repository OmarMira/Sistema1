import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

/**
 * Extracts the session token from a NextRequest, looks up the user,
 * and returns the userId if a valid session exists, or null otherwise.
 */
export async function getSessionUserId(
  request: NextRequest,
): Promise<string | null> {
  const token =
    request.cookies.get('session_token')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '');

  if (!token) return null;

  const session = await db.session.findUnique({ where: { token } });
  if (!session) return null;

  // Check if session has expired (optional, based on your DB schema)
  if (session.expiresAt && session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } });
    return null;
  }

  return session.userId;
}
