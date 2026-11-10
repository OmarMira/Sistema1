if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';
import type { BackupData } from './backup';

/**
 * Portable recovery file (root format of a downloadable/portable backup), v3.
 *
 * Two AEAD envelopes. The expensive password KDF is bound to the owner email and
 * the company legal name, which must therefore be SUPPLIED independently at open
 * time; the source owner account id is recovered from the sealed binding (so no
 * new username or memorized code is needed) and bound into the final data key.
 * Nothing readable about the company, the owner or the ledger is written outside
 * AEAD ciphertext: the cleartext header only states how keys are derived and how
 * the envelopes are sealed.
 *
 * Key schedule (all inputs are byte strings produced by `portableKeyEncoding`):
 *
 *  wrapKey = scrypt(DSS(['context', wrap-key], ['password', password],
 *                       ['ownerEmail', email], ['companyLegalName', name]), salt)
 *            salt    = 32 random bytes, fresh for every backup
 *            email/name MUST be supplied by the caller (normalized, see below)
 *  binding = AES-256-GCM(wrapKey, ivB, AAD=['…/binding'],
 *              JSON { ownerUserId, ownerEmail, companyLegalName })   ← sealed
 *  dataKey = HKDF-SHA256(wrapKey, saltD,
 *              DSS(['context', data-key], ['ownerUserId', id],
 *                  ['ownerEmail', email], ['companyLegalName', name]))
 *  data    = AES-256-GCM(dataKey, ivD,
 *              JSON payload: owner stamp, companyId, companyLegalName,
 *              createdAt, source seal, full snapshot)
 *
 * The key therefore depends on the exact owner password, the owner email, the
 * company legal name, a per-backup random salt and — in the final data key — the
 * stable source owner account id. The password alone is NOT enough: the sealed
 * binding can only be opened after the identity-bound scrypt step succeeds, and
 * a wrong email or company name changes the wrapping key, so the AEAD check fails
 * before any accounting data (or the account id) is revealed.
 *
 * Normalization — exact, and applied identically at creation and verification:
 *  - password: used verbatim (no trim, no Unicode normalization, no case fold);
 *  - owner account id: used verbatim, inside the sealed binding only (opaque and
 *    NOT secret, ≤191 characters);
 *  - owner email: Unicode NFC, trim, lowercase;
 *  - company legal name: Unicode NFC, trim, collapse whitespace runs, lowercase.
 * Punctuation and diacritics are significant; only case, surrounding/extra
 * whitespace and Unicode composition are treated as the same value.
 *
 * Security limits (stated, not implied):
 *  - This is NOT a second cryptographic factor. Whoever holds the file AND the
 *    password AND the owner email AND the company name can open it, and can
 *    re-seal it with any identity they choose. The binding is tamper evidence for
 *    this file, not proof of authorship; the owner-email token (see
 *    backup-recovery-auth) is a separate application-level authorization step,
 *    not offline crypto.
 *  - The owner email and company name are knowledge factors, not secrets: they
 *    are typed by the operator and travel inside ciphertext. No claim of secrecy
 *    or of extra authentication is made for them.
 *  - The KDF protects a password at rest; a weak owner password stays weak.
 *
 * Version handling: v1 files (PBKDF2 over the password alone) and v2 files
 * (identity bound only into the final key, not into the expensive password KDF)
 * are REFUSED with `RECOVERY_FORMAT_UNSUPPORTED` instead of being opened with a
 * weaker schedule. Operators must export a new file.
 *
 * Binding contract:
 *  - `portableFileDigest(text)` is the SHA-256 of the EXACT bytes the operator
 *    uploaded. Authorization challenges are bound to it, so an attacker cannot
 *    substitute a self-declared digest from inside the file.
 *  - `payloadDigest` authenticates the decrypted plaintext (AEAD + hash) and is
 *    what provenance archives, so restored history is verified against
 *    authenticated content instead of locally re-signed values.
 */
export const PORTABLE_FORMAT = 'accountexpress-portable-recovery' as const;
export const PORTABLE_VERSION = 3 as const;

/** Password-derived wrapping key: pinned, memory-hard parameters. */
export const PORTABLE_KDF = Object.freeze({
  algorithm: 'scrypt' as const,
  N: 32_768,
  r: 8,
  p: 1,
  keyBytes: 32,
  saltBytes: 32,
  maxmem: 64 * 1024 * 1024,
});

/** Identity-bound data key: HKDF-SHA256 over the wrapping key. */
export const PORTABLE_DATA_KDF = Object.freeze({
  algorithm: 'hkdf-sha256' as const,
  digest: 'sha256' as const,
  saltBytes: 32,
  keyBytes: 32,
});

export const PORTABLE_CIPHER = 'aes-256-gcm' as const;

/** Domain-separation labels: exact bytes, never localized, never reused. */
export const PORTABLE_CONTEXT = Object.freeze({
  wrapKey: 'accountexpress/portable-recovery/v3/wrap-key',
  dataKey: 'accountexpress/portable-recovery/v3/data-key',
  binding: 'accountexpress/portable-recovery/v3/binding',
});

