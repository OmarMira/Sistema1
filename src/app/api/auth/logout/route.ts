import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionToken } from '@/lib/sessions';

// ─── POST /api/auth/logout ────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const token = getSessionToken(request);
  if (token) {
    destroySession(token);
  }

  const response = NextResponse.json({ success: true });

  response.cookies.set('session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
