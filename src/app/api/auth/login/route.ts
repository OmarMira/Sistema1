import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/sessions';
import { apiHandler } from '@/lib/api-handler';
import { validateRequest } from '@/lib/validate-request';
import { loginSchema } from '@/lib/validations/auth';
import { AuthService } from '@/lib/services/auth.service';
import { authRateLimiter } from '@/lib/rate-limiter';

// ─── POST /api/auth/login ─────────────────────────────────────────────
export const POST = apiHandler(
  async (request: NextRequest) => {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || '127.0.0.1';
    const body = await request.clone().json();
    const email = typeof body?.email === 'string' ? body.email : undefined;

    const rateCheck = authRateLimiter.check(ip, email);
    if (!rateCheck.success) {
      return NextResponse.json(
        {
          error: 'Demasiados intentos de inicio de sesión. Intente nuevamente más tarde.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
        { status: 429 },
      );
    }

    const validated = await validateRequest(request, loginSchema);
    if (validated instanceof NextResponse) return validated;

    try {
      const result = await AuthService.login(validated);

      authRateLimiter.reset(ip, email);

      const token = await createSession(result.user.id);

      const response = NextResponse.json({
        user: result.user,
        companies: result.companies,
      });

      const isProd = process.env.NODE_ENV === 'production';
      response.cookies.set(isProd ? '__Host-session' : 'session', token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      });

      return response;
    } catch (err) {
      authRateLimiter.increment(ip, email);
      throw err;
    }
  },
  { allowAnonymous: true, requireMembership: false },
);
