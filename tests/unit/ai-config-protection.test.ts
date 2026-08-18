import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockDb: Record<string, { key: string; value: string }[]> = {};

vi.mock('@/lib/db', () => ({
  db: {
    systemConfig: {
      findUnique: vi.fn(({ where: { key } }: { where: { key: string } }) => {
        const rows = mockDb.systemConfig ?? [];
        return Promise.resolve(rows.find((r) => r.key === key) ?? null);
      }),
      upsert: vi.fn(
        ({ where: { key }, create }: { where: { key: string }; create: { key: string; value: string } }) => {
          if (!mockDb.systemConfig) mockDb.systemConfig = [];
          const idx = mockDb.systemConfig.findIndex((r) => r.key === key);
          if (idx >= 0) {
            mockDb.systemConfig[idx] = create;
          } else {
            mockDb.systemConfig.push(create);
          }
          return Promise.resolve(create);
        },
      ),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/context-storage', () => ({
  requireCurrentUserId: () => 'user-test-1',
}));

vi.mock('@/lib/rbac', () => ({
  requireGlobalAdminRole: async () => undefined,
}));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (req: unknown, ctx: unknown) => Promise<unknown>) =>
    async (req: unknown, ctx: unknown) => handler(req, ctx),
}));

// Full crypto mock that actually encrypts/decrypts consistently
const REAL_KEY = 'test-secret-that-is-exactly-32-bytes!!';
vi.mock('@/lib/crypto', async () => {
  const {
    scryptSync,
    randomBytes,
    createCipheriv,
    createDecipheriv,
  } = await import('crypto');
  const ALGORITHM = 'aes-256-gcm';
  const IV_LENGTH = 16;

  function encrypt(plaintext: string): string {
    const key = scryptSync(REAL_KEY, 'crypto-key-salt', 32);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  }

  function decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const key = scryptSync(REAL_KEY, 'crypto-key-salt', 32);
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    if (tag.length !== 16) throw new Error('Invalid auth tag length');
    const encrypted = parts[2];
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  return { encrypt, decrypt };
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AI Config Protection', () => {
  beforeEach(() => {
    mockDb.systemConfig = [];
    vi.clearAllMocks();
  });

  describe('setAiConfig validation', () => {
    it('rejects empty apiKey', async () => {
      const { setAiConfig } = await import('@/lib/ai-config');
      await expect(setAiConfig({ apiKey: '' })).rejects.toThrow('at least 8 characters');
    });

    it('rejects whitespace-only apiKey', async () => {
      const { setAiConfig } = await import('@/lib/ai-config');
      await expect(setAiConfig({ apiKey: '   ' })).rejects.toThrow('at least 8 characters');
    });

    it('rejects apiKey shorter than 8 characters', async () => {
      const { setAiConfig } = await import('@/lib/ai-config');
      await expect(setAiConfig({ apiKey: 'short' })).rejects.toThrow('at least 8 characters');
    });

    it('accepts valid apiKey and stores encrypted', async () => {
      const { setAiConfig, getAiConfig } = await import('@/lib/ai-config');
      await setAiConfig({ apiKey: 'sk-valid-key-12345' });

      const stored = mockDb.systemConfig?.find((r) => r.key === 'ai_encrypted_key');
      expect(stored).toBeDefined();
      expect(stored!.value).toContain(':'); // encrypted format iv:tag:data

      const config = await getAiConfig();
      expect(config.apiKey).toBe('sk-valid-key-12345');
    });
  });

  describe('full-write semantics (setAiConfig always writes all three fields)', () => {
    it('re-saving same apiKey with different baseUrl updates only baseUrl', async () => {
      const { setAiConfig, getAiConfig } = await import('@/lib/ai-config');
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://api.deepseek.com/v1' });

      const originalKey = (await getAiConfig()).apiKey;

      const { clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      await setAiConfig({ apiKey: 'sk-valid-key-12345', baseUrl: 'https://api.anthropic.com/v1' });

      const after = await getAiConfig();
      expect(after.apiKey).toBe(originalKey);
      expect(after.baseUrl).toBe('https://api.anthropic.com/v1');
    });

    it('re-saving same apiKey with different model updates only model', async () => {
      const { setAiConfig, getAiConfig } = await import('@/lib/ai-config');
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://openrouter.ai/api/v1' });

      const { clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-5', baseUrl: 'https://openrouter.ai/api/v1' });

      const after = await getAiConfig();
      expect(after.apiKey).toBe('sk-valid-key-12345');
      expect(after.model).toBe('gpt-5');
    });
  });

  describe('backup restore safety', () => {
    it('backup restore skips ai_encrypted_key', async () => {
      const { db } = await import('@/lib/db');

      await db.systemConfig.upsert({
        where: { key: 'ai_encrypted_key' },
        create: { key: 'ai_encrypted_key', value: 'should-not-be-overwritten' },
        update: { value: 'should-not-be-overwritten' },
      });

      const systemConfigData = [
        { key: 'ai_encrypted_key', value: 'old-backup-value' },
        { key: 'some_other_key', value: 'other-value' },
      ];

      const AI_CONFIG_KEYS = new Set(['ai_encrypted_key', 'ai_model', 'ai_base_url']);
      const filtered = systemConfigData.filter(
        (c: { key?: string }) => !AI_CONFIG_KEYS.has(c.key ?? ''),
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0].key).toBe('some_other_key');
    });
  });

  describe('backup export excludes AI keys', () => {
    it('AI_CONFIG.STORAGE_KEYS_SET contains the expected keys', async () => {
      const { AI_CONFIG } = await import('@/lib/constants/ai-config');
      expect(AI_CONFIG.STORAGE_KEYS_SET.has('ai_encrypted_key')).toBe(true);
      expect(AI_CONFIG.STORAGE_KEYS_SET.has('ai_model')).toBe(true);
      expect(AI_CONFIG.STORAGE_KEYS_SET.has('ai_base_url')).toBe(true);
      expect(AI_CONFIG.STORAGE_KEYS_SET.size).toBe(3);
    });

    it('filterSensitiveSystemConfig removes all AI storage keys', async () => {
      const { filterSensitiveSystemConfig } = await import('@/lib/backup');
      const result = filterSensitiveSystemConfig([
        { key: 'ai_encrypted_key', value: 'secret' },
        { key: 'ai_model', value: 'gpt-4' },
        { key: 'ai_base_url', value: 'https://url.com' },
        { key: 'some_other_key', value: 'keep' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('some_other_key');
    });

    it('filterSensitiveSystemConfig preserves non-AI keys unchanged', async () => {
      const { filterSensitiveSystemConfig } = await import('@/lib/backup');
      const result = filterSensitiveSystemConfig([
        { key: 'ai_encrypted_key', value: 'secret' },
        { key: 'my_setting', value: 'hello' },
        { key: 'another_config', value: 'world' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('my_setting');
      expect(result[1].key).toBe('another_config');
    });

    it('filterSensitiveSystemConfig handles empty input', async () => {
      const { filterSensitiveSystemConfig } = await import('@/lib/backup');
      expect(filterSensitiveSystemConfig([])).toHaveLength(0);
    });

    it('filterSensitiveSystemConfig tolerates entries without key field', async () => {
      const { filterSensitiveSystemConfig } = await import('@/lib/backup');
      const result = filterSensitiveSystemConfig([
        { value: 'no-key-field' },
        { key: 'ai_encrypted_key', value: 'secret' },
        { key: 'normal_key', value: 'ok' },
      ]);
      expect(result).toHaveLength(2);
    });
  });

  describe('checkAiConfigIntegrity', () => {
    it('returns MISSING when no config in DB', async () => {
      mockDb.systemConfig = [];
      const { checkAiConfigIntegrity, clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      const result = await checkAiConfigIntegrity();
      expect(result.code).toBe('AI_CONFIG_MISSING');
    });

    it('returns CORRUPTED when encrypted data is invalid', async () => {
      mockDb.systemConfig = [
        { key: 'ai_encrypted_key', value: 'not-valid-hex:not-valid-tag:deadbeef' },
        { key: 'ai_model', value: 'test-model' },
        { key: 'ai_base_url', value: 'https://test.url' },
      ];
      const { checkAiConfigIntegrity, clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      const result = await checkAiConfigIntegrity();
      expect(result.code).toBe('AI_CONFIG_CORRUPTED');
    });

    it('returns OK when config is valid', async () => {
      const { setAiConfig, clearAiConfigCache, checkAiConfigIntegrity } = await import('@/lib/ai-config');
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://openrouter.ai/api/v1' });
      clearAiConfigCache();
      const result = await checkAiConfigIntegrity();
      expect(result.code).toBe('AI_CONFIG_OK');
    });
  });

  describe('getAiConfig error handling', () => {
    it('fails with clear error when encrypted data is invalid', async () => {
      mockDb.systemConfig = [
        { key: 'ai_encrypted_key', value: 'not-valid-hex:not-valid-tag:deadbeef' },
        { key: 'ai_model', value: 'test-model' },
        { key: 'ai_base_url', value: 'https://test.url' },
      ];

      const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      await expect(getAiConfig()).rejects.toThrow(
        /could not decrypt|SESSION_SECRET|corrupted/i,
      );
    });
  });

  describe('config/ai GET does not log API key fragments', () => {
    it('does not log keyPrefix or apiKey fragments', async () => {
      const loggerMock = (await import('@/lib/logger')).logger as {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      };

      mockDb.systemConfig = [];

      const { setAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://openrouter.ai/api/v1' });
      clearAiConfigCache();

      const { GET } = await import('@/app/api/config/ai/route');

      const res = await GET(new Request('http://localhost/api/config/ai') as never, {} as never);
      const body = await res.json();

      const calls = loggerMock.info.mock.calls.map((c) => JSON.stringify(c));
      for (const call of calls) {
        expect(call).not.toContain('keyPrefix');
        expect(call).not.toMatch(/slice\(0,\s*6\)/);
        expect(call).not.toContain('sk-valid-key-12345');
        expect(call).not.toContain('sk-va');
      }
      expect(body).not.toHaveProperty('keyPrefix');
      expect(typeof body.apiKey).toBe('string');
      expect(body.apiKey).not.toContain('sk-valid-key-12345');
    });
  });

  describe('AI provider allowlist (canonical server-side source of truth)', () => {
    describe('resolveProviderBaseUrl', () => {
      it('maps every allowed providerId to its exact canonical baseUrl', async () => {
        const { resolveProviderBaseUrl } = await import('@/lib/constants/ai-config');
        expect(resolveProviderBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1');
        expect(resolveProviderBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
        expect(resolveProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com/v1');
        expect(resolveProviderBaseUrl('openai')).toBe('https://api.openai.com/v1');
        expect(resolveProviderBaseUrl('google')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
      });

      it('rejects an unknown providerId with AI_PROVIDER_RECONFIGURATION_REQUIRED', async () => {
        const { resolveProviderBaseUrl, AiProviderReconfigurationError } = await import('@/lib/constants/ai-config');
        for (const id of ['mystery-provider', 'openrouter-extra', '']) {
          try {
            resolveProviderBaseUrl(id);
            expect.fail(`should have thrown for '${id}'`);
          } catch (err) {
            expect(err).toBeInstanceOf(AiProviderReconfigurationError);
            expect((err as AiProviderReconfigurationError).code).toBe('AI_PROVIDER_RECONFIGURATION_REQUIRED');
          }
        }
      });

      it('rejects the removed custom provider', async () => {
        const { resolveProviderBaseUrl, AiProviderReconfigurationError } = await import('@/lib/constants/ai-config');
        expect(() => resolveProviderBaseUrl('custom')).toThrow(AiProviderReconfigurationError);
      });
    });

    describe('isCanonicalAiBaseUrl', () => {
      it('accepts exactly the five canonical baseUrls', async () => {
        const { isCanonicalAiBaseUrl } = await import('@/lib/constants/ai-config');
        for (const url of [
          'https://openrouter.ai/api/v1',
          'https://api.deepseek.com/v1',
          'https://api.anthropic.com/v1',
          'https://api.openai.com/v1',
          'https://generativelanguage.googleapis.com/v1beta/openai',
        ]) {
          expect(isCanonicalAiBaseUrl(url)).toBe(true);
        }
      });

      it('rejects arbitrary, legacy and empty baseUrls', async () => {
        const { isCanonicalAiBaseUrl } = await import('@/lib/constants/ai-config');
        for (const url of [
          'https://public.example.com',
          'https://legacy.custom.example.com/v1',
          'https://openrouter.ai',
          'https://openrouter.ai/api/v1/',
          '',
          'not-a-url',
        ]) {
          expect(isCanonicalAiBaseUrl(url)).toBe(false);
        }
      });
    });

    describe('providerIdForCanonicalBaseUrl', () => {
      it('maps a canonical baseUrl back to its providerId', async () => {
        const { providerIdForCanonicalBaseUrl } = await import('@/lib/constants/ai-config');
        expect(providerIdForCanonicalBaseUrl('https://api.openai.com/v1')).toBe('openai');
        expect(providerIdForCanonicalBaseUrl('https://openrouter.ai/api/v1')).toBe('openrouter');
      });

      it('returns null for non-canonical baseUrls', async () => {
        const { providerIdForCanonicalBaseUrl } = await import('@/lib/constants/ai-config');
        expect(providerIdForCanonicalBaseUrl('https://public.example.com')).toBeNull();
        expect(providerIdForCanonicalBaseUrl('')).toBeNull();
      });
    });

    describe('read-time mapping and fail-closed for persisted configs', () => {
      it('maps a persisted canonical baseUrl to its providerId at read time', async () => {
        const { encrypt } = await import('@/lib/crypto');
        const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');

        mockDb.systemConfig = [
          { key: 'ai_encrypted_key', value: encrypt('sk-valid-key-12345') },
          { key: 'ai_model', value: 'gpt-4o-mini' },
          { key: 'ai_base_url', value: 'https://api.openai.com/v1' },
        ];
        clearAiConfigCache();

        const config = await getAiConfig();
        expect(config.providerId).toBe('openai');
        expect(config.baseUrl).toBe('https://api.openai.com/v1');
        expect(config.apiKey).toBe('sk-valid-key-12345');
      });

      it('fails closed when a persisted baseUrl is not on the allowlist', async () => {
        const { encrypt } = await import('@/lib/crypto');
        const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');
        const { AiProviderReconfigurationError } = await import('@/lib/constants/ai-config');

        mockDb.systemConfig = [
          { key: 'ai_encrypted_key', value: encrypt('sk-valid-key-12345') },
          { key: 'ai_model', value: 'legacy-model' },
          { key: 'ai_base_url', value: 'https://legacy.custom.example.com/v1' },
        ];
        clearAiConfigCache();

        await expect(getAiConfig()).rejects.toBeInstanceOf(AiProviderReconfigurationError);
      });

      it('reconfiguration error never leaks the stored API key', async () => {
        const { encrypt } = await import('@/lib/crypto');
        const { getAiConfig, clearAiConfigCache } = await import('@/lib/ai-config');

        mockDb.systemConfig = [
          { key: 'ai_encrypted_key', value: encrypt('sk-super-secret-1234567890') },
          { key: 'ai_model', value: 'legacy-model' },
          { key: 'ai_base_url', value: 'https://legacy.custom.example.com/v1' },
        ];
        clearAiConfigCache();

        try {
          await getAiConfig();
          expect.fail('should have thrown');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          expect(message).not.toContain('sk-super-secret-1234567890');
        }
      });

      it('checkAiConfigIntegrity reports RECONFIGURATION for a legacy provider', async () => {
        const { encrypt } = await import('@/lib/crypto');
        const { checkAiConfigIntegrity, clearAiConfigCache } = await import('@/lib/ai-config');

        mockDb.systemConfig = [
          { key: 'ai_encrypted_key', value: encrypt('sk-valid-key-12345') },
          { key: 'ai_model', value: 'legacy-model' },
          { key: 'ai_base_url', value: 'https://legacy.custom.example.com/v1' },
        ];
        clearAiConfigCache();

        const result = await checkAiConfigIntegrity();
        expect(result.status).toBe('RECONFIGURATION');
        expect(result.code).toBe('AI_PROVIDER_RECONFIGURATION_REQUIRED');
      });

      it('setAiConfig rejects a non-canonical baseUrl (fail closed, nothing persisted)', async () => {
        const { setAiConfig } = await import('@/lib/ai-config');
        const { AiProviderReconfigurationError } = await import('@/lib/constants/ai-config');

        await expect(
          setAiConfig({ apiKey: 'sk-valid-key-12345', baseUrl: 'https://evil.example.com' }),
        ).rejects.toBeInstanceOf(AiProviderReconfigurationError);
        expect(mockDb.systemConfig).toHaveLength(0);
      });
    });
  });
});

describe('config/ai POST — provider allowlist and no env mutation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockDb.systemConfig = [];
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.AI_API_KEY = 'env-original-key';
    delete process.env.AI_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function postConfig(body: string) {
    const { POST } = await import('@/app/api/config/ai/route');
    const req = new Request('http://localhost/api/config/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return POST(req as never, {} as never);
  }

  it('accepts a canonical providerId, persists the canonical baseUrl and does not mutate process.env', async () => {
    const res = await postConfig(
      JSON.stringify({ providerId: 'openrouter', apiKey: 'sk-valid-key-12345', model: 'openrouter/free' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerId).toBe('openrouter');
    expect(process.env.AI_API_KEY).toBe('env-original-key');
    expect(process.env.AI_MODEL).toBeUndefined();

    const storedBaseUrl = mockDb.systemConfig?.find((r) => r.key === 'ai_base_url');
    expect(storedBaseUrl?.value).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects an unknown providerId with 400 and AI_PROVIDER_RECONFIGURATION_REQUIRED', async () => {
    const res = await postConfig(
      JSON.stringify({ providerId: 'mystery-provider', apiKey: 'sk-valid-key-12345' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AI_PROVIDER_RECONFIGURATION_REQUIRED');
    expect(mockDb.systemConfig).toHaveLength(0);
  });

  it('rejects the removed custom provider with 400', async () => {
    const res = await postConfig(
      JSON.stringify({ providerId: 'custom', apiKey: 'sk-valid-key-12345' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AI_PROVIDER_RECONFIGURATION_REQUIRED');
  });

  it('rejects an arbitrary baseUrl without persisting it', async () => {
    const res = await postConfig(
      JSON.stringify({ apiKey: 'sk-valid-key-12345', baseUrl: 'https://public.example.com' }),
    );
    expect(res.status).toBe(400);
    expect(mockDb.systemConfig).toHaveLength(0);
  });

  it('accepts a legacy canonical baseUrl and maps it to the providerId', async () => {
    const res = await postConfig(
      JSON.stringify({ apiKey: 'sk-valid-key-12345', baseUrl: 'https://api.deepseek.com/v1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerId).toBe('deepseek');
  });
});