export const PORTABLE_LIMITS = Object.freeze({
  passwordMin: 8,
  passwordMax: 256,
  ivBytes: 12,
  tagBytes: 16,
  ownerIdMax: 191,
  ownerEmailMax: 254,
  companyNameMax: 320,
  /** The sealed identity envelope is a few hundred bytes; more is a forgery. */
  bindingMaxBytes: 4096,
  /** Hard cap for the uploaded container (a single backup is capped at 50MB). */
  fileMaxBytes: 96 * 1024 * 1024,
  ciphertextMaxBytes: 72 * 1024 * 1024,
  digestPattern: /^[a-f0-9]{64}$/,
  emailPattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
});

export type PortableRecoveryCode =
  | 'RECOVERY_CREDENTIAL_INVALID'
  | 'RECOVERY_FORMAT_UNSUPPORTED'
  | 'RECOVERY_IDENTITY_REQUIRED'
  | 'RECOVERY_IDENTITY_MISMATCH'
  | 'RECOVERY_PASSWORD_REQUIRED'
  | 'RECOVERY_PASSWORD_MISMATCH'
  | 'RECOVERY_FILE_TOO_LARGE'
  | 'RECOVERY_OWNER_MISSING'
  | 'RECOVERY_OWNER_AMBIGUOUS'
  | 'RECOVERY_OWNER_UNVERIFIED'
  | 'RECOVERY_SOURCE_CHAIN_INVALID';

/** Sanitized failure: stable code plus a message with no secrets or metadata. */
export class PortableRecoveryError extends Error {
  constructor(public readonly code: PortableRecoveryCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PortableRecoveryError';
  }
}

export interface PortableContainerHeader {
  format: typeof PORTABLE_FORMAT;
  version: typeof PORTABLE_VERSION;
  kdf: { algorithm: typeof PORTABLE_KDF.algorithm; N: number; r: number; p: number; salt: string };
  /** Sealed identity: AES-256-GCM(wrapKey) over the normalized derivation inputs. */
  binding: { iv: string; tag: string; ciphertext: string };
  cipher: { name: typeof PORTABLE_CIPHER; salt: string; iv: string; tag: string };
  ciphertext: string;
}

/**
 * The three identity inputs bound into the data key, in their canonical
 * (normalized) form. `ownerUserId` is opaque and not secret.
 */
export interface PortableIdentity {
  ownerUserId: string;
  ownerEmail: string;
  companyLegalName: string;
}

/**
 * What the caller must SUPPLY independently to open a file.
 *
 * The owner email and the company legal name are inputs of the expensive
 * password KDF, so the password alone can never open a backup. The stable owner
 * account id is NOT required from the caller: it is recovered from the file's
 * sealed binding and then bound into the final data key. When `ownerUserId` is
 * supplied it is verified against the sealed one.
 */
export interface PortableOpenContext {
  ownerEmail: string;
  companyLegalName: string;
  ownerUserId?: string;
}

/** Server-side owner stamp: recorded from server records after re-authentication. */
export interface PortableOwnerStamp {
  ownerUserId: string;
  ownerEmail: string;
  emailVerifiedAt: string | null;
  legacyUser: boolean;
  verifiedAt: string;
}

export interface PortableSourceSeal {
  algorithm: string;
  authenticated: boolean;
  digest: string;
}

export interface PortablePayload {
  format: typeof PORTABLE_FORMAT;
  version: typeof PORTABLE_VERSION;
  owner: PortableOwnerStamp;
  companyId: string;
  companyLegalName: string;
  createdAt: string;
  /** Source installation seal: archived evidence, never locally verified. */
  sourceSeal: PortableSourceSeal | null;
  snapshot: BackupData;
}

export interface PortableOwnerCandidate {
  id: string;
  email: string;
  createdAt: string;
  isActive: boolean;
  platformRole: string;
  emailVerifiedAt: string | null;
  legacyUser: boolean;
  companyIds: readonly string[];
}

export interface ResolvedPortableOwner {
  ownerUserId: string;
  ownerEmail: string;
  emailVerifiedAt: string | null;
  legacyUser: boolean;
}

/** Key sets are always compared in sorted order (single source of truth). */
const keySet = (keys: readonly string[]): string => [...keys].sort().join(',');
const HEADER_KEYS = keySet(['format', 'version', 'kdf', 'binding', 'cipher', 'ciphertext']);
const KDF_KEYS = keySet(['algorithm', 'N', 'r', 'p', 'salt']);
const BINDING_KEYS = keySet(['iv', 'tag', 'ciphertext']);
const CIPHER_KEYS = keySet(['name', 'salt', 'iv', 'tag']);
const IDENTITY_KEYS = keySet(['ownerUserId', 'ownerEmail', 'companyLegalName']);
const PAYLOAD_KEYS = keySet([
  'format', 'version', 'owner', 'companyId', 'companyLegalName', 'createdAt', 'sourceSeal', 'snapshot',
]);
const OWNER_KEYS = keySet(['ownerUserId', 'ownerEmail', 'emailVerifiedAt', 'legacyUser', 'verifiedAt']);
const SEAL_KEYS = keySet(['algorithm', 'authenticated', 'digest']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(detail: string): never {
  throw new PortableRecoveryError(
    'RECOVERY_CREDENTIAL_INVALID',
    `Recovery file is invalid or unsupported (${detail})`,
  );
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactBase64(value: unknown, bytes: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !BASE64.test(value)) invalid(label);
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== bytes || buffer.toString('base64') !== value) invalid(label);
  return buffer;
}

