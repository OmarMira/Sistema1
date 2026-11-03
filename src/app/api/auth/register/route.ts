import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { validateRequest } from '@/lib/validate-request';
import { registerSchema } from '@/lib/validations/auth';
import { createIdentityService } from '@/lib/identity/runtime';
import { authRateLimiter } from '@/lib/rate-limiter';
import { getClientIp } from '@/lib/security/client-ip';
import { grantFirstAdminBootstrap, setupTokenMatches } from '@/lib/services/auth.service';

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

    // S10: when the operator configured a bootstrap token, the registration that
    // may later become the first super_admin must present it. Same comparison as
    // /api/bootstrap/restore (SHA-256 + timingSafeEqual); the token is accepted
    // from the x-bootstrap-token header or the `setupToken` body field and is
    // never echoed or logged.
    const bootstrapTokenRequired = Boolean(process.env.BOOTSTRAP_SETUP_TOKEN);
    const presentedSetupToken = request.headers.get('x-bootstrap-token')
      ?? (typeof raw?.setupToken === 'string' ? raw.setupToken : '');
    if (bootstrapTokenRequired) {
      if (!presentedSetupToken) {
        authRateLimiter.increment(ip, email);
        return NextResponse.json({ error: 'Se requiere un token de inicialización.' }, { status: 403 });
      }
      if (!setupTokenMatches(presentedSetupToken)) {
        authRateLimiter.increment(ip, email);
        return NextResponse.json({ error: 'Token de inicialización inválido.' }, { status: 403 });
      }
    }

    const body = await validateRequest(request, registerSchema);
    if (body instanceof NextResponse) return body;

    // The challenge request and the confirmation are separate requests: record
    // the operator authorization as a single-use grant bound to this email.
    if (bootstrapTokenRequired) {
      await grantFirstAdminBootstrap(body.email);
    }

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
