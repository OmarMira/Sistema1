import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionToken } from '@/lib/sessions';
import { acquireNormalOperation } from '@/lib/backup-maintenance.js';

// ─── POST /api/auth/logout ────────────────────────────────────────────
export async function POST(request: NextRequest) {
  let lease;
  try { lease = acquireNormalOperation(); }
  catch {
    return NextResponse.json({ error: 'Maintenance admission unavailable', code: 'BACKUP_MAINTENANCE' }, { status: 503 });
  }
  try { return await lease.run(() => logout(request)); }
  finally { lease.release(); }
}

async function logout(request: NextRequest) {
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
