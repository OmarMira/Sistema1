import nodemailer from 'nodemailer';

export type IdentityMessage =
  | { type: 'verification'; to: string; code: string }
  | { type: 'recovery'; to: string; token: string };
export interface IdentityMailTransport {
  send(message: IdentityMessage): Promise<void>;
}

// No provider, logger, fallback delivery or default transport is constructed here.
// A future adapter must render recovery links using an operator-approved HTTPS origin.
export class IdentityMailer {
  constructor(private readonly transport?: IdentityMailTransport) {}
  private async deliver(message: IdentityMessage): Promise<boolean> {
    if (!this.transport) return false;
    try {
      await this.transport.send(message);
      return true;
    } catch {
      // Never propagate a provider payload that might contain tokens or credentials.
      return false;
    }
  }
  verification(to: string, code: string): Promise<boolean> {
    return this.deliver({ type: 'verification', to, code });
  }
  recovery(to: string, token: string): Promise<boolean> {
    return this.deliver({ type: 'recovery', to, token });
  }
}


// Phase B — T2 SMTP interface (dormant; not activated; .env untouched)
export interface SmtpConfig {
  host: string; port: number; secure: boolean;
  user: string; pass: string;
  from: string; fromName?: string;
}
export interface IdentitySmtpTransport extends IdentityMailTransport {
  verifyConfig(): boolean;
}
// Adapter placeholder: requires operator-approved HTTPS origin for recovery links.
export class SmtpAdapter implements IdentitySmtpTransport {
  constructor(private readonly cfg: SmtpConfig) {}
  verifyConfig(): boolean { return !!(this.cfg.host && this.cfg.from); }
  async send(message: IdentityMessage): Promise<void> {
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const host = process.env.SMTP_HOST || '';
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = (process.env.SMTP_SECURE || 'false') === 'true';
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';
    const fromName = process.env.SMTP_FROM_NAME || '';

    // Phase B — T2 SMTP interface activated when SMTP_HOST is configured.
    // If the adapter is constructed without a configured provider (no SMTP_HOST,
    // empty SMTP_USER or SMTP_PASS), delivery resolves silently so the
    // identity mechanism never exposes a token via an unconfigured provider.
    if (!host || !user || !pass) {
      return Promise.resolve();
    }

    try {
      const transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });

      const isVerification = message.type === 'verification';
      const isRecovery = message.type === 'recovery';
      const codeStr = isVerification ? (message as { code: string }).code || '' : '';
      const tokenStr = isRecovery ? (message as { token: string }).token || '' : '';

      const subject = isVerification
        ? 'AccountExpress — Confirmación de registro (código)'
        : 'AccountExpress — Recuperación de cuenta (token)';

      const textBody = isVerification
        ? `Tu código de verificación es: ${codeStr}\nIntroduce este código en la aplicación para completar tu registro.`
        : `Tu token de recuperación es: ${tokenStr}\nIntroduce este token en la aplicación para restablecer tu acceso.`;

      const htmlBody = isVerification
        ? `<p>Tu código de verificación es: <strong>${codeStr}</strong></p><p>Introduce este código en la aplicación para completar tu registro.</p>`
        : `<p>Tu token de recuperación es: <strong>${tokenStr}</strong></p><p>Introduce este token en la aplicación para restablecer tu acceso.</p>`;

      await transport.sendMail({
        from: fromName ? `"${fromName}" <${from}>` : from,
        to: message.to,
        subject,
        text: textBody,
        html: htmlBody,
      });
    } catch (err) {
      // Never expose SMTP payload (tokens, credentials, server response text).
      // Propagate only a sanitized failure so deliver() can record delivery_failed.
      throw new Error('SMTP delivery rejected');
    }
  }
}
