import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionToken } from '@/lib/sessions';

// ─── POST /api/auth/logout ────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const token = getSessionToken(request);
  if (token) {
    await destroySession(token);
  }

  const response = NextResponse.json({ success: true });

  const isProd = process.env.NODE_ENV === 'production';
  response.cookies.set(isProd ? '__Host-session' : 'session', '', {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
