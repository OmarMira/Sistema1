import type { Budget, IdentityConfig, IdentityRepository } from './contracts';
import { codeDigest, createCode, createRecoveryToken, opaqueSubject, tokenDigest } from './crypto';
import { IdentityMailer } from './mail';

export const NEUTRAL_RESPONSE = 'Si existe una cuenta registrada, recibirás instrucciones';

// Dormant infrastructure: no route imports or instantiates this class in Phase A.
// Verification confirms only a pending identity challenge, never a User/session/role.
export class IdentityService {
  constructor(
    private readonly config: IdentityConfig = { enabled: false },
    private readonly repository?: IdentityRepository,
    private readonly mail = new IdentityMailer(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private email(value: string): string | null {
    const email = value.trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }
  private budgets(key: Buffer, purpose: string, email: string, ip?: string): Budget[] {
    const result = [{ subject: opaqueSubject(key, `${purpose}:email`, email), maximum: 5 }];
    // The caller must supply an IP only after its trusted-proxy policy is applied.
    if (ip && ip.length <= 128) result.push({ subject: opaqueSubject(key, `${purpose}:ip`, ip), maximum: 20 });
    return result;
  }
  private async verification(value: string, resend: boolean, ip?: string): Promise<string> {
    if (!this.config.enabled || !this.repository) return NEUTRAL_RESPONSE;
    const email = this.email(value);
    if (!email) return NEUTRAL_RESPONSE;
    const { key } = this.config;
    const code = createCode();
    const now = this.clock();
    const issued = await this.repository.issueVerification(email, now, resend,
      (id, generation) => codeDigest(key, id, generation, code), this.budgets(key, 'issue-verification', email, ip));
    if (issued) {
      const delivered = await this.mail.verification(email, code);
      await this.repository.recordDelivery(opaqueSubject(key, 'delivery', email), delivered, now);
    }
    return NEUTRAL_RESPONSE;
  }
  beginRegistration(email: string, ip?: string): Promise<string> {
    return this.verification(email, false, ip);
  }
  resendVerification(email: string, ip?: string): Promise<string> {
    return this.verification(email, true, ip);
  }
  async verifyCode(value: string, code: string, ip?: string): Promise<boolean> {
    if (!this.config.enabled || !this.repository) return false;
    const email = this.email(value);
    if (!email) return false;
    const { key } = this.config;
    // Malformed input still consumes the same persistent attempt budget.
    const candidate = /^\d{6}$/.test(code) ? code : '<invalid>';
    return this.repository.attemptCode(email, this.clock(),
      (id, generation) => codeDigest(key, id, generation, candidate), this.budgets(key, 'verify', email, ip));
  }
  async requestRecovery(value: string, ip?: string): Promise<string> {
    if (!this.config.enabled || !this.repository) return NEUTRAL_RESPONSE;
    const email = this.email(value);
    if (!email) return NEUTRAL_RESPONSE;
    const { key } = this.config;
    const token = createRecoveryToken();
    const now = this.clock();
    if (await this.repository.issueRecovery(email, tokenDigest(token), now, this.budgets(key, 'issue-recovery', email, ip))) {
      const delivered = await this.mail.recovery(email, token);
      await this.repository.recordDelivery(opaqueSubject(key, 'delivery', email), delivered, now);
    }
    return NEUTRAL_RESPONSE;
  }
  async consumeRecovery(token: string): Promise<string | null> {
    if (!this.config.enabled || !this.repository || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.repository.consumeRecovery(tokenDigest(token), this.clock());
  }
  // T5 — atomic recovery: token consumption + password replacement + session
  // revocation confirmed in one repository transaction. Returns the user id.
  async completeRecovery(token: string, passwordHash: string): Promise<string | null> {
    if (!this.config.enabled || !this.repository || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.repository.completeRecovery(tokenDigest(token), passwordHash, this.clock());
  }
}
