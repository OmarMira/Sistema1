import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { hashPassword } from '@/lib/auth';
import { passwordSchema } from '@/lib/validations/auth';
import { auditPasswordReset, consumeResetToken } from '@/lib/password-reset';

/** One generic refusal for unknown, expired and already used tokens. */
const GENERIC_FAILURE = 'El enlace no es válido o expiró. Solicitá uno nuevo.';

export const POST = apiHandler(
  async (request: NextRequest) => {
    const raw = await request.clone().json().catch(() => null);
    const token = typeof raw?.token === 'string' ? raw.token : '';
    const parsed = passwordSchema.safeParse(raw?.password);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'La contraseña debe tener al menos 8 caracteres' },
        { status: 400 },
      );
    }

    const passwordHash = await hashPassword(parsed.data);
    const userId = await consumeResetToken(token, passwordHash);
    if (!userId) {
      await auditPasswordReset('PASSWORD_RESET_REJECTED', 'unknown', 'invalid, expired or used token');
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
    }

    await auditPasswordReset('PASSWORD_RESET_COMPLETED', userId);
    // Never authenticate here: the password just changed, so the user signs in again.
    return NextResponse.json({ message: 'Contraseña actualizada. Iniciá sesión con tu nueva contraseña.' });
  },
  { allowAnonymous: true, requireMembership: false },
);
