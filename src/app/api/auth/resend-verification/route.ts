import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { getClientIp } from '@/lib/security/client-ip';
import { authRateLimiter } from '@/lib/rate-limiter';

export const POST = apiHandler(
  async (request: NextRequest) => {
    const raw = await request.clone().json().catch(() => null);
    const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email inválido.' }, { status: 400 });
    }
    const ip = getClientIp(request);
    const identity = (await import('@/lib/identity/runtime')).createIdentityService();
    if (!identity) {
      return NextResponse.json({ error: 'Servicio de verificación no disponible.' }, { status: 503 });
    }
    const rateCheck = authRateLimiter.check(`${ip}:${email}`);
    if (!rateCheck.success) {
      return NextResponse.json({ error: 'Demasiados intentos. Intente nuevamente más tarde.' }, { status: 429 });
    }
    await identity.resendVerification(email, ip ?? undefined);
    authRateLimiter.reset(ip, email);
    return NextResponse.json({ message: 'Si hay una cuenta pendiente con ese email, recibirás el código.' });
  },
  { allowAnonymous: true, requireMembership: false },
);
