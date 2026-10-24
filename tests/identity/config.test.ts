import { expect, it } from 'vitest';
import { identityConfig } from '../../src/lib/identity/config';

it('is disabled by default and requires a dedicated server key only on explicit opt-in', () => {
  expect(identityConfig({})).toEqual({ enabled: false });
  expect(() => identityConfig({ IDENTITY_INFRASTRUCTURE_ENABLED: 'true' })).toThrow();
  const key = Buffer.alloc(32, 23).toString('base64');
  expect(identityConfig({ IDENTITY_INFRASTRUCTURE_ENABLED: 'true', IDENTITY_VERIFICATION_HMAC_KEY: key })).toEqual({ enabled: true, key: Buffer.alloc(32, 23) });
  expect(() => identityConfig({ IDENTITY_INFRASTRUCTURE_ENABLED: 'true', IDENTITY_VERIFICATION_HMAC_KEY: key, SESSION_SECRET: key })).toThrow();
  expect(() => identityConfig({ IDENTITY_INFRASTRUCTURE_ENABLED: 'true', IDENTITY_VERIFICATION_HMAC_KEY: key, HMAC_SECRET: key })).toThrow();
});
