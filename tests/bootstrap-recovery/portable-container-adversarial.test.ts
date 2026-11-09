/**
 * T26 / S12, S20 — adversarial container probes at the authorization boundary.
 *
 * The container contract itself (key schedule, normalizations, legacy versions)
 * is pinned by `portable-key-binding.test.ts` and `portable-credential.test.ts`.
 * What was never pinned is the OPERATOR-VISIBLE answer the workflow gives for
 * each class of corrupted file, and specifically that the answer is a single
 * sanitized failure with no oracle telling the caller WHICH secret input (or
 * which byte) was wrong.
 *
 * Cases:
 *  1. every cryptographic tamper (salt, IV, tag, ciphertext, sealed binding) and
 *     every wrong knowledge factor answer with the SAME 400
 *     `RECOVERY_PASSWORD_MISMATCH` and the SAME message;
 *  2. structural tampering (pinned KDF parameters, cipher name, extra/missing
 *     header keys) is refused BEFORE a password attempt is charged, and an
 *     unknown/legacy version keeps its own code;
 *  3. an internal (non-portable) snapshot is refused at challenge and at
 *     completion, and the portable reader cannot open it either: the
 *     `internal=1` path stays closed to portable readers.
 *
 * Synthetic data only: fictional company/owner, an in-memory challenge store and
 * no database, file, mail transport or server.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryRecoveryChallengeStore,
  completePortableRecovery, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { openPortableContainer } from '@/lib/backup-portable';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OPEN_CONTEXT, OWNER, SOURCE_PASSWORD,
  localText, makeSnapshot, portableFile,
} from './helpers';

const NOW = new Date('2026-04-02T10:00:00.000Z');
const OTHER_EMAIL = 'otra-persona@example.test';
const OTHER_COMPANY = 'Otra Compania S.A.';

interface Harness {
  deps: PortableRecoveryDeps;
  store: ReturnType<typeof createMemoryRecoveryChallengeStore>;
  mail: Array<{ to: string; token: string }>;
  restores: number;
  text: string;
}

function harness(): Harness {
  const store = createMemoryRecoveryChallengeStore();
  const lock = createMemoryRecoveryLockStore();
  const mail: Harness['mail'] = [];
  const state = { restores: 0 };
  const deps: PortableRecoveryDeps = {
    now: () => NOW,
    challenges: store,
    lock,
    mail: { send: async (message) => { mail.push(message as unknown as Harness['mail'][number]); } },
    installationState: async () => ({ companies: 0, audits: 0 }),
    restore: async () => {
      state.restores += 1;
      return { status: 'committed', operationId: 'op-adversarial', sessionUserId: OWNER.id, counts: {} };
    },
  };
  return {
    deps, store, mail, text: portableFile(makeSnapshot()),
    get restores() { return state.restores; },
  } as Harness;
}

function request(h: Harness, overrides: Partial<{
  fileText: string; password: string; companyLegalName: string; ownerEmail: string;
}> = {}) {
  return requestPortableRecoveryChallenge(h.deps, {
    fileText: overrides.fileText ?? h.text,
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
  });
}

function complete(h: Harness, token: string, overrides: Partial<{ fileText: string }> = {}) {
  return completePortableRecovery(h.deps, {
    fileText: overrides.fileText ?? h.text,
    password: SOURCE_PASSWORD,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
    token,
  });
}

/** Byte-level mutation that keeps a canonical base64 string canonical. */
function mutateBase64(value: string, fromEnd = 0): string {
  const bytes = Buffer.from(value, 'base64');
  const index = bytes.length - 1 - fromEnd;
  bytes[index] = bytes[index] ^ 0x01;
  const encoded = bytes.toString('base64');
  if (encoded === value) throw new Error('mutation did not change the value');
  return encoded;
}

function header(): Record<string, any> {
  return JSON.parse(portableFile(makeSnapshot())) as Record<string, any>;
}

function variant(edit: (base: Record<string, any>) => Record<string, any>): string {
  return JSON.stringify(edit(header()));
}

