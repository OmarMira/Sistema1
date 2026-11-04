import { describe, expect, it } from 'vitest';
import { createCode, createRecoveryToken, codeDigest, tokenDigest } from '../../src/lib/identity/crypto';

const key = Buffer.alloc(32, 17);
describe('protected identity credentials', () => {
  it('generates six digits, including zero padding, and binds HMAC to subject, purpose and generation', () => {
    for (let i = 0; i < 50; i++) expect(createCode()).toMatch(/^\d{6}$/);
    const digest = codeDigest(key, 'subject-a', 1, '000001');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(tokenDigest('000001'));
    expect(codeDigest(key, 'subject-b', 1, '000001')).not.toBe(digest);
    expect(codeDigest(key, 'subject-a', 2, '000001')).not.toBe(digest);
    expect(codeDigest(Buffer.alloc(32, 18), 'subject-a', 1, '000001')).not.toBe(digest);
    expect(() => codeDigest(Buffer.alloc(8), 'a', 1, '000001')).toThrow();
  });
  it('uses high entropy recovery tokens and stores only digests', () => {
    const a = createRecoveryToken();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(createRecoveryToken()).not.toBe(a);
    expect(tokenDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenDigest(a)).not.toBe(a);
  });
});
