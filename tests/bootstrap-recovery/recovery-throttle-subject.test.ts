/**
 * F2 / S3 continued — the password-attempt budget must be bound to the FILE'S
 * WRAPPING-KEY INPUTS, not to the exact bytes of the uploaded JSON.
 *
 * The budget was keyed on `portableFileDigest` (SHA-256 of the raw upload). The
 * container is JSON, so an unauthenticated attacker could keep the same file and
 * still obtain a fresh budget per attempt by changing bytes that never alter the
 * password-guessing target: trailing whitespace, a different key order, or the
 * data-envelope salt (whose mismatch is already indistinguishable from a wrong
 * password). Five guesses per variant is an unbounded guessing oracle against a
 * low-entropy owner password.
 *
 * The throttle subject is therefore the canonical digest of the WRAPPING-KEY
 * inputs only — format, version and the pinned KDF parameters plus `kdf.salt`.
 * Those are exactly the values that decide which password a guess is tested
 * against; every other header field can be mutated freely by an attacker, so
 * including it would hand back a new budget for the same target.
 *
 * Pinned here:
 *  (a) whitespace, key order and a mutated `cipher.salt` share ONE subject,
 *      while a genuinely different backup (fresh `kdf.salt`) does not;
 *  (b) exhausting the budget on one variant makes the next variant answer
 *      RECOVERY_TOO_MANY_ATTEMPTS — total charged attempts stay at the policy
 *      limit;
 *  (c) the byte-identical file still limits exactly as before (no regression);
 *  (d) the structural pre-budget rejection is unchanged and charges nothing;
 *  (e) every variant still answers the same unified RECOVERY_PASSWORD_MISMATCH,
 *      so the response never says which field varied.
 *
 * Synthetic file/identity only: no database and no real backup.
 */
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RECOVERY_POLICY, createMemoryRecoveryChallengeStore, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { portableFileDigest, portableThrottleDigest } from '@/lib/backup-portable';
import {
  COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD, makeSnapshot, portableFile,
} from './helpers';

const NOW = new Date('2026-05-01T08:00:00.000Z');
const WRONG_PASSWORD = 'not-the-source-owner-password';

interface Harness {
  deps: PortableRecoveryDeps;
  store: ReturnType<typeof createMemoryRecoveryChallengeStore>;
  mail: Array<{ to: string; token: string }>;
}

function harness(): Harness {
  const store = createMemoryRecoveryChallengeStore();
  const mail: Harness['mail'] = [];
  const deps: PortableRecoveryDeps = {
    now: () => NOW,
    challenges: store,
    lock: createMemoryRecoveryLockStore(),
    mail: { send: async (message) => { mail.push(message as unknown as Harness['mail'][number]); } },
    installationState: async () => ({ companies: 0, audits: 0 }),
    restore: async () => {
      throw new Error('the throttle tests never reach the restore');
    },
  };
  return { deps, store, mail };
}

function request(h: Harness, fileText: string, password = WRONG_PASSWORD) {
  return requestPortableRecoveryChallenge(h.deps, {
    fileText,
    password,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
  });
}

/** Same container, reformatted: trailing whitespace. */
function whitespaceVariant(text: string): string {
  return `${text}\n\t `;
}

/** Same container, different JSON key order. */
function reorderedVariant(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(parsed).reverse()) reversed[key] = parsed[key];
  return JSON.stringify(reversed);
}

/**
 * Bump ONE byte of the data-envelope salt. The wrapping KDF still runs with the
 * same password guess, and the payload AEAD fails exactly like a wrong password,
 * so this variant must NOT buy a new budget.
 */
function mutatedCipherSaltVariant(text: string): string {
  const parsed = JSON.parse(text) as { cipher: { salt: string } };
  const salt = Buffer.from(parsed.cipher.salt, 'base64');
  salt[0] ^= 0xff;
  return JSON.stringify({ ...parsed, cipher: { ...parsed.cipher, salt: salt.toString('base64') } });
}

/** A genuinely different backup: fresh random wrapping salt ⇒ different target. */
function differentBackupVariant(text: string): string {
  const parsed = JSON.parse(text) as { kdf: Record<string, unknown> };
  return JSON.stringify({
    ...parsed,
    kdf: { ...parsed.kdf, salt: crypto.randomBytes(32).toString('base64') },
  });
}

