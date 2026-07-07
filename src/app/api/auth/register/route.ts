import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/sessions';
import { apiHandler } from '@/lib/api-handler';
import { validateRequest } from '@/lib/validate-request';
import { registerSchema } from '@/lib/validations/auth';
import { AuthService } from '@/lib/services/auth.service';
import { authRateLimiter } from '@/lib/rate-limiter';

// ─── POST /api/auth/register ──────────────────────────────────────────
export const POST = apiHandler(
  async (request: NextRequest) => {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || '127.0.0.1';

    const raw = await request.clone().json();
    const email = typeof raw?.email === 'string' ? raw.email : undefined;

    const rateCheck = authRateLimiter.check(ip, email);
    if (!rateCheck.success) {
      return NextResponse.json(
        {
          error: 'Demasiados intentos de registro. Intente nuevamente más tarde.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
        { status: 429 },
      );
    }

    const body = await validateRequest(request, registerSchema);
    if (body instanceof NextResponse) return body;

    try {
      const result = await AuthService.register(body);

      authRateLimiter.reset(ip, email);

      const token = await createSession(result.user.id);

      const response = NextResponse.json({
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          role: result.user.role,
        },
        companies: [
          {
            id: result.company.id,
            legalName: result.company.legalName,
            entityType: result.company.entityType,
            taxId: result.company.taxId,
            isOnboardingComplete: result.company.isOnboardingComplete,
          },
        ],
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
