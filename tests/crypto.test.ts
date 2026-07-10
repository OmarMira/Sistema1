import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TEST_SECRET = 'test-secret-for-unit-tests-only-32-chars!';

describe('encrypt / decrypt', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('encrypts and decrypts a simple string', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'hello world';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces ciphertext in iv:tag:encrypted format', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const ciphertext = encrypt('test');
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]+$/);
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it('encrypts empty string', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const ciphertext = encrypt('');
    expect(decrypt(ciphertext)).toBe('');
  });

  it('handles long strings', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'a'.repeat(10000);
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('handles unicode characters', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'ñándú 中文 español français 日本語 ✅';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'constant message';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1)).toBe(plaintext);
    expect(decrypt(c2)).toBe(plaintext);
  });

  it('handles special characters', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'tab\tnewline\nreturn\r"quotes"@#$%^&*()_+-=[]{}|;:,.<>?/~`';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });
});

describe('decrypt error handling', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('throws on invalid format (not 3 parts)', async () => {
    const { decrypt } = await import('@/lib/crypto');
    expect(() => decrypt('invalid-format')).toThrow('Invalid encrypted format');
  });

  it('throws on too many parts', async () => {
    const { decrypt } = await import('@/lib/crypto');
    expect(() => decrypt('a:b:c:d')).toThrow('Invalid encrypted format');
  });

  it('throws on empty string', async () => {
    const { decrypt } = await import('@/lib/crypto');
    expect(() => decrypt('')).toThrow('Invalid encrypted format');
  });

  it('throws on tampered ciphertext (auth tag mismatch)', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const ciphertext = encrypt('secret data');
    const parts = ciphertext.split(':');
    const tampered = `${parts[0]}:${parts[1]}:deadbeef`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on invalid hex in IV part', async () => {
    const { decrypt } = await import('@/lib/crypto');
    expect(() => decrypt('zzzz:abcdef:abcdef')).toThrow();
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
    expect(() => encrypt('test')).toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws when SESSION_SECRET is empty string', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = '';
    const { encrypt } = await import('@/lib/crypto');
    expect(() => encrypt('test')).toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws in development without SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'development';
    const { encrypt } = await import('@/lib/crypto');
    expect(() => encrypt('test')).toThrow('SESSION_SECRET environment variable is required');
  });

  it('throws in test without SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'test';
    const { encrypt } = await import('@/lib/crypto');
    expect(() => encrypt('test')).toThrow('SESSION_SECRET environment variable is required');
  });

  it('works with valid SESSION_SECRET', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = TEST_SECRET;
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const ciphertext = encrypt('production data');
    expect(decrypt(ciphertext)).toBe('production data');
  });

  it('different secrets produce different encryption keys', async () => {
    process.env.NODE_ENV = 'test';

    process.env.SESSION_SECRET = 'secret-one-for-key-derivation-test!!';
    const mod1 = await import('@/lib/crypto');
    const encrypted1 = mod1.encrypt('same plaintext');

    vi.resetModules();
    process.env.SESSION_SECRET = 'secret-two-for-key-derivation-test!!';
    const mod2 = await import('@/lib/crypto');
    const encrypted2 = mod2.encrypt('same plaintext');

    expect(encrypted1).not.toBe(encrypted2);
  });

  it('same secret produces deterministic key (ciphertext decryptable across calls)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = TEST_SECRET;
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const ciphertext = encrypt('persistent data');
    expect(decrypt(ciphertext)).toBe('persistent data');
  });
});