let baseText: string;

beforeEach(() => {
  baseText = portableFile(makeSnapshot());
});

describe('the throttle subject is canonical over the wrapping-key inputs (F2)', () => {
  it('ignores bytes that never change the password-guessing target', () => {
    const base = portableThrottleDigest(baseText);
    expect(portableThrottleDigest(whitespaceVariant(baseText))).toBe(base);
    expect(portableThrottleDigest(reorderedVariant(baseText))).toBe(base);
    expect(portableThrottleDigest(mutatedCipherSaltVariant(baseText))).toBe(base);

    // …while the RAW digest (used to bind a token to the exact uploaded bytes)
    // legitimately differs for those variants.
    expect(portableFileDigest(whitespaceVariant(baseText))).not.toBe(portableFileDigest(baseText));
    expect(portableFileDigest(reorderedVariant(baseText))).not.toBe(portableFileDigest(baseText));
    expect(portableFileDigest(mutatedCipherSaltVariant(baseText))).not.toBe(portableFileDigest(baseText));
  });

  it('separates genuinely different backups (fresh wrapping salt)', () => {
    expect(portableThrottleDigest(differentBackupVariant(baseText)))
      .not.toBe(portableThrottleDigest(baseText));
  });

  it('refuses a structurally invalid container before charging anything', () => {
    // Unchanged behaviour: a bad envelope is rejected pre-budget, so it can never
    // be used to burn another operator's budget either.
    const tampered = JSON.stringify({ ...JSON.parse(baseText), extra: 'field' });
    expect(() => portableThrottleDigest(tampered)).toThrow(/RECOVERY_CREDENTIAL_INVALID/);
    // The same shape change through the workflow charges nothing.
    return (async () => {
      const h = harness();
      expect(await request(h, tampered)).toMatchObject({ status: 400 });
      expect(h.store.describe().attemptsUsed).toBe(0);
    })();
  });
});

describe('the attempt budget is shared across variants of the same file (F2)', () => {
  it('cannot be reset by whitespace, key order or the data-envelope salt', async () => {
    const h = harness();
    const variants = [
      baseText,
      whitespaceVariant(baseText),
      reorderedVariant(baseText),
      mutatedCipherSaltVariant(baseText),
    ];

    let blocked: unknown = null;
    let charged = 0;
    for (let index = 0; index < RECOVERY_POLICY.attempts * variants.length; index += 1) {
      const result = await request(h, variants[index % variants.length]);
      if ((result as { status: number | string }).status === 429) {
        blocked = result;
        break;
      }
      expect(result).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
      charged += 1;
    }

    expect(blocked).toMatchObject({ status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS' });
    // Exactly ONE budget, however the file was reformatted on the way in.
    expect(charged).toBe(RECOVERY_POLICY.attempts);
    expect(h.store.describe().attemptsUsed).toBe(RECOVERY_POLICY.attempts);
    expect(h.mail).toHaveLength(0);
  });

  it('still limits the byte-identical file exactly as before', async () => {
    const h = harness();
    for (let attempt = 0; attempt < RECOVERY_POLICY.attempts; attempt += 1) {
      expect(await request(h, baseText)).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    }
    expect(await request(h, baseText)).toMatchObject({ status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS' });
    expect(h.store.describe().attemptsUsed).toBe(RECOVERY_POLICY.attempts);
    // The correct password is refused while the budget is exhausted.
    expect(await request(h, baseText, SOURCE_PASSWORD)).toMatchObject({
      status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS',
    });
    expect(h.mail).toHaveLength(0);
  });

  it('keeps one sanitized failure for every variant (no which-field oracle)', async () => {
    const h = harness();
    const responses = [
      await request(h, whitespaceVariant(baseText)),
      await request(h, reorderedVariant(baseText)),
      await request(h, mutatedCipherSaltVariant(baseText)),
    ];
    const messages = new Set(responses.map((response) => (response as { message?: string }).message));
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toMatch(/salt|kdf|cipher|whitespace|order/i);
    expect(responses.every((response) => (response as { code?: string }).code === 'RECOVERY_PASSWORD_MISMATCH'))
      .toBe(true);
  });
});
