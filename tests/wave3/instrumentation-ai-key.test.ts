import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';

/**
 * S23f — the startup AI-key decrypt failure must be loud.
 *
 * `registerNodeRuntime` used to decrypt `AI_API_KEY_ENCRYPTED` inside an empty
 * catch: a rotated SESSION_SECRET left the assistant with no key and no
 * diagnostic anywhere. The failure now logs an error with the actionable cause
 * (and the success path is unchanged).
 */

vi.mock('@sentry/nextjs', () => ({ init: vi.fn(), captureRequestError: vi.fn() }));

import { decryptAiApiKeyAtStartup } from '@/instrumentation';
import { encrypt } from '@/lib/crypto';

const SECRET = 'instrumentation-test-secret-32-chars!!';

describe('S23f — instrumentation AI key decryption', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // No module-registry reset here: the helper imports the SAME logger
    // instance this suite spies on.
    process.env.SESSION_SECRET = SECRET;
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_KEY_ENCRYPTED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('logs an error instead of swallowing a decrypt failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    process.env.AI_API_KEY_ENCRYPTED = 'v2:zz:not-a-real-payload';

    const ok = await decryptAiApiKeyAtStartup();

    expect(ok).toBe(false);
    expect(process.env.AI_API_KEY).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0]! as unknown as [string, { error: string }];
    expect(message).toContain('AI_API_KEY_ENCRYPTED');
    expect(message).toContain('SESSION_SECRET');
    expect(meta.error).toBeTruthy();
  });

  it('still populates AI_API_KEY when the sealed value is valid', async () => {
    const sealed = await encrypt('sk-live-test-key');
    process.env.AI_API_KEY_ENCRYPTED = sealed;

    const ok = await decryptAiApiKeyAtStartup();

    expect(ok).toBe(true);
    expect(process.env.AI_API_KEY).toBe('sk-live-test-key');
  });

  it('does nothing when an API key is already configured', async () => {
    process.env.AI_API_KEY = 'already-set';
    process.env.AI_API_KEY_ENCRYPTED = 'v2:zz:ignored';

    await expect(decryptAiApiKeyAtStartup()).resolves.toBe(false);
    expect(process.env.AI_API_KEY).toBe('already-set');
  });
});
