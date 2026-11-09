import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  PORTABLE_FORMAT, PORTABLE_KDF, PORTABLE_LIMITS, companyNameMatches, createPortableContainer,
  normalizeCompanyName, openPortableContainer, portableFileDigest, readPortableHeader,
  resolvePortableSourceOwner,
} from '@/lib/backup-portable';
import { parseSnapshot, sealSnapshot } from '@/lib/backup-format';
import {
  requestPortableRecoveryChallenge,
  createMemoryRecoveryChallengeStore,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OPEN_CONTEXT, OWNER, OWNER_VERIFIED_AT, SOURCE_PASSWORD,
  makeSnapshot, portableFile, withEnv,
} from './helpers';

function container(password = SOURCE_PASSWORD) {
  const snapshot = makeSnapshot();
  snapshot.data.glAccounts.push({ id: 'gl-secret-account', companyId: COMPANY_ID, name: 'Banco Galicia' });
  snapshot.data.bankTransactions.push({ id: 'tx-secret-1', companyId: COMPANY_ID, description: 'Pago proveedor' });
  snapshot.manifest.recordCounts.glAccounts = 1;
  snapshot.manifest.recordCounts.bankTransactions = 1;
  return { snapshot, text: portableFile(snapshot, password) };
}

describe('encrypted portable container', () => {
  it('encrypts the whole accounting payload and leaks nothing in cleartext', () => {
    const { snapshot, text } = container();
    const header = readPortableHeader(text);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['binding', 'cipher', 'ciphertext', 'format', 'kdf', 'version']);
    expect(header.format).toBe(PORTABLE_FORMAT);
    expect(header.kdf.N).toBe(PORTABLE_KDF.N);
    for (const secret of [
      COMPANY_LEGAL_NAME, OWNER.email, OWNER.id, COMPANY_ID, SOURCE_PASSWORD,
      'Banco Galicia', 'gl-secret-account', 'tx-secret-1', 'Pago proveedor',
      snapshot.manifest.id, 'journalEntries', 'passwordHash',
    ]) {
      expect(text).not.toContain(secret);
    }
    // 64KiB of ciphertext cannot hide a readable payload.
    expect(header.ciphertext.length).toBeGreaterThan(200);
  });

  it('opens with the source password plus the owner email and company name', () => {
    const { text } = container();
    const opened = openPortableContainer(text, SOURCE_PASSWORD, OPEN_CONTEXT);
    expect(opened.payload.owner.ownerEmail).toBe(OWNER.email);
    expect(opened.payload.companyId).toBe(COMPANY_ID);
    expect(opened.payload.companyLegalName).toBe(COMPANY_LEGAL_NAME);
    expect(opened.payload.snapshot.manifest.companyId).toBe(COMPANY_ID);
    expect(opened.payload.snapshot.data.glAccounts?.[0]).toMatchObject({ name: 'Banco Galicia' });
    expect(opened.fileDigest).toBe(crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(opened.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(opened.payloadDigest).not.toBe(opened.fileDigest);
  });

  it('rejects a wrong password with a sanitized error that leaks no metadata', () => {
    const { text } = container();
    let message = '';
    let code = '';
    try {
      openPortableContainer(text, 'definitely-not-the-password', OPEN_CONTEXT);
    } catch (error) {
      message = (error as Error).message;
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('RECOVERY_PASSWORD_MISMATCH');
    expect(message).not.toContain('definitely-not-the-password');
    expect(message).not.toContain(OWNER.email);
    expect(message).not.toContain(COMPANY_LEGAL_NAME);
  });

  it('rejects tampered ciphertext, tag and downgraded KDF parameters', () => {
    const { text } = container();
    const header = JSON.parse(text) as Record<string, any>;
    const flip = (value: string) => `${value.slice(0, -1)}${value.at(-1) === 'A' ? 'B' : 'A'}`;
    const variants = [
      { ...header, ciphertext: flip(header.ciphertext) },
      { ...header, cipher: { ...header.cipher, tag: flip(header.cipher.tag) } },
      { ...header, kdf: { ...header.kdf, N: 1024 } },
      { ...header, kdf: { ...header.kdf, algorithm: 'pbkdf2-sha1' } },
      { ...header, snapshot: {} },
    ];
    for (const variant of variants) {
      expect(() => openPortableContainer(JSON.stringify(variant), SOURCE_PASSWORD, OPEN_CONTEXT))
        .toThrow(/recovery file/i);
    }
    expect(() => readPortableHeader('{"format":"nope"}')).toThrow(/recovery file/i);
    expect(() => openPortableContainer(text, 'short', OPEN_CONTEXT)).toThrow(/password/i);
    expect(() => openPortableContainer(text, 'x'.repeat(PORTABLE_LIMITS.passwordMax + 1), OPEN_CONTEXT)).toThrow(/password/i);
  });

  it('bounds the encoded payload before decoding it', () => {
    const header = JSON.parse(portableFile(makeSnapshot())) as Record<string, any>;
    header.ciphertext = Buffer.alloc(PORTABLE_LIMITS.ciphertextMaxBytes + 1024, 1).toString('base64');
    let code = '';
    try {
      readPortableHeader(JSON.stringify(header));
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('RECOVERY_FILE_TOO_LARGE');
  });

  it('binds the digest to the exact uploaded bytes', () => {
    const { text } = container();
    const digest = portableFileDigest(text);
    expect(digest).toBe(crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
    // Whitespace-only differences are still different uploaded bytes.
    expect(portableFileDigest(` ${text}`)).not.toBe(digest);
  });

  it('keeps the payload and the source seal available as provenance', () => {
    const { text } = container();
    const opened = openPortableContainer(text, SOURCE_PASSWORD, OPEN_CONTEXT);
    expect(opened.payload.sourceSeal).toMatchObject({ algorithm: 'hmac-sha256', authenticated: true });
  });
});

describe('portable reader contract', () => {
  it('refuses portable reading without an authenticated digest', () => {
    const snapshot = makeSnapshot();
    sealSnapshot(snapshot);
    const text = JSON.stringify(snapshot);
    expect(() => parseSnapshot(text, { recovery: 'portable' }))
      .toThrow(/PORTABLE_RECOVERY_UNAUTHENTICATED/);
    expect(() => parseSnapshot(text, { recovery: 'portable', authenticatedDigest: 'x' }))
      .toThrow(/PORTABLE_RECOVERY_UNAUTHENTICATED/);
  });

  it('accepts a source-sealed payload under a different destination secret', () => {
    const snapshot = makeSnapshot();
    const text = withEnv({ SESSION_SECRET: 'source-machine-secret' }, () => {
      sealSnapshot(snapshot);
      return JSON.stringify(snapshot);
    });
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const parsed = withEnv({ SESSION_SECRET: 'destination-machine-secret' }, () =>
      parseSnapshot(text, { recovery: 'portable', authenticatedDigest: digest }));
    expect(parsed.manifest.companyId).toBe(COMPANY_ID);
  });

  it('keeps the default reader refusing a foreign-keyed seal', () => {
    const text = withEnv({ SESSION_SECRET: 'source-machine-secret' }, () => {
      const snapshot = makeSnapshot();
      sealSnapshot(snapshot);
      return JSON.stringify(snapshot);
    });
    withEnv({ SESSION_SECRET: 'destination-machine-secret' }, () => {
      expect(() => parseSnapshot(text)).toThrow(/checksum/i);
      expect(() => parseSnapshot(text, { recovery: 'local' })).toThrow(/checksum/i);
    });
  });
});

describe('source owner resolution', () => {
  const candidate = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id, email: `${id}@example.test`, createdAt, isActive: true, platformRole: 'super_admin',
    emailVerifiedAt: OWNER_VERIFIED_AT, legacyUser: false, companyIds: [COMPANY_ID], ...extra,
  });

  it('uses the earliest verified super admin authorized for the company', () => {
    const owner = resolvePortableSourceOwner({
      companyId: COMPANY_ID,
      candidates: [
        candidate('user-second', '2026-01-02T00:00:00.000Z'),
        candidate('user-first', '2026-01-01T00:00:00.000Z'),
        candidate('user-other-company', '2025-01-01T00:00:00.000Z', { companyIds: ['other'] }),
      ],
    });
    expect(owner).toEqual({
      ownerUserId: 'user-first', ownerEmail: 'user-first@example.test',
      emailVerifiedAt: OWNER_VERIFIED_AT, legacyUser: false,
    });
  });

  it('never promotes a client-supplied email or an unverified/unauthorized actor', () => {
    const owner = resolvePortableSourceOwner({
      companyId: COMPANY_ID,
      candidates: [
        candidate('user-second', '2026-01-02T00:00:00.000Z'),
        candidate('user-first', '2026-01-01T00:00:00.000Z'),
      ],
      // @ts-expect-error a caller-supplied email is never part of the contract
      requestedEmail: 'user-second@example.test',
    });
    expect(owner.ownerUserId).toBe('user-first');
    // No membership: authorization fails closed even for a single super admin.
    expect(() => resolvePortableSourceOwner({
      companyId: COMPANY_ID,
      candidates: [candidate('lone-actor', '2026-01-01T00:00:00.000Z', { companyIds: [] })],
    })).toThrow(/RECOVERY_OWNER_MISSING/);
    // Unverified email: an address that cannot receive the token is not an owner.
    expect(() => resolvePortableSourceOwner({
      companyId: COMPANY_ID,
      candidates: [candidate('unverified', '2026-01-01T00:00:00.000Z', { emailVerifiedAt: null })],
    })).toThrow(/RECOVERY_OWNER_MISSING/);
  });

  it('fails when no authorized owner exists or two owners are equally old', () => {
    expect(() => resolvePortableSourceOwner({
      companyId: COMPANY_ID, candidates: [],
    })).toThrow(/RECOVERY_OWNER_MISSING/);
    expect(() => resolvePortableSourceOwner({
      companyId: COMPANY_ID,
      candidates: [candidate('a', '2026-01-01T00:00:00.000Z'), candidate('b', '2026-01-01T00:00:00.000Z')],
    })).toThrow(/RECOVERY_OWNER_AMBIGUOUS/);
  });

  it('accepts the app own legacy grandfathered verification path', () => {
    expect(resolvePortableSourceOwner({
      companyId: COMPANY_ID,
      candidates: [candidate('legacy', '2026-01-01T00:00:00.000Z', {
        emailVerifiedAt: null, legacyUser: true, createdAt: '2026-01-01T00:00:00.000Z',
      })],
    }).legacyUser).toBe(true);
  });
});

describe('company name confirmation', () => {
  it('normalizes whitespace, unicode and case but not content', () => {
    expect(normalizeCompanyName('  Compañía   Ñandú  S.A. ')).toBe('compañía ñandú s.a.');
    expect(companyNameMatches(COMPANY_LEGAL_NAME, ' compania   origen s.a. ')).toBe(true);
    expect(companyNameMatches(COMPANY_LEGAL_NAME, 'Compania Origen S.A. 2')).toBe(false);
    expect(companyNameMatches(COMPANY_LEGAL_NAME, '')).toBe(false);
  });
});

describe('unopenable-file guidance (S20)', () => {
  /** Every bound derivation input plus the file itself: the truthful input list. */
  const EXPLAINED_INPUTS = [/owner password/i, /owner email/i, /company name/i, /file/i];

  function openFailure(text: string, password: string, context: typeof OPEN_CONTEXT) {
    try {
      openPortableContainer(text, password, context);
    } catch (error) {
      return error as { code?: string; message: string };
    }
    throw new Error('the synthetic container opened with inputs that must not match it');
  }

  function tampered(text: string): string {
    const header = JSON.parse(text) as Record<string, any>;
    // Flip one byte of the sealed payload: still canonical base64, so the file
    // passes structural validation and fails the AEAD check (the reported
    // "file does not match" case), not the header shape check.
    const bytes = Buffer.from(header.ciphertext as string, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    header.ciphertext = bytes.toString('base64');
    return JSON.stringify(header);
  }

  it('keeps the compatibility code and explains every bound input, without an oracle', () => {
    const text = portableFile(makeSnapshot());
    const wrongCompany = { ...OPEN_CONTEXT, companyLegalName: 'Una Empresa Que No Corresponde S.A.' };
    // The reported case first (right owner email + right password, WRONG company
    // name), then the other bound inputs: all share one ambiguous failure.
    const failures = [
      openFailure(text, SOURCE_PASSWORD, wrongCompany),
      openFailure(text, 'synthetic-wrong-password-1', OPEN_CONTEXT),
      openFailure(text, SOURCE_PASSWORD, { ...OPEN_CONTEXT, ownerEmail: 'otro@example.test' }),
      openFailure(tampered(text), SOURCE_PASSWORD, OPEN_CONTEXT),
    ];

    for (const failure of failures) {
      // Legacy code name kept for API compatibility (S20: do not change it).
      expect(failure.code).toBe('RECOVERY_PASSWORD_MISMATCH');
      for (const input of EXPLAINED_INPUTS) expect(failure.message).toMatch(input);
      // Truthful: the AEAD cannot identify the failing input, so the copy may not
      // claim a password-only failure nor echo any candidate value.
      expect(failure.message).not.toMatch(/wrong password|password is incorrect/i);
      expect(failure.message).not.toContain('Una Empresa Que No Corresponde');
      expect(failure.message).not.toContain(OWNER.email);
      expect(failure.message).not.toContain(COMPANY_LEGAL_NAME);
    }
    // One message for all four inputs: no verification oracle.
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(1);
  });

  it('rejects the wrong company name with the compatibility code and no mail or restore', async () => {
    const fileText = portableFile(makeSnapshot());
    let mailCalls = 0;
    let restoreCalls = 0;
    const outcome = await requestPortableRecoveryChallenge({
      now: () => new Date('2026-03-01T09:00:00.000Z'),
      challenges: createMemoryRecoveryChallengeStore(),
      lock: createMemoryRecoveryLockStore(),
      mail: { send: async () => { mailCalls += 1; } },
      installationState: async () => ({ companies: 0, audits: 0 }),
      restore: async () => {
        restoreCalls += 1;
        throw new Error('restore must never run for an unopened file');
      },
    }, {
      fileText,
      password: SOURCE_PASSWORD,
      companyLegalName: 'Una Empresa Que No Corresponde S.A.',
      ownerEmail: OWNER.email,
    });

    expect(outcome).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    const { message } = outcome as { message: string };
    for (const input of EXPLAINED_INPUTS) expect(message).toMatch(input);
    // Fail closed: nothing is mailed and nothing is restored.
    expect(mailCalls).toBe(0);
    expect(restoreCalls).toBe(0);
  });
});

describe('container creation guards', () => {
  it('refuses a password outside the product bounds before deriving a key', () => {
    const snapshot = makeSnapshot();
    sealSnapshot(snapshot);
    expect(() => createPortableContainer({
      snapshot, password: 'short',
      owner: { ownerUserId: OWNER.id, ownerEmail: OWNER.email, emailVerifiedAt: OWNER_VERIFIED_AT, legacyUser: false, verifiedAt: OWNER_VERIFIED_AT },
      companyLegalName: COMPANY_LEGAL_NAME, createdAt: snapshot.manifest.createdAt,
    })).toThrow(/RECOVERY_PASSWORD_REQUIRED/);
  });
});