function boundedBase64(value: unknown, maxBytes: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) invalid(label);
  // Bound the encoded length BEFORE decoding so a hostile file cannot allocate.
  if (Math.ceil(value.length * 3 / 4) > maxBytes + 64) {
    throw new PortableRecoveryError('RECOVERY_FILE_TOO_LARGE', 'Recovery file exceeds the supported size');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.toString('base64') !== value) invalid(label);
  return buffer;
}

function requirePassword(password: unknown): string {
  if (typeof password !== 'string') {
    throw new PortableRecoveryError('RECOVERY_PASSWORD_REQUIRED', 'Recovery password is required');
  }
  if (password.length < PORTABLE_LIMITS.passwordMin || password.length > PORTABLE_LIMITS.passwordMax) {
    throw new PortableRecoveryError(
      'RECOVERY_PASSWORD_REQUIRED',
      'Recovery password must be between 8 and 256 characters',
    );
  }
  return password;
}

function requireString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) invalid(label);
  return value;
}

function requireBoundedText(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) invalid('payload');
  if (Buffer.byteLength(text, 'utf8') > PORTABLE_LIMITS.fileMaxBytes) {
    throw new PortableRecoveryError('RECOVERY_FILE_TOO_LARGE', 'Recovery file exceeds the supported size');
  }
  return text;
}

/** SHA-256 of the exact uploaded bytes: the only digest authorization may trust. */
export function portableFileDigest(text: string): string {
  return sha256Hex(requireBoundedText(text));
}

/**
 * F2 — canonical throttle subject for the password-attempt budget.
 *
 * The budget must protect ONE thing: guessing the owner password against this
 * file's wrapping key. That target is fully described by the values that feed
 * `deriveKey` — the format identity and the pinned KDF parameters with their
 * per-backup `kdf.salt` — so nothing else belongs in the subject:
 *
 *  - the container is JSON, so whitespace and key order are free for an attacker
 *    to change and must not buy a new budget;
 *  - `binding.*`, `cipher.*` and `ciphertext` can also be mutated freely, and
 *    their failure is already indistinguishable from a wrong password (the
 *    wrapping key does not depend on them). Including them would resurrect the
 *    very bypass this function closes: five fresh guesses per cheap mutation.
 *
 * A genuinely different backup always carries a fresh random `kdf.salt`, so
 * separate files keep separate budgets. The KDF parameters cannot be varied at
 * all: `readPortableHeader` refuses any value except the pinned ones, so the work
 * per attempt stays bounded. This is a THROTTLE key only — `portableFileDigest`
 * remains the digest that binds an authorization token to the exact uploaded
 * bytes.
 */
export function portableThrottleDigest(text: string): string {
  const header = readPortableHeader(text);
  return sha256Hex(JSON.stringify({
    format: header.format,
    version: header.version,
    kdf: {
      algorithm: header.kdf.algorithm,
      N: header.kdf.N,
      r: header.kdf.r,
      p: header.kdf.p,
      salt: header.kdf.salt,
    },
  }));
}

/**
 * Expensive password KDF. The owner email and the company legal name are
 * DERIVATION INPUTS, not metadata: without them the wrapping key cannot be
 * produced, so nothing sealed under it (including the owner account id) can be
 * opened with the password alone.
 */
function deriveKey(
  password: string,
  salt: Buffer,
  identity: Pick<PortableIdentity, 'ownerEmail' | 'companyLegalName'>,
): Buffer {
  return crypto.scryptSync(
    portableKeyEncoding([
      ['context', PORTABLE_CONTEXT.wrapKey],
      ['password', password],
      ['ownerEmail', identity.ownerEmail],
      ['companyLegalName', identity.companyLegalName],
    ]),
    salt,
    PORTABLE_KDF.keyBytes,
    { N: PORTABLE_KDF.N, r: PORTABLE_KDF.r, p: PORTABLE_KDF.p, maxmem: PORTABLE_KDF.maxmem },
  );
}

/** Data key: HKDF over the wrapping key, bound to the canonical source identity. */
function deriveDataKey(wrapKey: Buffer, salt: Buffer, identity: PortableIdentity): Buffer {
  return Buffer.from(crypto.hkdfSync(
    PORTABLE_DATA_KDF.digest,
    wrapKey,
    salt,
    portableKeyEncoding([
      ['context', PORTABLE_CONTEXT.dataKey],
      ['ownerUserId', identity.ownerUserId],
      ['ownerEmail', identity.ownerEmail],
      ['companyLegalName', identity.companyLegalName],
    ]),
    PORTABLE_DATA_KDF.keyBytes,
  ));
}

