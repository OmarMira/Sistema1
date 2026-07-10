import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SECRET_A = 'secret-a-for-encrypting-test-data-32ch!';
const SECRET_B = 'secret-b-different-from-a-test-32ch!!';
const TEST_API_KEY = 'sk-test-api-key-1234567890abcdef';

// Mock DB storage
const mockDbStore: Record<string, string> = {};

vi.mock('@/lib/db', () => ({
  db: {
    systemConfig: {
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) => {
        const value = mockDbStore[key];
        return value ? { key, value } : null;
      }),
      upsert: vi.fn(async ({ where: { key }, create }: { where: { key: string }; create: { key: string; value: string } }) => {
        mockDbStore[key] = create.value;
        return { key, value: create.value };
      }),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ai-config decrypt failure', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.SESSION_SECRET = SECRET_A;
    process.env.NODE_ENV = 'test';
    // Clear mock DB
    for (const key of Object.keys(mockDbStore)) {
      delete mockDbStore[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws recovery message when decrypt fails (different SESSION_SECRET)', async () => {
    // Step 1: Encrypt with SECRET_A
    const { encrypt } = await import('@/lib/crypto');
    const encryptedKey = encrypt(TEST_API_KEY);

    // Step 2: Store in mock DB
    mockDbStore['ai_encrypted_key'] = encryptedKey;
    mockDbStore['ai_model'] = 'gpt-4o';
    mockDbStore['ai_base_url'] = 'https://api.openai.com/v1';

    // Step 3: Reset modules and change SESSION_SECRET to SECRET_B
    vi.resetModules();
    process.env.SESSION_SECRET = SECRET_B;

    // Step 4: Import getAiConfig with different secret
    const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
    clearAiConfigCache();

    // Step 5: Should throw with recovery message
    await expect(getAiConfig()).rejects.toThrow(
      'Could not decrypt the stored AI API key'
    );
  });

  it('error message does not expose the API key', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const encryptedKey = encrypt(TEST_API_KEY);

    mockDbStore['ai_encrypted_key'] = encryptedKey;
    mockDbStore['ai_model'] = 'gpt-4o';
    mockDbStore['ai_base_url'] = 'https://api.openai.com/v1';

    vi.resetModules();
    process.env.SESSION_SECRET = SECRET_B;

    const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
    clearAiConfigCache();

    try {
      await getAiConfig();
      expect.fail('Should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Must NOT contain the actual API key
      expect(message).not.toContain(TEST_API_KEY);
      // Must NOT contain the prefix we use in logs
      expect(message).not.toContain('sk-test');
    }
  });

  it('error message does not expose the ciphertext', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const encryptedKey = encrypt(TEST_API_KEY);

    mockDbStore['ai_encrypted_key'] = encryptedKey;
    mockDbStore['ai_model'] = 'gpt-4o';
    mockDbStore['ai_base_url'] = 'https://api.openai.com/v1';

    vi.resetModules();
    process.env.SESSION_SECRET = SECRET_B;

    const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
    clearAiConfigCache();

    try {
      await getAiConfig();
      expect.fail('Should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Must NOT contain the ciphertext (iv:tag:encrypted format)
      expect(message).not.toContain(encryptedKey);
    }
  });

  it('suggests re-saving configuration', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const encryptedKey = encrypt(TEST_API_KEY);

    mockDbStore['ai_encrypted_key'] = encryptedKey;
    mockDbStore['ai_model'] = 'gpt-4o';
    mockDbStore['ai_base_url'] = 'https://api.openai.com/v1';

    vi.resetModules();
    process.env.SESSION_SECRET = SECRET_B;

    const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
    clearAiConfigCache();

    try {
      await getAiConfig();
      expect.fail('Should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Should suggest recovery action
      expect(message).toContain('Re-save your AI configuration');
      expect(message).toContain('/api/config/ai');
    }
  });

  it('works correctly with matching SESSION_SECRET', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const encryptedKey = encrypt(TEST_API_KEY);

    mockDbStore['ai_encrypted_key'] = encryptedKey;
    mockDbStore['ai_model'] = 'gpt-4o';
    mockDbStore['ai_base_url'] = 'https://api.openai.com/v1';

    // Keep same SESSION_SECRET — no resetModules needed
    const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
    clearAiConfigCache();

    const config = await getAiConfig();
    expect(config.apiKey).toBe(TEST_API_KEY);
    expect(config.model).toBe('gpt-4o');
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
  });
});
