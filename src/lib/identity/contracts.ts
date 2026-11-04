import type { Prisma } from '@prisma/client';

export type VerificationFinalizer = (tx: Prisma.TransactionClient) => Promise<void>;
export type IdentityConfig = { enabled: false } | { enabled: true; key: Buffer };
export type DigestForCode = (subjectId: string, generation: number) => string;
export type Budget = { subject: string; maximum: number };

// Repository operations own their transactions and never use the application singleton.
export interface IdentityRepository {
  issueVerification(email: string, now: Date, resend: boolean, digest: DigestForCode, budgets: Budget[]): Promise<boolean>;
  attemptCode(email: string, now: Date, digest: DigestForCode, budgets: Budget[], finalize?: VerificationFinalizer): Promise<boolean>;
  issueRecovery(email: string, digest: string, now: Date, budgets: Budget[]): Promise<boolean>;
  consumeRecovery(digest: string, now: Date): Promise<string | null>;
  // Atomic: token consumption + password replacement + session revocation in one transaction.
  completeRecovery(digest: string, passwordHash: string, now: Date): Promise<string | null>;
  recordDelivery(subject: string, success: boolean, now: Date): Promise<void>;
}

export const POLICY = Object.freeze({
  codeMs: 10 * 60_000,
  recoveryMs: 20 * 60_000,
  pendingMs: 24 * 60 * 60_000,
  attempts: 5,
  resends: 3,
  windowMs: 10 * 60_000,
});
