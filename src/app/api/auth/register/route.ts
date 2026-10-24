import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { validateRequest } from '@/lib/validate-request';
import { registerSchema } from '@/lib/validations/auth';
import { createIdentityService } from '@/lib/identity/runtime';
import { authRateLimiter } from '@/lib/rate-limiter';
import { getClientIp } from '@/lib/security/client-ip';

export const POST = apiHandler(
  async (request: NextRequest) => {
    const ip = getClientIp(request);
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
      const identity = createIdentityService();
      let deliveryFailed = true;
      if (identity) {
        try {
          const delivery = await identity.requestRegistrationCode(body.email, false, ip ?? undefined);
          deliveryFailed = !delivery.delivered;
        } catch {
          // Delivery failure (SMTP unavailable) must not block verification flow.
        }
      }

      authRateLimiter.reset(ip, email);

      // Only a temporary email challenge exists. Never return a fictitious user/session.
      return NextResponse.json({
        requiresVerification: true,
        deliveryFailed,
        email: body.email.trim().toLowerCase(),
      });
    } catch (err) {
      authRateLimiter.increment(ip, email);
      throw err;
    }
  },
  { allowAnonymous: true, requireMembership: false },
);
