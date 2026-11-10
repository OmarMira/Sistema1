import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  PORTABLE_KDF, PORTABLE_LIMITS, PORTABLE_VERSION, createPortableContainer, normalizeCompanyName,
  normalizeOwnerEmail, openPortableContainer, portableKeyEncoding, readPortableHeader,
} from '@/lib/backup-portable';
import { sealSnapshot } from '@/lib/backup-format';
import type { BackupData } from '@/lib/backup';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OPEN_CONTEXT, OWNER, OWNER_VERIFIED_AT, SOURCE_PASSWORD, makeSnapshot,
} from './helpers';

/**
 * Portable v3 key binding (S9-S13, L12-L13).
 *
 * Synthetic data only: the exported creation/open API of the real container, the
 * real download API (`buildPortableRecoveryFile`) with its storage, database and
 * password-verification collaborators mocked. No real database, backup file,
 * password, credential or key is read or written.
 *
 * The invariant this suite protects: the file's key derives from the password
 * AND the owner email AND the company legal name, so the password alone — and
 * any wrong one of the three — cannot open a backup. The stable owner account id
 * is recovered from the file and bound into the final key, so no new username or
 * memorized code is required.
 */
const mocks = vi.hoisted(() => ({
  readBackupText: vi.fn(),
  ownerRows: [] as Array<Record<string, unknown>>,
  ownerRow: { passwordHash: 'mock-hash' } as Record<string, unknown> | null,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findMany: async () => mocks.ownerRows,
      findUnique: async () => mocks.ownerRow,
    },
  },
  withCompanyBackupTransaction: async () => {
    throw new Error('the download path never opens a write transaction');
  },
}));
vi.mock('@/lib/backup-storage', () => ({
  readBackupText: mocks.readBackupText,
  readCatalog: () => [],
  writeCatalog: () => undefined,
  publishBackup: () => undefined,
  removeBackupFile: () => undefined,
  readCompanyConfig: () => null,
  validBackupFilename: () => true,
}));
vi.mock('@/lib/auth', () => ({
  hashPassword: async (password: string) => `mock:${password}`,
  verifyPassword: async (password: string, hash: string) => hash === `mock:${password}`,
}));

import { buildPortableRecoveryFile } from '@/lib/backup';

const OTHER_EMAIL = 'otra-persona@example.test';
const OTHER_OWNER_ID = 'user-owner-other';
const OTHER_COMPANY = 'Otra Compania S.A.';
const CREDENTIALS = { ownerEmail: OWNER.email, companyLegalName: COMPANY_LEGAL_NAME };

function storedSnapshot(legalName = COMPANY_LEGAL_NAME): string {
  const snapshot = makeSnapshot({ legalName });
  const data = snapshot.data as unknown as Record<string, Array<Record<string, unknown>>>;
  data.glAccounts.push({ id: 'gl-secret-account', companyId: COMPANY_ID, name: 'Banco Galicia' });
  data.bankTransactions.push({ id: 'txsecret', companyId: COMPANY_ID, description: 'Pago proveedor' });
  snapshot.manifest.recordCounts.glAccounts = 1;
  snapshot.manifest.recordCounts.bankTransactions = 1;
  sealSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

/** Create the portable file exactly like the export path does. */
function container(input: {
  password?: string;
  snapshot?: BackupData;
  owner?: { id: string; email: string };
  legalName?: string;
} = {}): string {
  const snapshot = input.snapshot ?? makeSnapshot({ legalName: input.legalName ?? COMPANY_LEGAL_NAME });
  sealSnapshot(snapshot);
  const owner = input.owner ?? OWNER;
  return createPortableContainer({
    snapshot,
    password: input.password ?? SOURCE_PASSWORD,
    owner: {
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      emailVerifiedAt: OWNER_VERIFIED_AT,
      legacyUser: false,
      verifiedAt: OWNER_VERIFIED_AT,
    },
    companyLegalName: input.legalName ?? snapshot.manifest.companyInfo.legalName,
    createdAt: snapshot.manifest.createdAt,
  });
}

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return (error as { code?: string }).code ?? `no-code:${(error as Error).message}`;
  }
  return 'opened';
}

