import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { getClientIp } from '@/lib/security/client-ip';
import { authRateLimiter } from '@/lib/rate-limiter';
import { createRecoveryMailTransport, deliverRecoveryToken } from '@/lib/backup-recovery-mail';
import { auditPasswordReset, discardResetToken, issueResetToken } from '@/lib/password-reset';

/**
 * Neutral answer: it covers both cases without stating which one applies, so a
 * caller can never learn from the response whether an address is the owner.
 */
const NEUTRAL =
  'Si el correo pertenece al administrador de la instalación, recibirás un enlace para restablecer la contraseña. Si tu cuenta es de usuario, solicita a tu administrador que la restablezca.';

/**
 * An installation property, not an account property: saying it out loud cannot
 * identify anybody, and it keeps the owner from waiting for a mail that was
 * never sent.
 */
const NO_MAIL =
  'Esta instalación no tiene envío de correo configurado. Usá la recuperación de instalación para restablecer el acceso del administrador.';

export const POST = apiHandler(
  async (request: NextRequest) => {
    const raw = await request.clone().json().catch(() => null);
    const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email inválido.' }, { status: 400 });
    }

    const ip = getClientIp(request);
    const rateCheck = authRateLimiter.check(`${ip}:${email}`);
    if (!rateCheck.success) {
      return NextResponse.json(
        { error: 'Demasiados intentos. Intente nuevamente más tarde.' },
        { status: 429 },
      );
    }

    const transport = createRecoveryMailTransport(process.env);
    if (!transport) {
      await auditPasswordReset('PASSWORD_RESET_NO_MAIL', email, 'installation has no mail transport');
      return NextResponse.json({ message: NO_MAIL });
    }

    const issued = await issueResetToken(email);
    if (!issued) {
      await auditPasswordReset('PASSWORD_RESET_DISCARDED', email, 'not an eligible superadministrator');
      return NextResponse.json({ message: NEUTRAL });
    }

    const outcome = await deliverRecoveryToken(transport, { to: email, token: issued.token });
    if (outcome !== 'sent') {
      // Never leave a usable token behind for a mail that did not leave.
      await discardResetToken(issued.userId);
      await auditPasswordReset('PASSWORD_RESET_DELIVERY_FAILED', email, outcome);
      return NextResponse.json({ message: NO_MAIL });
    }

    await auditPasswordReset('PASSWORD_RESET_REQUESTED', email);
    return NextResponse.json({ message: NEUTRAL });
  },
  { allowAnonymous: true, requireMembership: false },
);
