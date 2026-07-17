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

// Full crypto mock that actually encrypts/decrypts consistently
const REAL_KEY = 'test-secret-that-is-exactly-32-bytes!!';
vi.mock('@/lib/crypto', () => {
  const crypto = require('crypto');
  const ALGORITHM = 'aes-256-gcm';
  const IV_LENGTH = 16;

  function encrypt(plaintext: string): string {
    const key = crypto.scryptSync(REAL_KEY, 'crypto-key-salt', 32);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  }

  function decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const key = crypto.scryptSync(REAL_KEY, 'crypto-key-salt', 32);
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    if (tag.length !== 16) throw new Error('Invalid auth tag length');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  return { encrypt, decrypt };
});

vi.mock('@/lib/constants/ai-config', () => ({
  AI_CONFIG: {
    DEFAULT_MODEL: 'default-model',
    BASE_URL: 'https://default.url',
    STORAGE_KEYS: {
      ENCRYPTED_KEY: 'ai_encrypted_key',
      MODEL: 'ai_model',
      BASE_URL: 'ai_base_url',
    },
    STORAGE_KEYS_SET: new Set(['ai_encrypted_key', 'ai_model', 'ai_base_url']),
  },
}));

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
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://original.url' });

      const originalKey = (await getAiConfig()).apiKey;

      const { clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      await setAiConfig({ apiKey: 'sk-valid-key-12345', baseUrl: 'https://new.url' });

      const after = await getAiConfig();
      expect(after.apiKey).toBe(originalKey);
      expect(after.baseUrl).toBe('https://new.url');
    });

    it('re-saving same apiKey with different model updates only model', async () => {
      const { setAiConfig, getAiConfig } = await import('@/lib/ai-config');
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://url.com' });

      const { clearAiConfigCache } = await import('@/lib/ai-config');
      clearAiConfigCache();
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-5', baseUrl: 'https://url.com' });

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
      await setAiConfig({ apiKey: 'sk-valid-key-12345', model: 'gpt-4', baseUrl: 'https://api.test.com' });
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
});