/** Deterministic `crypto.randomBytes`: same call sequence ⇒ same bytes. */
function withPinnedRandom<T>(work: () => T): T {
  let call = 0;
  const spy = vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) =>
    Buffer.alloc(size, 1 + ((call++) % 251))) as never);
  try {
    return work();
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownerRows = [{
    id: OWNER.id,
    email: OWNER.email,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    platformRole: 'super_admin',
    isActive: true,
    emailVerifiedAt: new Date(OWNER_VERIFIED_AT),
    legacyUser: false,
    companyMemberships: [{ companyId: COMPANY_ID }],
  }];
  mocks.ownerRow = { passwordHash: `mock:${SOURCE_PASSWORD}` };
  mocks.readBackupText.mockReturnValue({ data: storedSnapshot(), size: 1024 });
});

describe('portable v3 key derivation binding', () => {
  it('opens only when password, owner email and company name are all supplied', () => {
    const text = container();
    const opened = openPortableContainer(text, SOURCE_PASSWORD, CREDENTIALS);
    expect(opened.identity).toEqual({
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      companyLegalName: normalizeCompanyName(COMPANY_LEGAL_NAME),
    });
    // The account id comes from the file (no new username to remember) and is the
    // same identity the authenticated payload carries.
    expect(opened.identity.ownerUserId).toBe(opened.payload.owner.ownerUserId);
    expect(opened.payload.companyId).toBe(COMPANY_ID);
    // Supplied values are normalized exactly like creation.
    const verified = openPortableContainer(text, SOURCE_PASSWORD, {
      ownerEmail: '  OWNER@Example.TEST ',
      companyLegalName: `  ${COMPANY_LEGAL_NAME.toUpperCase()}  `,
      ownerUserId: OWNER.id,
    });
    expect(verified.payload.companyId).toBe(COMPANY_ID);
  });

  it('refuses the password alone and any incomplete identity', () => {
    const text = container();
    // Password only: the identity inputs are KDF inputs, not file metadata.
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD)))
      .toBe('RECOVERY_IDENTITY_REQUIRED');
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, { ownerEmail: OWNER.email } as never)))
      .toBe('RECOVERY_IDENTITY_REQUIRED');
    expect(codeOf(() =>
      openPortableContainer(text, SOURCE_PASSWORD, { companyLegalName: COMPANY_LEGAL_NAME } as never)))
      .toBe('RECOVERY_IDENTITY_REQUIRED');
    expect(codeOf(() =>
      openPortableContainer(text, SOURCE_PASSWORD, { ownerEmail: '   ', companyLegalName: '   ' })))
      .toBe('RECOVERY_IDENTITY_REQUIRED');
    // The refusal is sanitized: no accounting data and no identity is echoed.
    try {
      openPortableContainer(text, SOURCE_PASSWORD);
    } catch (error) {
      const message = (error as Error).message;
      for (const secret of [OWNER.email, OWNER.id, COMPANY_LEGAL_NAME, 'Banco Galicia', SOURCE_PASSWORD]) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it('refuses each individually wrong value', () => {
    const text = container();
    expect(codeOf(() => openPortableContainer(text, 'definitely-not-the-password', CREDENTIALS)))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
    // A wrong email or a wrong company name changes the wrapping key, so the
    // sealed binding cannot be opened either: indistinguishable from a bad
    // password and impossible with the password alone.
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, { ...CREDENTIALS, ownerEmail: OTHER_EMAIL })))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, { ...CREDENTIALS, companyLegalName: OTHER_COMPANY })))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
    // Owner id: recovered from the file, verified only when the caller offers it.
    expect(codeOf(() =>
      openPortableContainer(text, SOURCE_PASSWORD, { ...CREDENTIALS, ownerUserId: OTHER_OWNER_ID })))
      .toBe('RECOVERY_IDENTITY_MISMATCH');
    // A near miss in the password is still a miss: the password is used verbatim.
    expect(codeOf(() => openPortableContainer(text, `${SOURCE_PASSWORD} `, CREDENTIALS)))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
    // Sanitized failures never echo an identity value or the password.
    try {
      openPortableContainer(text, SOURCE_PASSWORD, { ...CREDENTIALS, ownerEmail: OTHER_EMAIL });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(OTHER_EMAIL);
      expect(message).not.toContain(OWNER.email);
      expect(message).not.toContain(SOURCE_PASSWORD);
    }
  });

  it('binds the email and company name into the password KDF, before the sealed binding', () => {
    // Identical salt ⇒ the KDF parameters are the same, so any difference in the
    // wrapping key can only come from the identity inputs.
    const first = withPinnedRandom(() => container());
    const second = withPinnedRandom(() => container({ owner: { id: OWNER.id, email: OTHER_EMAIL } }));
    const firstHeader = JSON.parse(first) as Record<string, any>;
    const secondHeader = JSON.parse(second) as Record<string, any>;
    expect(firstHeader.kdf.salt).toBe(secondHeader.kdf.salt);

    // Re-label the first file with the second identity: the wrapping key no
    // longer matches, so not even the sealed identity can be opened.
    const relabelled = JSON.stringify({ ...firstHeader, binding: secondHeader.binding });
    expect(codeOf(() => openPortableContainer(relabelled, SOURCE_PASSWORD, CREDENTIALS)))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
    // Under the OTHER email the splice does reach the sealed identity (proof that
    // the email is an input of the password KDF, before the binding is opened):
    // the mismatch is then reported on the identity check, not on the AEAD tag.
    expect(codeOf(() => openPortableContainer(relabelled, SOURCE_PASSWORD, {
      ownerEmail: OTHER_EMAIL,
      companyLegalName: COMPANY_LEGAL_NAME,
      ownerUserId: 'user-not-bound',
    }))).toBe('RECOVERY_IDENTITY_MISMATCH');
    // Control: each untouched file still opens only with its own identity.
    expect(openPortableContainer(first, SOURCE_PASSWORD, CREDENTIALS).identity.ownerEmail).toBe(OWNER.email);
    expect(openPortableContainer(second, SOURCE_PASSWORD, { ...CREDENTIALS, ownerEmail: OTHER_EMAIL })
      .identity.ownerEmail).toBe(OTHER_EMAIL);
    expect(codeOf(() => openPortableContainer(second, SOURCE_PASSWORD, CREDENTIALS)))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
  });

  it('binds the recovered owner account id into the final data key', () => {
    const first = withPinnedRandom(() => container());
    const second = withPinnedRandom(() => container({ owner: { id: OTHER_OWNER_ID, email: OWNER.email } }));
    const firstHeader = JSON.parse(first) as Record<string, any>;
    const secondHeader = JSON.parse(second) as Record<string, any>;
    expect(firstHeader.kdf.salt).toBe(secondHeader.kdf.salt);

    // Same password/email/company ⇒ the wrapping key opens either sealed
    // identity; only the owner id differs, and it feeds the data key.
    const relabelled = JSON.stringify({ ...firstHeader, binding: secondHeader.binding });
    expect(codeOf(() => openPortableContainer(relabelled, SOURCE_PASSWORD, {
      ...CREDENTIALS, ownerUserId: OWNER.id,
    }))).toBe('RECOVERY_IDENTITY_MISMATCH');
    expect(codeOf(() => openPortableContainer(relabelled, SOURCE_PASSWORD, CREDENTIALS)))
      .toBe('RECOVERY_PASSWORD_MISMATCH');
    // Control: the untouched file opens and reports its own owner id.
    expect(openPortableContainer(first, SOURCE_PASSWORD, { ...CREDENTIALS, ownerUserId: OWNER.id })
      .identity.ownerUserId).toBe(OWNER.id);
  });

  it('uses a fresh random salt and fresh IVs for every backup', () => {
    const first = JSON.parse(container()) as Record<string, any>;
    const second = JSON.parse(container()) as Record<string, any>;
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(Buffer.from(first.kdf.salt, 'base64')).toHaveLength(PORTABLE_KDF.saltBytes);
    expect(first.cipher.salt).not.toBe(second.cipher.salt);
    expect(first.cipher.iv).not.toBe(second.cipher.iv);
    expect(first.binding.iv).not.toBe(second.binding.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.binding.ciphertext).not.toBe(second.binding.ciphertext);
  });

  it('writes no accounting data, password or identity in cleartext', () => {
    const text = container();
    const header = readPortableHeader(text);
    expect(Object.keys(JSON.parse(text) as object).sort())
      .toEqual(['binding', 'cipher', 'ciphertext', 'format', 'kdf', 'version']);
    expect(header.version).toBe(PORTABLE_VERSION);
    expect(header.kdf).toMatchObject({
      algorithm: PORTABLE_KDF.algorithm, N: PORTABLE_KDF.N, r: PORTABLE_KDF.r, p: PORTABLE_KDF.p,
    });
    expect(Buffer.from(header.binding.ciphertext, 'base64').length)
      .toBeLessThanOrEqual(PORTABLE_LIMITS.bindingMaxBytes);

    const decoded = [text, header.ciphertext, header.binding.ciphertext]
      .map((value) => Buffer.from(value, 'base64').toString('latin1'))
      .join('\n');
    for (const secret of [
      OWNER.id, OWNER.email, OTHER_EMAIL, COMPANY_LEGAL_NAME, normalizeCompanyName(COMPANY_LEGAL_NAME),
      COMPANY_ID, SOURCE_PASSWORD, 'Banco Galicia', 'Pago proveedor', 'gl-secret-account',
      'txsecret', 'journalEntries', 'ownerUserId', 'companyLegalName',
    ]) {
      expect(text).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
  });

  it('rejects a tampered header or ciphertext instead of opening it', () => {
    const header = JSON.parse(container()) as Record<string, any>;
    const flip = (value: string) => `${value.slice(0, -1)}${value.at(-1) === 'A' ? 'B' : 'A'}`;
    const variants: Record<string, Record<string, any>> = {
      ciphertext: { ...header, ciphertext: flip(header.ciphertext) },
      dataIv: { ...header, cipher: { ...header.cipher, iv: flip(header.cipher.iv) } },
      dataTag: { ...header, cipher: { ...header.cipher, tag: flip(header.cipher.tag) } },
      dataSalt: { ...header, cipher: { ...header.cipher, salt: flip(header.cipher.salt) } },
      cipherName: { ...header, cipher: { ...header.cipher, name: 'aes-256-cbc' } },
      bindingIv: { ...header, binding: { ...header.binding, iv: flip(header.binding.iv) } },
      bindingTag: { ...header, binding: { ...header.binding, tag: flip(header.binding.tag) } },
      bindingCiphertext: { ...header, binding: { ...header.binding, ciphertext: flip(header.binding.ciphertext) } },
      kdfSalt: { ...header, kdf: { ...header.kdf, salt: flip(header.kdf.salt) } },
      kdfWork: { ...header, kdf: { ...header.kdf, N: 1024 } },
      kdfAlgorithm: { ...header, kdf: { ...header.kdf, algorithm: 'pbkdf2-sha256' } },
      injectedIdentity: { ...header, ownerEmail: OWNER.email },
      injectedCompany: { ...header, companyLegalName: COMPANY_LEGAL_NAME },
    };
    for (const [label, variant] of Object.entries(variants)) {
      expect(() => openPortableContainer(JSON.stringify(variant), SOURCE_PASSWORD, CREDENTIALS), label)
        .toThrow(/recovery file/i);
    }
    for (const missing of ['binding', 'cipher', 'kdf'] as const) {
      const { [missing]: _removed, ...rest } = header;
      expect(() => openPortableContainer(JSON.stringify(rest), SOURCE_PASSWORD, CREDENTIALS), missing)
        .toThrow(/recovery file/i);
    }
  });

  it('refuses older portable versions instead of opening them with a weaker key', () => {
    const header = JSON.parse(container()) as Record<string, any>;
    const legacySchedules = [
      // v1: PBKDF2 over the password alone.
      { ...header, version: 1, kdf: { algorithm: 'pbkdf2-sha256', iterations: 210_000, salt: header.kdf.salt } },
      // v2: identity bound only into the final data key.
      { ...header, version: 2, kdf: { ...header.kdf } },
      // Unknown future version.
      { ...header, version: 99 },
    ];
    for (const legacy of legacySchedules) {
      expect(codeOf(() => readPortableHeader(JSON.stringify(legacy))))
        .toBe('RECOVERY_FORMAT_UNSUPPORTED');
      expect(codeOf(() => openPortableContainer(JSON.stringify(legacy), SOURCE_PASSWORD, CREDENTIALS)))
        .toBe('RECOVERY_FORMAT_UNSUPPORTED');
    }
    // Not a refused-but-opened fallback: nothing was decrypted.
    try {
      openPortableContainer(JSON.stringify(legacySchedules[0]), SOURCE_PASSWORD, CREDENTIALS);
    } catch (error) {
      expect((error as Error).message).toMatch(/export a new encrypted backup/i);
    }
  });

  it('keeps the domain-separated encoding unambiguous', () => {
    const encode = portableKeyEncoding;
    expect(encode([['a', 'bc']]).equals(encode([['ab', 'c']]))).toBe(false);
    expect(encode([['a', 'b'], ['c', '']]).equals(encode([['a', 'b']]))).toBe(false);
    expect(encode([['a', 'b:c']]).equals(encode([['a:b', 'c']]))).toBe(false);
    expect(encode([['a', '1:'], ['b', '2']]).equals(encode([['a', '1'], ['b', ':2']]))).toBe(false);
    expect(encode([['ownerEmail', 'x@example.test']])
      .equals(encode([['companyLegalName', 'x@example.test']]))).toBe(false);
    expect(encode([['a', 'b']]).equals(encode([['a', 'b']]))).toBe(true);
    // Byte counts, not character counts: a multi-byte value cannot alias two.
    expect(encode([['x', 'ñ']]).equals(encode([['x', 'n']]))).toBe(false);
  });

  it('normalizes the email and company name but never the password', () => {
    const text = container();
    expect(normalizeOwnerEmail(' Owner@Example.TEST ')).toBe('owner@example.test');
    expect(openPortableContainer(text, SOURCE_PASSWORD, {
      ownerEmail: ' OWNER@example.TEST ',
      companyLegalName: '  compania   ORIGEN s.a. ',
    }).identity.companyLegalName).toBe('compania origen s.a.');
    // The account id is opaque: it is compared verbatim, never normalized.
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, {
      ...CREDENTIALS, ownerUserId: ` ${OWNER.id}`,
    }))).toBe('RECOVERY_IDENTITY_MISMATCH');
  });

  it('refuses to create a container without a usable identity', () => {
    const snapshot = makeSnapshot();
    const base = {
      snapshot,
      password: SOURCE_PASSWORD,
      owner: {
        ownerUserId: OWNER.id, ownerEmail: OWNER.email, emailVerifiedAt: OWNER_VERIFIED_AT,
        legacyUser: false, verifiedAt: OWNER_VERIFIED_AT,
      },
      createdAt: snapshot.manifest.createdAt,
    };
    expect(codeOf(() => createPortableContainer({ ...base, companyLegalName: '   ' })))
      .toBe('RECOVERY_CREDENTIAL_INVALID');
    expect(codeOf(() => createPortableContainer({
      ...base, owner: { ...base.owner, ownerEmail: 'not-an-email' }, companyLegalName: COMPANY_LEGAL_NAME,
    }))).toBe('RECOVERY_CREDENTIAL_INVALID');
    expect(codeOf(() => createPortableContainer({
      ...base, owner: { ...base.owner, ownerUserId: '' }, companyLegalName: COMPANY_LEGAL_NAME,
    }))).toBe('RECOVERY_CREDENTIAL_INVALID');
  });
});