describe('every unopenable file answers with one sanitized failure (S12/S20)', () => {
  const cryptoVariants: Array<[string, () => string]> = [
    ['kdf.salt', () => variant((base) => ({ ...base, kdf: { ...base.kdf, salt: mutateBase64(base.kdf.salt) } }))],
    ['binding.iv', () => variant((base) => ({ ...base, binding: { ...base.binding, iv: mutateBase64(base.binding.iv) } }))],
    ['binding.tag', () => variant((base) => ({ ...base, binding: { ...base.binding, tag: mutateBase64(base.binding.tag) } }))],
    ['binding.ciphertext', () => variant((base) => ({
      ...base, binding: { ...base.binding, ciphertext: mutateBase64(base.binding.ciphertext) },
    }))],
    ['cipher.salt', () => variant((base) => ({ ...base, cipher: { ...base.cipher, salt: mutateBase64(base.cipher.salt) } }))],
    ['cipher.iv', () => variant((base) => ({ ...base, cipher: { ...base.cipher, iv: mutateBase64(base.cipher.iv) } }))],
    ['cipher.tag', () => variant((base) => ({ ...base, cipher: { ...base.cipher, tag: mutateBase64(base.cipher.tag) } }))],
    ['ciphertext', () => variant((base) => ({ ...base, ciphertext: mutateBase64(base.ciphertext) }))],
    ['ciphertext.truncated', () => variant((base) => ({
      ...base, ciphertext: Buffer.from(base.ciphertext, 'base64').subarray(0, -1).toString('base64'),
    }))],
  ];

  it('answers tampering and a wrong knowledge factor with the same code and message', async () => {
    const answers: Array<{ label: string; code: string; message: string }> = [];
    const inputs = [
      ['wrong password', { password: 'definitely-not-the-password' }],
      ['wrong owner email', { ownerEmail: OTHER_EMAIL }],
      ['wrong company name', { companyLegalName: OTHER_COMPANY }],
    ] as const;
    for (const [label, overrides] of inputs) {
      const h = harness();
      const result = await request(h, overrides);
      expect(result, label).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
      answers.push({ label, code: 'RECOVERY_PASSWORD_MISMATCH', message: (result as { message: string }).message });
      expect(h.mail, label).toHaveLength(0);
      expect(h.store.describe().challenges, label).toHaveLength(0);
    }
    for (const [label, build] of cryptoVariants) {
      const h = harness();
      const result = await request(h, { fileText: build() });
      expect(result, label).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
      answers.push({ label, code: (result as { code: string }).code, message: (result as { message: string }).message });
      // A tampered file is charged against the same bounded budget and produces
      // no mail and no draft.
      expect(h.store.describe().attemptsUsed, label).toBe(1);
      expect(h.mail, label).toHaveLength(0);
      expect(h.store.describe().challenges, label).toHaveLength(0);
    }

    // The no-oracle invariant: one distinct (code, message) pair for the whole
    // family, so the caller cannot learn WHICH input or byte was wrong.
    expect(new Set(answers.map((answer) => `${answer.code}\u0000${answer.message}`)).size).toBe(1);
    const message = answers[0].message;
    expect(message).toMatch(/cannot be identified/i);
    for (const secret of [SOURCE_PASSWORD, OWNER.email, OWNER.id, COMPANY_ID, OTHER_EMAIL, OTHER_COMPANY]) {
      expect(message).not.toContain(secret);
    }
  });

  it('refuses pinned KDF/cipher parameters before charging a password attempt', async () => {
    const structural: Array<[string, () => string]> = [
      ['kdf.N', () => variant((base) => ({ ...base, kdf: { ...base.kdf, N: 1024 } }))],
      ['kdf.p', () => variant((base) => ({ ...base, kdf: { ...base.kdf, p: 8 } }))],
      ['kdf.algorithm', () => variant((base) => ({ ...base, kdf: { ...base.kdf, algorithm: 'pbkdf2-sha256' } }))],
      ['cipher.name', () => variant((base) => ({ ...base, cipher: { ...base.cipher, name: 'aes-256-cbc' } }))],
      ['extra header key', () => variant((base) => ({ ...base, ownerEmail: OWNER.email }))],
      ['missing binding', () => variant((base) => {
        const { binding: _removed, ...rest } = base;
        return rest;
      })],
    ];
    for (const [label, build] of structural) {
      const h = harness();
      const result = await request(h, { fileText: build() });
      // Structural refusal: the file never reached the key derivation, so no
      // password attempt is charged and nothing is left behind.
      expect(result, label).toMatchObject({ status: 400, code: 'RECOVERY_FILE_UNSUPPORTED' });
      expect(h.store.describe().attemptsUsed, label).toBe(0);
      expect(h.mail, label).toHaveLength(0);
      expect(h.store.describe().challenges, label).toHaveLength(0);
    }
  });

  it('keeps the dedicated code and guidance for an older portable version', async () => {
    for (const version of [1, 2, 99]) {
      const h = harness();
      const result = await request(h, {
        fileText: variant((base) => ({ ...base, version })),
      });
      expect(result).toMatchObject({ status: 400, code: 'RECOVERY_FORMAT_UNSUPPORTED' });
      expect((result as { message: string }).message).toMatch(/export a new encrypted backup/i);
      expect(h.store.describe().attemptsUsed).toBe(0);
      expect(h.mail).toHaveLength(0);
    }
  });

  it('refuses a password outside the product bounds without charging an attempt', async () => {
    for (const password of ['short', 'x'.repeat(257)]) {
      const h = harness();
      const result = await request(h, { password });
      expect(result).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_REQUIRED' });
      expect(h.store.describe().attemptsUsed).toBe(0);
      expect(h.mail).toHaveLength(0);
    }
  });
});

describe('the internal snapshot path stays closed to portable readers (S11/S12)', () => {
  it('cannot open the internal sealed snapshot with the portable reader', () => {
    const snapshot = makeSnapshot();
    const internal = localText(snapshot);
    // The internal format is a different contract (local seal, no password KDF,
    // no sealed identity binding): the portable reader must reject it.
    expect(() => openPortableContainer(internal, SOURCE_PASSWORD, OPEN_CONTEXT))
      .toThrow(/RECOVERY_CREDENTIAL_INVALID/);
    // The internal transport shape (base64 of the stored text) as well.
    expect(() => openPortableContainer(Buffer.from(internal, 'utf8').toString('base64'), SOURCE_PASSWORD, OPEN_CONTEXT))
      .toThrow(/RECOVERY_CREDENTIAL_INVALID/);
  });

  it('refuses the internal snapshot at challenge and at completion without consuming the token', async () => {
    const h = harness();
    const internal = localText(makeSnapshot());
    const atChallenge = await request(h, { fileText: internal });
    expect(atChallenge).toMatchObject({ status: 400, code: 'RECOVERY_FILE_UNSUPPORTED' });
    expect(h.mail).toHaveLength(0);

    // A valid portable challenge, then the internal text substituted: refused
    // structurally, token untouched, installation untouched.
    expect((await request(h)).status).toBe('challenge_sent');
    const token = h.mail.at(-1)!.token;
    const atCompletion = await complete(h, token, { fileText: internal });
    expect(atCompletion).toMatchObject({ status: 400, code: 'RECOVERY_FILE_UNSUPPORTED' });
    expect(h.store.describe().challenges[0].usedAt).toBeNull();
    expect(h.restores).toBe(0);
  });
});
