import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '@/lib/crypto';

describe('encrypt / decrypt', () => {
  it('encrypts and decrypts a simple string', () => {
    const plaintext = 'hello world';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces ciphertext in iv:tag:encrypted format', () => {
    const ciphertext = encrypt('test');
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    // Each part should be valid hex
    expect(parts[0]).toMatch(/^[0-9a-f]+$/);
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it('encrypts empty string', () => {
    const ciphertext = encrypt('');
    expect(decrypt(ciphertext)).toBe('');
  });

  it('handles long strings', () => {
    const plaintext = 'a'.repeat(10000);
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('handles unicode characters', () => {
    const plaintext = 'ñándú 中文 español français 日本語 ✅';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'constant message';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
    // Both should still decrypt to the same value
    expect(decrypt(c1)).toBe(plaintext);
    expect(decrypt(c2)).toBe(plaintext);
  });

  it('handles special characters', () => {
    const plaintext = 'tab\tnewline\nreturn\r"quotes"@#$%^&*()_+-=[]{}|;:,.<>?/~`';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });
});

describe('decrypt error handling', () => {
  it('throws on invalid format (not 3 parts)', () => {
    expect(() => decrypt('invalid-format')).toThrow('Invalid encrypted format');
  });

  it('throws on too many parts', () => {
    expect(() => decrypt('a:b:c:d')).toThrow('Invalid encrypted format');
  });

  it('throws on empty string', () => {
    expect(() => decrypt('')).toThrow('Invalid encrypted format');
  });

  it('throws on tampered ciphertext (auth tag mismatch)', () => {
    const ciphertext = encrypt('secret data');
    const parts = ciphertext.split(':');
    // Tamper with the encrypted part
    const tampered = `${parts[0]}:${parts[1]}:deadbeef`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on invalid hex in IV part', () => {
    expect(() => decrypt('zzzz:abcdef:abcdef')).toThrow();
  });
});
