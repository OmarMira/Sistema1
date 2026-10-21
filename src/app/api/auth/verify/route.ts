import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createIdentityService } from '@/lib/identity/runtime';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

// ─── POST /api/auth/verify ─────────────────────────────────────────────
// Confirms the 6-digit code emailed at registration (Option A). On success
// the account becomes verified (emailVerifiedAt) and, when it is the first
// account of the installation, the verified user becomes super_admin.
export const POST = apiHandler(
  async (request: NextRequest) => {
    const raw = await request.clone().json().catch(() => null);
    const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const code = typeof raw?.code === 'string' ? raw.code.trim() : '';

    if (!email || !EMAIL_RE.test(email) || !CODE_RE.test(code)) {
      return NextResponse.json(
        { error: 'Datos de verificación inválidos.', code: 'INVALID_VERIFICATION_INPUT' },
        { status: 400 },
      );
    }

    const identity = createIdentityService();
    if (!identity) {
      return NextResponse.json(
        { error: 'Verificación de email no disponible.', code: 'VERIFICATION_UNAVAILABLE' },
        { status: 503 },
      );
    }

    const accepted = await identity.verifyCode(email, code);
    if (!accepted) {
      return NextResponse.json(
        { error: 'El código de verificación no es válido o ha expirado.', code: 'INVALID_CODE' },
        { status: 400 },
      );
    }

    const user = await db.user.findUnique({
      where: { email },
      include: {
        companyMemberships: {
          include: {
            company: {
              select: {
                id: true,
                legalName: true,
                entityType: true,
                taxId: true,
                isOnboardingComplete: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'Cuenta no encontrada.', code: 'USER_NOT_FOUND' },
        { status: 404 },
      );
    }

    const totalUsers = await db.user.count();

    const updated = await db.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        // First verified account of the installation owns the platform role.
        ...(totalUsers === 1 ? { platformRole: 'super_admin' } : {}),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        platformRole: true,
        avatar: true,
      },
    });

    const companies = user.companyMemberships.map((m) => m.company);

    const token = await createSession(updated.id);

    const response = NextResponse.json({
      user: {
        id: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        role: updated.platformRole,
        avatar: updated.avatar,
      },
      companies,
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
  },
  { allowAnonymous: true, requireMembership: false },
);
