if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import type { IdentityMailTransport } from './identity/mail';
import { SmtpAdapter } from './identity/mail';
import { RelayTransport } from './identity/relay-transport';

/**
 * Recovery token delivery. One contract only: a token is reported as SENT when
 * the configured transport resolved the send. No transport, a missing
 * configuration or a provider failure is an explicit non-success, because a
 * recovery flow that silently "sent" an undelivered token would authorize
 * nobody and must never look successful.
 */
export type RecoveryMailOutcome = 'sent' | 'mail_unavailable' | 'delivery_failed';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function deliverRecoveryToken(
  transport: IdentityMailTransport | null | undefined,
  input: { to: string; token: string },
): Promise<RecoveryMailOutcome> {
  if (!transport) return 'mail_unavailable';
  const to = typeof input?.to === 'string' ? input.to.trim().toLowerCase() : '';
  const token = typeof input?.token === 'string' ? input.token : '';
  // A malformed recipient/token is refused before it reaches a provider.
  if (!EMAIL_PATTERN.test(to) || to.length > 254 || !TOKEN_PATTERN.test(token)) return 'delivery_failed';
  try {
    await transport.send({ type: 'recovery', to, token });
    return 'sent';
  } catch {
    // Never surface a provider payload: it may contain the token or credentials.
    return 'delivery_failed';
  }
}

/**
 * Reuse the installation's existing mail configuration. `null` means the
 * operator has not configured any channel, which the workflow treats as a hard
 * block instead of the historical silent no-op.
 */
export function createRecoveryMailTransport(
  env: Readonly<Record<string, string | undefined>>,
): IdentityMailTransport | null {
  if (env.ACCOUNTEXPRESS_MAIL_MODE === 'relay') return new RelayTransport();
  const host = env.SMTP_HOST?.trim() ?? '';
  const user = env.SMTP_USER?.trim() ?? '';
  const pass = env.SMTP_PASS ?? '';
  const from = (env.SMTP_FROM || env.SMTP_USER || '').trim();
  if (!host || !user || !pass || !from) return null;
  return new SmtpAdapter({
    host,
    port: Number.parseInt(env.SMTP_PORT || '587', 10),
    secure: (env.SMTP_SECURE || 'false') === 'true',
    user,
    pass,
    from,
    fromName: env.SMTP_FROM_NAME || 'Sistema1',
  });
}
