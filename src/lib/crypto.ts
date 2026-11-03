// Edge-compatible crypto using Web Crypto API (crypto.subtle)
// AES-256-GCM logic preserved; encrypt/decrypt are async.
//
// KEY DERIVATION (S23f) — read-legacy / write-new:
//  - Legacy payloads (the retired 3-part `ivHex:tagHex:hex` format and the
//    2-part `ivHex:base64(ciphertext||tag)` format, including every backup
//    sealed by src/lib/backup-storage.ts) were keyed with
//    PBKDF2-SHA256(SESSION_SECRET, 'crypto-key-salt', 100000). That exact
//    derivation stays available — unchanged — for DECRYPTION only.
//  - New payloads are written with a DOMAIN-SEPARATED key: the same PBKDF2
//    base is expanded with HKDF-SHA256 under a per-purpose info string
//    (`accountexpress:crypto:v2:<purpose>`). A future HMAC/session purpose
//    therefore cannot be turned into an AES key or vice versa.
//  - New payloads are tagged with a version prefix so readers never have to
//    guess which key a value was sealed with.
//  - Derived keys are memoized per (secret, purpose): the 100k-iteration
//    PBKDF2 step runs at most once per process, not once per call.
const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

const KEY_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;
/** Salt of the legacy (v1) derivation. Kept verbatim: existing ciphertexts. */
const LEGACY_SALT = 'crypto-key-salt';

/** Envelope tag of the domain-separated format written by this module. */
const ENVELOPE_V2 = 'v2';
const INFO_PREFIX = 'accountexpress:crypto:v2:';

/** Distinct derivation purposes. Never reuse a purpose across algorithms. */
export type KeyPurpose = 'enc' | 'hmac';
const PURPOSE_INFO: Record<KeyPurpose, string> = {
  enc: `${INFO_PREFIX}enc`,
  hmac: `${INFO_PREFIX}hmac`,
};

// Module-level memo: `${secret}|${purpose}` -> pending/derived CryptoKey.
const purposeKeyCache = new Map<string, Promise<CryptoKey>>();
let legacyKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET environment variable is required. ' +
      'Set it in .env.local (development) or your deployment environment (production).',
    );
  }
  return secret;
}

function cacheKey(secret: string, purpose: KeyPurpose): string {
  return `${secret}|${purpose}`;
}

/** Legacy (v1) AES key — PBKDF2 only, exactly as existing ciphertexts expect. */
async function getLegacyKey(secret: string): Promise<CryptoKey> {
  if (legacyKeyCache?.secret === secret) return legacyKeyCache.key;
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(LEGACY_SALT),
      iterations: KEY_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
  legacyKeyCache = { secret, key };
  return key;
}

/**
 * Domain-separated key for `purpose`.
 *
 * One PBKDF2 expansion produces the base bits; HKDF-SHA256 then derives an
 * independent key per purpose. Both steps are memoized: concurrent callers
 * share the same pending promise.
 */
async function getPurposeKey(secret: string, purpose: KeyPurpose): Promise<CryptoKey> {
  const memoKey = cacheKey(secret, purpose);
  const cached = purposeKeyCache.get(memoKey);
  if (cached) return cached;

  const pending = (async () => {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const baseBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: encoder.encode(LEGACY_SALT),
        iterations: KEY_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      KEY_LENGTH_BITS,
    );
    const hkdfKey = await crypto.subtle.importKey('raw', baseBits, 'HKDF', false, ['deriveBits']);
    const purposeBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(LEGACY_SALT),
        info: encoder.encode(PURPOSE_INFO[purpose]),
      },
      hkdfKey,
      KEY_LENGTH_BITS,
    );
    return crypto.subtle.importKey('raw', purposeBits, { name: ALGORITHM, length: KEY_LENGTH_BITS }, false, [
      'encrypt',
      'decrypt',
    ]);
  })();

  purposeKeyCache.set(memoKey, pending);
  // A failed derivation must not poison the cache for later calls.
  pending.catch(() => purposeKeyCache.delete(memoKey));
  return pending;
}

/**
 * Derive a key for a non-AES purpose (e.g. an HMAC/session subkey) from the
 * same secret with a distinct info string. Exposed so callers never hand-roll
 * a second derivation of SESSION_SECRET.
 */
export async function derivePurposeKeyMaterial(purpose: KeyPurpose): Promise<CryptoKey> {
  return getPurposeKey(getSecret(), purpose);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  // Odd-length or non-hex input yields NaN bytes, which Web Crypto rejects.
  return Uint8Array.from(hex.match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) ?? []);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

async function decryptWith(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<string> {
  // Copy into plain ArrayBuffer-backed views: Web Crypto rejects views that may
  // alias a SharedArrayBuffer.
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: new Uint8Array(iv) },
    key,
    new Uint8Array(data),
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * Seal `plaintext` into the domain-separated envelope:
 * `v2:<ivHex>:<base64(ciphertext||gcmTag)>`.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getPurposeKey(getSecret(), 'enc');
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoder.encode(plaintext));
  // Note: AES-GCM tag in Web Crypto is appended to ciphertext.
  return `${ENVELOPE_V2}:${toHex(iv)}:${Buffer.from(new Uint8Array(encrypted)).toString('base64')}`;
}

/**
 * Open any payload this module (or the pre-v2 scheme) ever produced:
 *  - `v2:ivHex:base64`        → domain-separated key (current writer)
 *  - `ivHex:tagHex:hex`       → legacy 3-part Node-crypto envelope
 *  - `ivHex:base64`           → legacy 2-part envelope (also backup sealing)
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const secret = getSecret();
  const parts = ciphertext.split(':');

  if (parts.length === 3 && parts[0] === ENVELOPE_V2) {
    const key = await getPurposeKey(secret, 'enc');
    return decryptWith(key, fromHex(parts[1]!), fromBase64(parts[2]!));
  }

  if (parts.length === 3) {
    // Legacy format: ivHex:tagHex:encryptedHex (Node crypto AES-256-GCM)
    const key = await getLegacyKey(secret);
    // Web Crypto AES-GCM expects tag appended to ciphertext
    const encrypted = fromHex(parts[2]! + parts[1]!);
    return decryptWith(key, fromHex(parts[0]!), encrypted);
  }

  if (parts.length === 2) {
    // Legacy format: ivHex:base64(ciphertext+tag)
    const key = await getLegacyKey(secret);
    return decryptWith(key, fromHex(parts[0]!), fromBase64(parts[1]!));
  }

  throw new Error('Invalid encrypted format');
}

/** Test/diagnostic hook: number of memoized derived keys (never derived secrets). */
export function derivedKeyCacheSize(): number {
  return purposeKeyCache.size + (legacyKeyCache ? 1 : 0);
}

/** Test/diagnostic hook: drop memoized keys (e.g. after rotating SESSION_SECRET). */
export function clearDerivedKeyCache(): void {
  purposeKeyCache.clear();
  legacyKeyCache = null;
}

export { ENVELOPE_V2, TAG_LENGTH as CRYPTO_TAG_LENGTH };