function unopenable(): never {
  // The reported case (S20) was a WRONG COMPANY NAME answered with a
  // password-only string: the wrap key is derived from the owner password, the
  // owner email and the exact company name, so the AEAD cannot tell which of
  // them (or a modified file) failed. The message must name every bound input
  // and the file instead of blaming the password.
  //
  // `RECOVERY_PASSWORD_MISMATCH` is kept as the code (API compatibility): it is
  // a legacy NAME for "this file cannot be opened", not a diagnosis.
  throw new PortableRecoveryError(
    'RECOVERY_PASSWORD_MISMATCH',
    'Recovery file could not be opened: the owner password, the owner email and the exact company ' +
    'name recorded in the backup must all match, and the file must be unmodified and complete. ' +
    'The file is sealed with AES-256-GCM, so the specific input that failed cannot be identified.',
  );
}

function openEnvelope(key: Buffer, envelope: { iv: string; tag: string; ciphertext: string }, aad?: string): Buffer {
  try {
    const decipher = crypto.createDecipheriv(PORTABLE_CIPHER, key, Buffer.from(envelope.iv, 'base64'));
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  } catch {
    unopenable();
  }
}

/* ─── Canonical identity inputs ─────────────────────────────────────── */

/** Company legal names: Unicode NFC, trim, collapse whitespace runs, lowercase. */
export function normalizeCompanyName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Owner emails: Unicode NFC, trim, lowercase (the app's own email identity rule). */
export function normalizeOwnerEmail(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

/**
 * Unambiguous, domain-separated serialization of labelled byte strings:
 *
 *   "dss1:" <fieldCount> ":" { <labelBytes> ":" <label> ":" <valueBytes> ":" <value> }
 *
 * Every label and value is length-prefixed with its BYTE count and the field
 * count comes first, so no two different field lists can encode to the same
 * bytes: moving a character from one field to another, embedding separators in
 * a value or truncating a trailing field always changes a length prefix.
 * Labels are fixed literals; values are arbitrary UTF-8 (an arbitrary password
 * therefore cannot be confused with a following field).
 */
export function portableKeyEncoding(fields: readonly (readonly [string, string])[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`dss1:${fields.length}:`, 'ascii')];
  for (const [label, value] of fields) {
    const valueBytes = Buffer.from(value, 'utf8');
    chunks.push(
      Buffer.from(`${Buffer.byteLength(label, 'utf8')}:${label}:${valueBytes.length}:`, 'utf8'),
      valueBytes,
    );
  }
  return Buffer.concat(chunks);
}

function requireOwnerId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PORTABLE_LIMITS.ownerIdMax) {
    invalid('identity.ownerUserId');
  }
  return value;
}

function requireOwnerEmail(value: unknown, normalize: boolean): string {
  if (typeof value !== 'string') invalid('identity.ownerEmail');
  const email = normalize ? normalizeOwnerEmail(value) : value;
  if (email.length === 0 || email.length > PORTABLE_LIMITS.ownerEmailMax || !PORTABLE_LIMITS.emailPattern.test(email)) {
    invalid('identity.ownerEmail');
  }
  return email;
}

function requireCompanyLegalName(value: unknown, normalize: boolean): string {
  if (typeof value !== 'string' || value.length > PORTABLE_LIMITS.companyNameMax) invalid('identity.companyLegalName');
  const name = normalize ? normalizeCompanyName(value) : value;
  if (name.length === 0) invalid('identity.companyLegalName');
  return name;
}

/** Validate a sealed identity blob and require it to already be canonical. */
function readSealedIdentity(plaintext: Buffer): PortableIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    invalid('identity.json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('identity.shape');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== IDENTITY_KEYS) invalid('identity.shape');
  const ownerUserId = requireOwnerId(record.ownerUserId);
  const ownerEmail = requireOwnerEmail(record.ownerEmail, false);
  const companyLegalName = requireCompanyLegalName(record.companyLegalName, false);
  // A non-canonical value proves the file was built outside this contract.
  if (ownerEmail !== normalizeOwnerEmail(ownerEmail) ||
      companyLegalName !== normalizeCompanyName(companyLegalName)) {
    invalid('identity.normalization');
  }
  return { ownerUserId, ownerEmail, companyLegalName };
}

/**
 * Validate the caller-supplied identity inputs of the password KDF. They are
 * REQUIRED: a missing email or company name is a hard refusal, never a silent
 * fall-back to the sealed (password-recoverable) copy.
 */
function requireOpenContext(context: unknown): { ownerEmail: string; companyLegalName: string; ownerUserId?: string } {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new PortableRecoveryError(
      'RECOVERY_IDENTITY_REQUIRED',
      'The owner email and the company name of the backup are required to open this file: the password alone is not enough',
    );
  }
  const supplied = context as Record<string, unknown>;
  const ownerEmail = supplied.ownerEmail;
  const companyLegalName = supplied.companyLegalName;
  if (typeof ownerEmail !== 'string' || ownerEmail.trim().length === 0 ||
      typeof companyLegalName !== 'string' || companyLegalName.trim().length === 0) {
    throw new PortableRecoveryError(
      'RECOVERY_IDENTITY_REQUIRED',
      'The owner email and the company name of the backup are required to open this file: the password alone is not enough',
    );
  }
  return {
    ownerEmail: requireOwnerEmail(ownerEmail, true),
    companyLegalName: requireCompanyLegalName(companyLegalName, true),
    ownerUserId: supplied.ownerUserId === undefined ? undefined : requireOwnerId(supplied.ownerUserId),
  };
}

