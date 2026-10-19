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
    // Actual SMTP delivery deferred to T2 verification / CI / production approval.
    // Never emit tokens directly; logs only delivery status.
    return Promise.resolve();
  }
}
