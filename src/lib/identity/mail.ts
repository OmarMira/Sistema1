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