/**
 * After the identity-bound KDF opened the sealed binding, the sealed identity
 * must describe exactly the identity the caller supplied. The AEAD already
 * enforces it; the explicit comparison keeps the invariant visible and fails
 * closed if the schedule ever changes shape.
 */
function assertSealedIdentity(
  identity: PortableIdentity,
  supplied: { ownerEmail: string; companyLegalName: string; ownerUserId?: string },
): void {
  if (identity.ownerEmail !== supplied.ownerEmail ||
      identity.companyLegalName !== supplied.companyLegalName ||
      (supplied.ownerUserId !== undefined && identity.ownerUserId !== supplied.ownerUserId)) {
    throw new PortableRecoveryError(
      'RECOVERY_IDENTITY_MISMATCH',
      'The source owner or company identity does not match the identity this backup was created for',
    );
  }
}

/**
 * Structural read of the outer envelope only (no password, no decryption, no
 * identity). Used to charge the attempt budget against the exact file digest
 * before any expensive KDF work.
 */
export function readPortableHeader(text: string): PortableContainerHeader {
  const body = requireBoundedText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    invalid('json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('shape');
  const record = parsed as Record<string, unknown>;
  if (record.format !== PORTABLE_FORMAT) invalid('format');
  // Older/foreign portable versions are refused instead of being opened with a
  // weaker key schedule (v1 derived the key from the password alone).
  if (record.version !== PORTABLE_VERSION) {
    throw new PortableRecoveryError(
      'RECOVERY_FORMAT_UNSUPPORTED',
      `Unsupported portable recovery version (${typeof record.version === 'number' ? record.version : 'invalid'}): ` +
      'this file was created by an older or unknown format. Export a new encrypted backup from the source installation.',
    );
  }
  if (Object.keys(record).sort().join(',') !== HEADER_KEYS) invalid('shape');
  const kdf = record.kdf as Record<string, unknown> | undefined;
  if (!kdf || typeof kdf !== 'object' || Array.isArray(kdf) ||
      Object.keys(kdf).sort().join(',') !== KDF_KEYS ||
      kdf.algorithm !== PORTABLE_KDF.algorithm ||
      kdf.N !== PORTABLE_KDF.N || kdf.r !== PORTABLE_KDF.r || kdf.p !== PORTABLE_KDF.p) {
    invalid('kdf');
  }
  exactBase64(kdf.salt, PORTABLE_KDF.saltBytes, 'salt');
  const binding = record.binding as Record<string, unknown> | undefined;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      Object.keys(binding).sort().join(',') !== BINDING_KEYS) {
    invalid('binding');
  }
  exactBase64(binding.iv, PORTABLE_LIMITS.ivBytes, 'binding.iv');
  exactBase64(binding.tag, PORTABLE_LIMITS.tagBytes, 'binding.tag');
  boundedBase64(binding.ciphertext, PORTABLE_LIMITS.bindingMaxBytes, 'binding.ciphertext');
  const cipher = record.cipher as Record<string, unknown> | undefined;
  if (!cipher || typeof cipher !== 'object' || Array.isArray(cipher) ||
      Object.keys(cipher).sort().join(',') !== CIPHER_KEYS || cipher.name !== PORTABLE_CIPHER) {
    invalid('cipher');
  }
  exactBase64(cipher.salt, PORTABLE_DATA_KDF.saltBytes, 'cipher.salt');
  exactBase64(cipher.iv, PORTABLE_LIMITS.ivBytes, 'iv');
  exactBase64(cipher.tag, PORTABLE_LIMITS.tagBytes, 'tag');
  boundedBase64(record.ciphertext, PORTABLE_LIMITS.ciphertextMaxBytes, 'ciphertext');
  return record as unknown as PortableContainerHeader;
}

/**
 * Encrypt the whole portable payload. Nothing from the snapshot is written
 * outside the AEAD ciphertext.
 */
