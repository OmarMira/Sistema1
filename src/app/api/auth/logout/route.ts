import { NextRequest, NextResponse } from 'next/server';

// ─── POST /api/auth/logout ────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const token =
    request.cookies.get('session')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '');

  if (token) {
    const { sessionStore } = await import('@/app/api/auth/me/route');
    sessionStore.delete(token);
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