describe('portable download API (buildPortableRecoveryFile)', () => {
  const FILENAME = `${COMPANY_ID}_backup-2026-01-05.json`;

  async function download(password = SOURCE_PASSWORD) {
    return buildPortableRecoveryFile({ companyId: COMPANY_ID, filename: FILENAME, password });
  }

  it('serves a container sealed with the server-resolved source identity', async () => {
    const file = await download();
    expect(file).not.toBeNull();
    const text = Buffer.from(file!.data, 'base64').toString('utf8');
    for (const secret of [OWNER.email, OWNER.id, COMPANY_LEGAL_NAME, 'Banco Galicia', SOURCE_PASSWORD]) {
      expect(text).not.toContain(secret);
    }
    const opened = openPortableContainer(text, SOURCE_PASSWORD, OPEN_CONTEXT);
    expect(opened.payload.companyId).toBe(COMPANY_ID);
    expect(opened.payload.snapshot.data.glAccounts?.[0]).toMatchObject({ name: 'Banco Galicia' });
    expect(file!.filename).toMatch(/_recovery\.json$/);
    expect(file!.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('cannot be opened with the password alone or with a wrong identity', async () => {
    const file = await download();
    const text = Buffer.from(file!.data, 'base64').toString('utf8');
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD)))
      .toBe('RECOVERY_IDENTITY_REQUIRED');
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, {
      ...CREDENTIALS, ownerEmail: OTHER_EMAIL,
    }))).toBe('RECOVERY_PASSWORD_MISMATCH');
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, {
      ...CREDENTIALS, companyLegalName: OTHER_COMPANY,
    }))).toBe('RECOVERY_PASSWORD_MISMATCH');
  });

  it('refuses the download when the owner password does not match', async () => {
    await expect(download('definitely-not-the-password')).rejects.toThrow(/does not match/i);
    // Nothing was written or returned for the caller.
    expect(mocks.readBackupText).toHaveBeenCalledWith(FILENAME);
  });

  it('seals the identity its own records resolve at download time', async () => {
    const before = await download();
    expect(openPortableContainer(Buffer.from(before!.data, 'base64').toString('utf8'), SOURCE_PASSWORD, {
      ownerEmail: OWNER.email,
      companyLegalName: COMPANY_LEGAL_NAME,
    }).identity.ownerEmail).toBe(OWNER.email);

    mocks.ownerRows = [{ ...mocks.ownerRows[0], email: OTHER_EMAIL }];
    const after = await download();
    const text = Buffer.from(after!.data, 'base64').toString('utf8');
    // The current identity opens it; the previous one is refused.
    expect(openPortableContainer(text, SOURCE_PASSWORD, {
      ownerEmail: OTHER_EMAIL,
      companyLegalName: COMPANY_LEGAL_NAME,
    }).identity.ownerEmail).toBe(OTHER_EMAIL);
    expect(codeOf(() => openPortableContainer(text, SOURCE_PASSWORD, {
      ownerEmail: OWNER.email,
      companyLegalName: COMPANY_LEGAL_NAME,
    }))).toBe('RECOVERY_PASSWORD_MISMATCH');
    expect(text).not.toContain(OTHER_EMAIL);
  });

  it('keeps refusing a stored file that belongs to another company', async () => {
    mocks.readBackupText.mockReturnValue({ data: storedSnapshot(), size: 1024 });
    await expect(buildPortableRecoveryFile({
      companyId: 'company-otra', filename: FILENAME, password: SOURCE_PASSWORD,
    })).resolves.toBeNull();
  });
});
