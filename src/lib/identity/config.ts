import type { IdentityConfig } from './contracts';

// Explicit call only: importing this module never reads or changes process.env.
export function identityConfig(env: Readonly<Record<string, string | undefined>>): IdentityConfig {
  if (env.IDENTITY_INFRASTRUCTURE_ENABLED !== 'true') return { enabled: false };
  const encoded = env.IDENTITY_VERIFICATION_HMAC_KEY;
  if (!encoded || encoded === env.SESSION_SECRET || encoded === env.HMAC_SECRET) {
    throw new Error('An independent identity verification key is required');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 32 || key.toString('base64') !== encoded) {
    throw new Error('Identity verification key must be canonical base64 with at least 32 bytes');
  }
  return { enabled: true, key };
}