export function createPortableContainer(input: {
  snapshot: BackupData;
  password: string;
  owner: PortableOwnerStamp;
  companyLegalName: string;
  createdAt: string;
}): string {
  const password = requirePassword(input.password);
  const owner: PortableOwnerStamp = {
    ownerUserId: requireString(input.owner.ownerUserId, PORTABLE_LIMITS.ownerIdMax, 'owner.ownerUserId'),
    ownerEmail: requireString(input.owner.ownerEmail, PORTABLE_LIMITS.ownerEmailMax, 'owner.ownerEmail').trim().toLowerCase(),
    emailVerifiedAt: typeof input.owner.emailVerifiedAt === 'string' ? input.owner.emailVerifiedAt : null,
    legacyUser: input.owner.legacyUser === true,
    verifiedAt: requireString(input.owner.verifiedAt, 40, 'owner.verifiedAt'),
  };
  if (!PORTABLE_LIMITS.emailPattern.test(owner.ownerEmail)) invalid('owner.ownerEmail');
  const companyLegalName = requireString(input.companyLegalName, PORTABLE_LIMITS.companyNameMax, 'companyLegalName');
  // Canonical derivation inputs: the same normalization open() re-applies when
  // it compares an expectation, so the key and the check can never disagree.
  const identity: PortableIdentity = {
    ownerUserId: requireOwnerId(owner.ownerUserId),
    ownerEmail: requireOwnerEmail(owner.ownerEmail, true),
    companyLegalName: requireCompanyLegalName(companyLegalName, true),
  };
  const integrity = input.snapshot.manifest.integrity;
  const payload: PortablePayload = {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    owner,
    companyId: requireString(input.snapshot.manifest.companyId, PORTABLE_LIMITS.ownerIdMax, 'companyId'),
    // The EXACT legal name stays in the authenticated payload; only the derived
    // key binds the normalized form.
    companyLegalName,
    createdAt: requireString(input.createdAt, 40, 'createdAt'),
    sourceSeal: integrity
      ? { algorithm: integrity.algorithm, authenticated: integrity.authenticated, digest: integrity.digest }
      : null,
    snapshot: input.snapshot,
  };
  // 1. Password-derived wrapping key: fresh random salt per backup, and the
  //    owner email + company legal name are derivation inputs.
  const salt = crypto.randomBytes(PORTABLE_KDF.saltBytes);
  const wrapKey = deriveKey(password, salt, identity);
  // 2. Sealed identity envelope: carries the three derivation inputs so an
  //    operator only ever supplies the password.
  const bindingIv = crypto.randomBytes(PORTABLE_LIMITS.ivBytes);
  const bindingCipher = crypto.createCipheriv(PORTABLE_CIPHER, wrapKey, bindingIv);
  bindingCipher.setAAD(Buffer.from(PORTABLE_CONTEXT.binding, 'utf8'));
  const bindingText = Buffer.concat([
    bindingCipher.update(Buffer.from(JSON.stringify(identity), 'utf8')),
    bindingCipher.final(),
  ]);
  // 3. Identity-bound data key seals the whole accounting payload.
  const dataSalt = crypto.randomBytes(PORTABLE_DATA_KDF.saltBytes);
  const iv = crypto.randomBytes(PORTABLE_LIMITS.ivBytes);
  const cipher = crypto.createCipheriv(PORTABLE_CIPHER, deriveDataKey(wrapKey, dataSalt, identity), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const header: PortableContainerHeader = {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    kdf: {
      algorithm: PORTABLE_KDF.algorithm,
      N: PORTABLE_KDF.N,
      r: PORTABLE_KDF.r,
      p: PORTABLE_KDF.p,
      salt: salt.toString('base64'),
    },
    binding: {
      iv: bindingIv.toString('base64'),
      tag: bindingCipher.getAuthTag().toString('base64'),
      ciphertext: bindingText.toString('base64'),
    },
    cipher: {
      name: PORTABLE_CIPHER,
      salt: dataSalt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
  return JSON.stringify(header);
}

/**
 * Open the container: header validation, password bounds, identity-bound KDF,
 * sealed identity, identity-bound AEAD decryption and payload shape validation.
 *
 * `context` is REQUIRED and carries the owner email and the company legal name,
 * which the caller must know independently of the file: they are inputs of the
 * expensive password KDF, so `openPortableContainer(text, password)` can never
 * open a backup. The stable owner account id does NOT have to be supplied (it is
 * read from the sealed binding and bound into the final data key); when it is
 * supplied it is verified.
 *
 * Every header field is authenticated: format/version and the pinned KDF
 * parameters are validated, the salt and the supplied identity feed the key, and
 * the IVs, tags and both ciphertexts are AEAD-protected. A wrong password, a
 * wrong email/company, a modified header and a modified ciphertext therefore
 * share one sanitized failure.
 */
export function openPortableContainer(
  text: string,
  password: unknown,
  context?: PortableOpenContext,
): {
  header: PortableContainerHeader;
  payload: PortablePayload;
  identity: PortableIdentity;
  fileDigest: string;
  payloadDigest: string;
} {
  const body = requireBoundedText(text);
  const header = readPortableHeader(body);
  const secret = requirePassword(password);
  // The argument is optional only so that omitting it answers a sanitized
  // RECOVERY_IDENTITY_REQUIRED instead of a TypeError: opening is impossible
  // without it.
  const supplied = requireOpenContext(context);
  const wrapKey = deriveKey(secret, Buffer.from(header.kdf.salt, 'base64'), supplied);
  const identity = readSealedIdentity(
    openEnvelope(wrapKey, header.binding, PORTABLE_CONTEXT.binding),
  );
  assertSealedIdentity(identity, supplied);
  const plaintext = openEnvelope(
    deriveDataKey(wrapKey, Buffer.from(header.cipher.salt, 'base64'), identity),
    { iv: header.cipher.iv, tag: header.cipher.tag, ciphertext: header.ciphertext },
  );
  const plaintextText = plaintext.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintextText);
  } catch {
    invalid('payload.json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('payload.shape');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== PAYLOAD_KEYS) invalid('payload.shape');
  if (record.format !== PORTABLE_FORMAT || record.version !== PORTABLE_VERSION) invalid('payload.version');
  const owner = record.owner as Record<string, unknown> | undefined;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
      Object.keys(owner).sort().join(',') !== OWNER_KEYS) invalid('payload.owner');
  if (typeof owner.ownerUserId !== 'string' || !owner.ownerUserId || owner.ownerUserId.length > PORTABLE_LIMITS.ownerIdMax) invalid('payload.owner');
  if (typeof owner.ownerEmail !== 'string' || !PORTABLE_LIMITS.emailPattern.test(owner.ownerEmail) || owner.ownerEmail.length > PORTABLE_LIMITS.ownerEmailMax) invalid('payload.owner');
  if (owner.emailVerifiedAt !== null && typeof owner.emailVerifiedAt !== 'string') invalid('payload.owner');
  if (typeof owner.legacyUser !== 'boolean' || typeof owner.verifiedAt !== 'string') invalid('payload.owner');
  if (typeof record.companyId !== 'string' || !record.companyId) invalid('payload.companyId');
  if (typeof record.companyLegalName !== 'string' || !record.companyLegalName) invalid('payload.companyLegalName');
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) invalid('payload.createdAt');
  const seal = record.sourceSeal as Record<string, unknown> | null;
  if (seal !== null) {
    if (typeof seal !== 'object' || Array.isArray(seal) ||
        Object.keys(seal).sort().join(',') !== SEAL_KEYS ||
        typeof seal.algorithm !== 'string' || typeof seal.authenticated !== 'boolean' ||
        typeof seal.digest !== 'string' || !PORTABLE_LIMITS.digestPattern.test(seal.digest)) {
      invalid('payload.sourceSeal');
    }
  }
  const snapshot = record.snapshot as Record<string, unknown> | undefined;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !snapshot.manifest || !snapshot.data) invalid('payload.snapshot');
  // The decrypted identity must be exactly the identity the key was bound to:
  // a file cannot claim one owner/company in its binding and carry another.
  if (owner.ownerUserId !== identity.ownerUserId ||
      normalizeOwnerEmail(owner.ownerEmail as string) !== identity.ownerEmail ||
      normalizeCompanyName(record.companyLegalName) !== identity.companyLegalName) {
    throw new PortableRecoveryError(
      'RECOVERY_IDENTITY_MISMATCH',
      'The recovery file identity does not match the accounting data inside it',
    );
  }
  return {
    header,
    payload: record as unknown as PortablePayload,
    identity,
    fileDigest: sha256Hex(body),
    payloadDigest: sha256Hex(plaintextText),
  };
}

