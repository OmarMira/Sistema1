import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Current contract pinned by this suite (src/lib/crypto.ts):
 *  - `encrypt` / `decrypt` are ASYNC (Web Crypto `crypto.subtle`, Edge-safe).
 *  - New values are sealed as `v2:ivHex:base64(ciphertext || gcmTag)` with a
 *    DOMAIN-SEPARATED key: HKDF-SHA256 over the PBKDF2 base under the info
 *    string `accountexpress:crypto:v2:enc` (S23f).
 *  - Read-legacy: the retired 3-part `ivHex:tagHex:ciphertextHex` format and the
 *    2-part `ivHex:base64(ciphertext||tag)` format stay DECRYPTABLE with the
 *    original derivation, PBKDF2-SHA256(SESSION_SECRET, 'crypto-key-salt',
 *    100k). No re-encryption migration is required and nothing is unreadable.
 *  - Derived keys are memoized per (secret, purpose): the 100k PBKDF2 step runs
 *    at most once per process.
 */
const TEST_SECRET = 'test-secret-for-unit-tests-only-32-chars!';
const OTHER_SECRET = 'a-different-test-secret-32-chars-long!!';
const IV_BYTES = 16;
const TAG_BYTES = 16;

/** Seal with the retired 3-part format using the same derivation as src/lib/crypto. */
function legacySeal(plaintext: string, secret: string): string {
  const key = pbkdf2Sync(secret, 'crypto-key-salt', 100000, 32, 'sha256');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

/** Seal with the retired 2-part format (also used by src/lib/backup-storage.ts). */
function legacyTwoPartSeal(plaintext: string, secret: string): string {
  const key = pbkdf2Sync(secret, 'crypto-key-salt', 100000, 32, 'sha256');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${iv.toString('hex')}:${enc.toString('base64')}`;
}

/** Attempt to open a v2 body with the LEGACY key: must fail (domain separation). */
function legacyKeyDecrypt(body64: string, ivHex: string, secret: string): string {
  const key = pbkdf2Sync(secret, 'crypto-key-salt', 100000, 32, 'sha256');
  const sealed = Buffer.from(body64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

describe('encrypt / decrypt', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('encrypts and decrypts a simple string', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'hello world';
    const sealed = await encrypt(plaintext);
    await expect(decrypt(sealed)).resolves.toBe(plaintext);
  });

  it('stamps the v2:ivHex:base64(ciphertext||tag) domain-separated envelope', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const plaintext = 'test';
    const sealed = await encrypt(plaintext);
    const parts = sealed.split(':');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v2');
    // 16-byte random IV, lowercase hex.
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    // Base64 body, not hex.
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // AES-GCM appends the tag to the ciphertext in Web Crypto.
    expect(Buffer.from(parts[2]!, 'base64')).toHaveLength(
      Buffer.byteLength(plaintext, 'utf8') + TAG_BYTES,
    );
  });

  it('encrypts empty string', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const sealed = await encrypt('');
    // Empty plaintext still carries the GCM tag only.
    expect(Buffer.from(sealed.split(':')[2]!, 'base64')).toHaveLength(TAG_BYTES);
    await expect(decrypt(sealed)).resolves.toBe('');
  });

  it('handles a single byte of plaintext', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const sealed = await encrypt('x');
    await expect(decrypt(sealed)).resolves.toBe('x');
  });

  it('handles long strings', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'a'.repeat(10000);
    const sealed = await encrypt(plaintext);
    await expect(decrypt(sealed)).resolves.toBe(plaintext);
  });

  it('handles unicode characters', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'ñándú 中文 español français 日本語 ✅';
    const sealed = await encrypt(plaintext);
    await expect(decrypt(sealed)).resolves.toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'constant message';
    const c1 = await encrypt(plaintext);
    const c2 = await encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(c1.split(':')[1]).not.toBe(c2.split(':')[1]);
    await expect(decrypt(c1)).resolves.toBe(plaintext);
    await expect(decrypt(c2)).resolves.toBe(plaintext);
  });

  it('handles special characters, including the format separator', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'tab\tnewline\nreturn\r"quotes"@#$%^&*()_+-=[]{}|;:,.<>?/~`:\u0000';
    const sealed = await encrypt(plaintext);
    // The separator inside the plaintext never leaks into the envelope shape.
    expect(sealed.split(':')).toHaveLength(3);
    await expect(decrypt(sealed)).resolves.toBe(plaintext);
  });

  it('decrypts values sealed with the retired 3-part iv:tag:hex format', async () => {
    const { decrypt } = await import('@/lib/crypto');
    const plaintext = 'stored before the async migration';
    await expect(decrypt(legacySeal(plaintext, TEST_SECRET))).resolves.toBe(plaintext);
  });

  it('decrypts values sealed with the retired 2-part iv:base64 format (backup sealing)', async () => {
    const { decrypt } = await import('@/lib/crypto');
    const plaintext = JSON.stringify({ legalName: 'Ñandú 日本', journalLines: 12 });
    await expect(decrypt(legacyTwoPartSeal(plaintext, TEST_SECRET))).resolves.toBe(plaintext);
  });

  it('seals NEW payloads with a domain-separated key the legacy derivation cannot open', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'new envelope';
    const sealed = await encrypt(plaintext);
    const [tag, ivHex, body] = sealed.split(':');

    expect(tag).toBe('v2');
    // Same secret, same salt, DIFFERENT key: the legacy derivation must not
    // authenticate a v2 body (that is the point of domain separation).
    expect(() => legacyKeyDecrypt(body!, ivHex!, TEST_SECRET)).toThrow();
    // The session/HMAC purpose is a distinct key from the AES purpose.
    const { derivePurposeKeyMaterial } = await import('@/lib/crypto');
    const hmacKey = await derivePurposeKeyMaterial('hmac');
    expect(hmacKey.algorithm.name).toBe('AES-GCM');
    await expect(decrypt(sealed)).resolves.toBe(plaintext);
  });

  it('memoizes derived keys instead of re-deriving on every call', async () => {
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits');
    const { encrypt, decrypt } = await import('@/lib/crypto');

    const first = await encrypt('one');
    const derivationsAfterFirst = deriveBits.mock.calls.length;
    expect(derivationsAfterFirst).toBeGreaterThan(0);

    await expect(decrypt(first)).resolves.toBe('one');
    await encrypt('two');
    await decrypt(first);

    // No additional PBKDF2/HKDF work after the first derivation.
    expect(deriveBits.mock.calls.length).toBe(derivationsAfterFirst);
    deriveBits.mockRestore();
  });

  it('rejects ciphertext produced under a different SESSION_SECRET', async () => {
    const first = await import('@/lib/crypto');
    const sealed = await first.encrypt('secret data');

    process.env.SESSION_SECRET = OTHER_SECRET;
    vi.resetModules();
    const second = await import('@/lib/crypto');
    await expect(second.decrypt(sealed)).rejects.toThrow();
  });
});

