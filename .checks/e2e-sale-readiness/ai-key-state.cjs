/* T16 / S16 — read the stored AI key state without printing secret material.
 *
 * Prints: whether a row exists, the parsed envelope shape, the sha256 of the
 * decrypted plaintext (prefix), and the plaintext's mask shape (first4...last4).
 * The plaintext itself is never written to stdout.
 *
 * Usage:
 *   SESSION_SECRET=... DATABASE_URL=...?schema=public node .checks/e2e-sale-readiness/ai-key-state.cjs
 */
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const KEY_SALT = 'crypto-key-salt';
const KEY_ITERATIONS = 100000;

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required');
  return crypto.pbkdf2Sync(secret, KEY_SALT, KEY_ITERATIONS, 32, 'sha256');
}

// src/lib/crypto.ts envelope: `<ivHex>:base64(ciphertext||tag)` with the tag
// appended by Web Crypto (last 16 bytes).
function decryptEnvelope(envelope) {
  const [ivHex, b64] = String(envelope).split(':');
  if (!ivHex || !b64) throw new Error('unexpected envelope shape');
  const sealed = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!/54497\/accountexpress_test/.test(url)) throw new Error('Refusing: not the fixture DB');
  const db = new PrismaClient({ datasources: { db: { url } } });

  const rows = await db.systemConfig.findMany({
    where: { key: { in: ['ai_encrypted_key', 'ai_model', 'ai_base_url'] } },
    select: { key: true, value: true, updatedAt: true },
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  const out = {
    hasEncryptedKey: Boolean(byKey.ai_encrypted_key?.value),
    model: byKey.ai_model?.value ?? null,
    baseUrl: byKey.ai_base_url?.value ?? null,
    encryptedKeySha256OfEnvelope: byKey.ai_encrypted_key
      ? crypto.createHash('sha256').update(byKey.ai_encrypted_key.value).digest('hex').slice(0, 16)
      : null,
    encryptedKeyUpdatedAt: byKey.ai_encrypted_key?.updatedAt?.toISOString() ?? null,
  };

  if (byKey.ai_encrypted_key?.value) {
    try {
      const plaintext = decryptEnvelope(byKey.ai_encrypted_key.value);
      out.decrypted = true;
      out.plaintextSha256 = crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
      out.plaintextLength = plaintext.length;
      out.plaintextMaskShape =
        plaintext.length > 8 ? `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}` : '(too short to mask)';
      out.plaintextContainsEllipsis = /\.\.\.|…/.test(plaintext);
    } catch (error) {
      out.decrypted = false;
      out.decryptError = error instanceof Error ? error.message : String(error);
    }
  }

  await db.$disconnect();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error('AI KEY STATE FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