/* ─── Company name confirmation (S5) ────────────────────────────────── */

/** The typed name must match the name carried by the authenticated payload. */
export function companyNameMatches(expected: string, provided: string): boolean {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const left = normalizeCompanyName(expected);
  const right = normalizeCompanyName(provided);
  return left.length > 0 && right.length > 0 && left === right;
}

/* ─── Source owner resolution (S3, blocker 6) ───────────────────────── */

/**
 * The owner is derived ONLY from server records, and must be PROVEN:
 *  - active global `super_admin`;
 *  - authorized for this company (explicit membership — no acting-actor
 *    fallback, so an arbitrary super admin can never claim a company);
 *  - with a verified identity (or the app's own legacy grandfathered status),
 *    because the recovery token is sent to that address;
 *  - the unambiguous earliest such account (the original owner), otherwise the
 *    request fails closed.
 */
export function resolvePortableSourceOwner(input: {
  candidates: readonly PortableOwnerCandidate[];
  companyId: string;
}): ResolvedPortableOwner {
  const eligible = input.candidates.filter((candidate) =>
    Boolean(candidate) && candidate.platformRole === 'super_admin' && candidate.isActive === true &&
    typeof candidate.id === 'string' && candidate.id.length > 0 &&
    typeof candidate.email === 'string' && PORTABLE_LIMITS.emailPattern.test(candidate.email.trim()) &&
    (candidate.emailVerifiedAt !== null || candidate.legacyUser === true) &&
    candidate.companyIds.includes(input.companyId));

  if (eligible.length === 0) {
    throw new PortableRecoveryError(
      'RECOVERY_OWNER_MISSING',
      'No verified super administrator is authorized for this company, so no authentic source owner can be certified',
    );
  }
  const times = eligible.map((candidate) => Date.parse(candidate.createdAt));
  if (times.some((time) => !Number.isFinite(time))) {
    throw new PortableRecoveryError('RECOVERY_OWNER_MISSING', 'Source owner creation time is not recorded');
  }
  const earliest = Math.min(...times);
  const oldest = eligible.filter((_candidate, index) => times[index] === earliest);
  if (oldest.length > 1) {
    throw new PortableRecoveryError(
      'RECOVERY_OWNER_AMBIGUOUS',
      'More than one super administrator shares the earliest creation time, so the authentic source owner is ambiguous',
    );
  }
  return {
    ownerUserId: oldest[0].id,
    ownerEmail: oldest[0].email.trim().toLowerCase(),
    emailVerifiedAt: oldest[0].emailVerifiedAt,
    legacyUser: oldest[0].legacyUser === true,
  };
}