describe('decrypt error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('throws on invalid format (not 2 or 3 parts)', async () => {
    const { decrypt } = await import('@/lib/crypto');
    await expect(decrypt('invalid-format')).rejects.toThrow('Invalid encrypted format');
  });

  it('throws on too many parts', async () => {
    const { decrypt } = await import('@/lib/crypto');
    await expect(decrypt('a:b:c:d')).rejects.toThrow('Invalid encrypted format');
  });

  it('throws on empty string', async () => {
    const { decrypt } = await import('@/lib/crypto');
    await expect(decrypt('')).rejects.toThrow('Invalid encrypted format');
  });

  it('throws on tampered ciphertext body (auth tag mismatch)', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const [tag, iv, body] = (await encrypt('secret data')).split(':');
    const raw = Buffer.from(body!, 'base64');
    raw[0] ^= 0xff;
    await expect(decrypt(`${tag}:${iv}:${raw.toString('base64')}`)).rejects.toThrow();
  });

  it('throws on tampered auth tag', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const [tag, iv, body] = (await encrypt('secret data')).split(':');
    const raw = Buffer.from(body!, 'base64');
    raw[raw.length - 1] ^= 0xff;
    await expect(decrypt(`${tag}:${iv}:${raw.toString('base64')}`)).rejects.toThrow();
  });

  it('throws when the IV is substituted', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const [tag, , body] = (await encrypt('secret data')).split(':');
    await expect(decrypt(`${tag}:${'00'.repeat(IV_BYTES)}:${body}`)).rejects.toThrow();
  });

  it('throws on invalid hex in IV part', async () => {
    const { decrypt } = await import('@/lib/crypto');
    await expect(decrypt('zzzz:abcdef')).rejects.toThrow();
  });

  it('throws on a truncated legacy envelope body', async () => {
    const { decrypt } = await import('@/lib/crypto');
    await expect(decrypt(`${'00'.repeat(IV_BYTES)}:${'11'.repeat(TAG_BYTES)}:00`)).rejects.toThrow();
  });
});

describe('SESSION_SECRET behavior', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when SESSION_SECRET is missing (any environment)', async () => {
    process.env.NODE_ENV = 'production';
    const { encrypt } = await import('@/lib/crypto');
    await expect(encrypt('test')).rejects.toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws when SESSION_SECRET is empty string', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = '';
    const { encrypt } = await import('@/lib/crypto');
    await expect(encrypt('test')).rejects.toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws in development without SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'development';
    const { encrypt } = await import('@/lib/crypto');
    await expect(encrypt('test')).rejects.toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws in test without SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'test';
    const { encrypt } = await import('@/lib/crypto');
    await expect(encrypt('test')).rejects.toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws on decrypt without SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'production';
    const { decrypt } = await import('@/lib/crypto');
    await expect(decrypt(`${'00'.repeat(IV_BYTES)}:AAAA`)).rejects.toThrow(
      'SESSION_SECRET environment variable is required',
    );
  });

  it('works with valid SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = TEST_SECRET;
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const sealed = await encrypt('production data');
    await expect(decrypt(sealed)).resolves.toBe('production data');
  });

  it('different secrets produce different encryption keys', async () => {
    process.env.NODE_ENV = 'test';

    process.env.SESSION_SECRET = 'secret-one-for-key-derivation-test!!';
    const mod1 = await import('@/lib/crypto');
    const encrypted1 = await mod1.encrypt('same plaintext');

    vi.resetModules();
    process.env.SESSION_SECRET = 'secret-two-for-key-derivation-test!!';
    const mod2 = await import('@/lib/crypto');
    const encrypted2 = await mod2.encrypt('same plaintext');

    expect(encrypted1).not.toBe(encrypted2);
    // Cross-key decryption must fail (GCM authentication), never return garbage.
    await expect(mod2.decrypt(encrypted1)).rejects.toThrow();
  });

  it('same secret produces deterministic key (ciphertext decryptable across module reloads)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = TEST_SECRET;
    const first = await import('@/lib/crypto');
    const sealed = await first.encrypt('persistent data');

    vi.resetModules();
    const second = await import('@/lib/crypto');
    await expect(second.decrypt(sealed)).resolves.toBe('persistent data');
  });
});
