import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createIdentityService } from '@/lib/identity/runtime';
import { AuthService } from '@/lib/services/auth.service';
import { registerSchema, type RegisterInput } from '@/lib/validations/auth';
import { getClientIp } from '@/lib/security/client-ip';
import { createSession } from '@/lib/sessions';

export const POST = apiHandler(
  async (request: NextRequest) => {
    const raw = await request.clone().json().catch(() => null);
    const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const code = typeof raw?.code === 'string' ? raw.code.trim() : '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Datos de verificación inválidos.', code: 'INVALID_VERIFICATION_INPUT' }, { status: 400 });
    }

    // Old incomplete accounts need only a fresh owner code; new accounts need the full form.
    let input: RegisterInput | undefined;
    if (raw.password !== undefined || raw.firstName !== undefined || raw.companyName !== undefined) {
      const parsed = registerSchema.safeParse({ ...raw, email,
        firstName: typeof raw.firstName === 'string' ? raw.firstName.trim() : raw.firstName,
        lastName: typeof raw.lastName === 'string' ? raw.lastName.trim() : raw.lastName,
        companyName: typeof raw.companyName === 'string' ? raw.companyName.trim() : raw.companyName,
      });
      if (!parsed.success || (raw.confirmPassword !== undefined && raw.confirmPassword !== raw.password)) {
        return NextResponse.json({ error: 'Revisa los datos del registro.', code: 'INVALID_REGISTRATION_INPUT' }, { status: 400 });
      }
      input = parsed.data;
    }

    const identity = createIdentityService();
    if (!identity) {
      return NextResponse.json({ error: 'Verificación de email no disponible.', code: 'VERIFICATION_UNAVAILABLE' }, { status: 503 });
    }
    const completed: { user?: Awaited<ReturnType<typeof AuthService.finalizeRegistration>> } = {};
    const accepted = await identity.verifyCode(email, code, getClientIp(request) ?? undefined, async tx => {
      completed.user = await AuthService.finalizeRegistration(tx, email, new Date(), input);
    });
    if (!accepted) {
      return NextResponse.json({ error: 'El código de verificación no es válido o ha expirado.', code: 'INVALID_CODE' }, { status: 400 });
    }
    const user = completed.user;
    if (!user) throw new Error('Registration transaction did not finalize');
    const token = await createSession(user.id);
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.platformRole, avatar: user.avatar },
      companies: user.companyMemberships.map(membership => membership.company),
    });
    const isProd = process.env.NODE_ENV === 'production';
    response.cookies.set(isProd ? '__Host-session' : 'session', token, {
      httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60,
    });
    return response;
  },
  { allowAnonymous: true, requireMembership: false },
);