/**
 * The SOURCE owner credential carried by an authenticated portable payload.
 *
 * This is the only owner evidence a brand-new machine can have: the file itself
 * proves (through the identity-bound KDF + AEAD) that whoever wrote it knew the
 * owner password, the owner email and the company legal name, and the sealed
 * owner stamp records what the SOURCE installation knew about that account when
 * it exported (verified email or the app's own grandfathered legacy status).
 *
 * Authorizing recovery therefore never needs a destination account: requiring
 * one made zero-installation recovery impossible (the reported
 * RECOVERY_OWNER_UNAVAILABLE 403). The owner-email token sent by the caller is
 * the live proof that the address still belongs to the owner.
 */
export interface PortableSourceOwnerCredential {
  ownerUserId: string;
  /** Normalized the same way the KDF normalizes it. */
  ownerEmail: string;
  emailVerifiedAt: string | null;
  legacyUser: boolean;
  verifiedAt: string;
  proof: 'verified-email' | 'legacy-grandfathered';
}

/**
 * Validate the sealed owner credential of an already-opened portable payload.
 *
 * Fail-closed rules:
 *  - the credential must describe EXACTLY the identity the data key was bound to;
 *  - the source owner must have had a verified email (or the documented legacy
 *    grandfathered status): an unverified address can receive the token, so it
 *    can never authorize the recovery;
 *  - when the authenticated snapshot carries the owner's user row, it must agree
 *    (same email, `role` still `super_admin`). A disagreement is refused rather
 *    than resolved in favour of either copy.
 *
 * The row is a cross-check, not a requirement: an export can legitimately carry
 * an owner who is not a member row of the selected company, and refusing those
 * files would make a perfectly valid backup unrecoverable.
 */
export function validatePortableRecoveryCredential(input: {
  payload: PortablePayload;
  identity: PortableIdentity;
  /** Snapshot user rows (`data.users`); defaults to the payload's own rows. */
  users?: readonly Record<string, unknown>[];
}): PortableSourceOwnerCredential {
  const stamp = input.payload.owner;
  if (stamp.ownerUserId !== input.identity.ownerUserId ||
      normalizeOwnerEmail(stamp.ownerEmail) !== input.identity.ownerEmail ||
      normalizeCompanyName(input.payload.companyLegalName) !== input.identity.companyLegalName) {
    throw new PortableRecoveryError(
      'RECOVERY_OWNER_UNVERIFIED',
      'The source owner credential does not describe the identity this backup is bound to',
    );
  }
  const ownerEmail = requireOwnerEmail(stamp.ownerEmail, true);
  if (stamp.emailVerifiedAt !== null &&
      (typeof stamp.emailVerifiedAt !== 'string' || !Number.isFinite(Date.parse(stamp.emailVerifiedAt)))) {
    throw new PortableRecoveryError('RECOVERY_OWNER_UNVERIFIED', 'Source owner verification timestamp is invalid');
  }
  if (!Number.isFinite(Date.parse(stamp.verifiedAt))) {
    throw new PortableRecoveryError('RECOVERY_OWNER_UNVERIFIED', 'Source owner stamp timestamp is invalid');
  }
  // The source owner must be a VERIFIED account: either a verified email or the
  // application's own grandfathered legacy status. Nothing else can receive and
  // prove an owner token.
  const proof = stamp.emailVerifiedAt !== null
    ? 'verified-email' as const
    : stamp.legacyUser === true ? 'legacy-grandfathered' as const : null;
  if (!proof) {
    throw new PortableRecoveryError(
      'RECOVERY_OWNER_UNVERIFIED',
      'The owner recorded in this backup never had a verified email, so no recovery token can be trusted',
    );
  }
  const users = input.users ?? ((input.payload.snapshot?.data?.users ?? []) as unknown as Record<string, unknown>[]);
  const row = Array.isArray(users)
    ? users.find((entry) => entry !== null && typeof entry === 'object' && String(entry.id) === stamp.ownerUserId)
    : undefined;
  if (row) {
    if (typeof row.email !== 'string' || normalizeOwnerEmail(row.email) !== ownerEmail) {
      throw new PortableRecoveryError(
        'RECOVERY_OWNER_UNVERIFIED',
        'The owner recorded in this backup does not match the owner account of the accounting data inside it',
      );
    }
    if (row.role !== undefined && row.role !== 'super_admin') {
      throw new PortableRecoveryError(
        'RECOVERY_OWNER_UNVERIFIED',
        'The owner recorded in this backup is not a super administrator of the source installation',
      );
    }
  }
  return {
    ownerUserId: stamp.ownerUserId,
    ownerEmail,
    emailVerifiedAt: stamp.emailVerifiedAt,
    legacyUser: stamp.legacyUser === true,
    verifiedAt: stamp.verifiedAt,
    proof,
  };
}

/** Company entity type carried by the snapshot (destination shell creation). */export function portableCompanyEntityType(snapshot: BackupData): 'INDIVIDUAL' | 'BUSINESS' {
  const candidates = [
    (snapshot.data.company?.[0] as { entityType?: unknown } | undefined)?.entityType,
    (snapshot.manifest.companyInfo as { entityType?: unknown } | undefined)?.entityType,
  ];
  const match = candidates.find((value): value is 'INDIVIDUAL' | 'BUSINESS' =>
    value === 'INDIVIDUAL' || value === 'BUSINESS');
  return match ?? 'BUSINESS';
}
