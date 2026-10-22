import type { Budget, IdentityConfig, IdentityRepository, VerificationFinalizer } from './contracts';
import { codeDigest, createCode, createRecoveryToken, opaqueSubject, tokenDigest } from './crypto';
import { IdentityMailer } from './mail';

export const NEUTRAL_RESPONSE = 'Si existe una cuenta registrada, recibirás instrucciones';

// Verification may finalize an account only through the repository-owned transaction.
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
  async requestRegistrationCode(value: string, resend = false, ip?: string): Promise<{ issued: boolean; delivered: boolean }> {
    if (!this.config.enabled || !this.repository) return { issued: false, delivered: false };
    const email = this.email(value);
    if (!email) return { issued: false, delivered: false };
    const { key } = this.config;
    const code = createCode();
    const now = this.clock();
    const issued = await this.repository.issueVerification(email, now, resend,
      (id, generation) => codeDigest(key, id, generation, code), this.budgets(key, 'issue-verification', email, ip));
    if (issued) {
      const delivered = await this.mail.verification(email, code);
      await this.repository.recordDelivery(opaqueSubject(key, 'delivery', email), delivered, now);
      return { issued, delivered };
    }
    return { issued: false, delivered: false };
  }
  async beginRegistration(email: string, ip?: string): Promise<string> {
    await this.requestRegistrationCode(email, false, ip);
    return NEUTRAL_RESPONSE;
  }
  async resendVerification(email: string, ip?: string): Promise<string> {
    await this.requestRegistrationCode(email, true, ip);
    return NEUTRAL_RESPONSE;
  }
  async verifyCode(value: string, code: string, ip?: string, finalize?: VerificationFinalizer): Promise<boolean> {
    if (!this.config.enabled || !this.repository) return false;
    const email = this.email(value);
    if (!email) return false;
    const { key } = this.config;
    // Malformed input still consumes the same persistent attempt budget.
    const candidate = /^\d{6}$/.test(code) ? code : '<invalid>';
    const digest = (id: string, generation: number) => codeDigest(key, id, generation, candidate);
    const budgets = this.budgets(key, 'verify', email, ip);
    return finalize
      ? this.repository.attemptCode(email, this.clock(), digest, budgets, finalize)
      : this.repository.attemptCode(email, this.clock(), digest, budgets);
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
