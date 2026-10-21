import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/sessions';
import { apiHandler } from '@/lib/api-handler';
import { validateRequest } from '@/lib/validate-request';
import { registerSchema } from '@/lib/validations/auth';
import { AuthService } from '@/lib/services/auth.service';
import { createIdentityService } from '@/lib/identity/runtime';
import { authRateLimiter } from '@/lib/rate-limiter';
import { getClientIp } from '@/lib/security/client-ip';

// ─── POST /api/auth/register ──────────────────────────────────────────
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

      // Option A: issue verification code to the registered email.
      // The identity service is only active when SMTP + identity key are
      // configured; if unavailable, the account is still created PENDING
      // (emailVerifiedAt stays null) and can be verified manually.
      if (identity) {
        try {
          await identity.beginRegistration(email ?? '', ip ?? undefined);
        } catch {
          // Delivery failure (e.g., SMTP_PASS absent) must not block
          // account creation per Option A design.
        }
      }

      const result = await AuthService.register(body);

      authRateLimiter.reset(ip, email);

      const response = NextResponse.json({
        requiresVerification: true,
        email: result.user.email,
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          role: result.user.platformRole,
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

      return response;
    } catch (err) {
      authRateLimiter.increment(ip, email);
      throw err;
    }
  },
  { allowAnonymous: true, requireMembership: false },
);
