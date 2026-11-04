import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * S5 — AI masked-key overwrite.
 *
 * The settings tab keeps the masked key returned by GET /api/config/ai in form
 * state and POSTs it back on save. Because POST /api/config/ai/verify answers
 * `success: true + warning` on HTTP 429, a masked placeholder used to be
 * encrypted over the real key, destroying it permanently. These tests pin the
 * guard on both the pure helpers and the routes (no real DB, no real network).
 */

const RAW_STORED_KEY = 'sk-or-v1-0123456789abcdefSTORE';
// first4 + '...' + last4 of RAW_STORED_KEY — exactly what the UI echoes back.
const ECHOED_MASKED_KEY = 'sk-o...TORE';
const NEW_KEY = 'sk-or-v1-ffffffffffffffffNEWK';

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockDbStore: Record<string, string> = {};

vi.mock('@/lib/db', () => ({
  db: {
    systemConfig: {
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) => {
        const value = mockDbStore[key];
        return value ? { key, value } : null;
      }),
      upsert: vi.fn(
        async ({ create }: { where: { key: string }; create: { key: string; value: string } }) => {
          mockDbStore[create.key] = create.value;
          return create;
        },
      ),
    },
    bankProfile: { upsert: vi.fn(async () => ({})) },
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

vi.mock('@/lib/security/safe-fetch', () => ({
  safeFetch: vi.fn(),
}));

// Real AES round-trip so "the stored key was not rewritten" is observable.
const REAL_KEY = 'test-secret-that-is-exactly-32-bytes!!';
vi.mock('@/lib/crypto', async () => {
  const { scryptSync, randomBytes, createCipheriv, createDecipheriv } = await import('crypto');
  const ALGORITHM = 'aes-256-gcm';
  const IV_LENGTH = 16;

  return {
    encrypt(plaintext: string): string {
      const key = scryptSync(REAL_KEY, 'crypto-key-salt', 32);
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
    },
    decrypt(ciphertext: string): string {
      const parts = ciphertext.split(':');
      if (parts.length !== 3) throw new Error('Invalid encrypted format');
      const key = scryptSync(REAL_KEY, 'crypto-key-salt', 32);
      const iv = Buffer.from(parts[0], 'hex');
      const tag = Buffer.from(parts[1], 'hex');
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(parts[2], 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    },
  };
});

import { POST as configPOST, GET as configGET } from '@/app/api/config/ai/route';
import { POST as verifyPOST } from '@/app/api/config/ai/verify/route';
import {
  clearAiConfigCache,
  getAiConfig,
  isMaskedKeyPayload,
  maskAiApiKey,
  setAiConfig,
} from '@/lib/ai-config';
import { safeFetch } from '@/lib/security/safe-fetch';

const safeFetchMock = vi.mocked(safeFetch);
const ADD_KEY = 'ai_encrypted_key';

const originalEnv = process.env;

function storedCiphertext(): string | undefined {
  return mockDbStore[ADD_KEY];
}

function postConfig(body: Record<string, unknown>) {
  return configPOST(
    new Request('http://localhost/api/config/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    {} as never,
  );
}

function postVerify(body: Record<string, unknown>) {
  return verifyPOST(
    new Request('http://localhost/api/config/ai/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    {} as never,
  );
}

async function seedStoredConfig(apiKey = RAW_STORED_KEY) {
  await setAiConfig({
    apiKey,
    model: 'openrouter/free',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  clearAiConfigCache();
}

beforeEach(() => {
  Object.keys(mockDbStore).forEach((key) => delete mockDbStore[key]);
  vi.clearAllMocks();
  clearAiConfigCache();
  process.env = { ...originalEnv };
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.AI_BASE_URL;
});

afterEach(() => {
  process.env = originalEnv;
  clearAiConfigCache();
});

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe('masked-key helpers', () => {
  it('builds exactly the mask GET /api/config/ai returns', async () => {
    expect(maskAiApiKey(RAW_STORED_KEY)).toBe(ECHOED_MASKED_KEY);

    await seedStoredConfig();
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    const res = await configGET(new Request('http://localhost/api/config/ai') as never, {} as never);
    const body = await res.json();

    expect(body.apiKey).toBe(ECHOED_MASKED_KEY);
    expect(isMaskedKeyPayload(body.apiKey)).toBe(true);
  });

  it('collapses short and empty keys to the placeholder', () => {
    expect(maskAiApiKey('')).toBe('...');
    expect(maskAiApiKey('sk-1234')).toBe('...');
    expect(isMaskedKeyPayload('...')).toBe(true);
  });

  it('recognises masked-shaped values as placeholders', () => {
    for (const value of [ECHOED_MASKED_KEY, 'abcd...wxyz', 'sk-a...bcde', '...', '  sk-o...TORE  ']) {
      expect(isMaskedKeyPayload(value)).toBe(true);
    }
  });

  it('does not mistake a real key for a placeholder', () => {
    for (const value of [
      RAW_STORED_KEY,
      NEW_KEY,
      'sk-or-v1-abc',
      'AIzaSyD-1234567890',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(isMaskedKeyPayload(value)).toBe(false);
    }
  });
});

// ─── POST /api/config/ai — masked value never overwrites ──────────────────

describe('POST /api/config/ai with the masked placeholder', () => {
  it('keeps the stored key intact and skips re-encryption', async () => {
    await seedStoredConfig();
    const ciphertextBefore = storedCiphertext();
    expect(ciphertextBefore).toBeDefined();

    const res = await postConfig({
      apiKey: ECHOED_MASKED_KEY,
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.keyUnchanged).toBe(true);
    expect(body.providerId).toBe('openrouter');

    // The encrypted row was not rewritten at all…
    expect(storedCiphertext()).toBe(ciphertextBefore);
    // …and the real key still decrypts.
    clearAiConfigCache();
    expect((await getAiConfig()).apiKey).toBe(RAW_STORED_KEY);
  });

  it('still persists model changes while keeping the stored key', async () => {
    await seedStoredConfig();
    const ciphertextBefore = storedCiphertext();

    const res = await postConfig({
      apiKey: ECHOED_MASKED_KEY,
      model: 'qwen/qwen-2.5-72b-instruct',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(200);
    expect(storedCiphertext()).toBe(ciphertextBefore);
    clearAiConfigCache();
    const after = await getAiConfig();
    expect(after.apiKey).toBe(RAW_STORED_KEY);
    expect(after.model).toBe('qwen/qwen-2.5-72b-instruct');
  });

  it('rejects the placeholder when no key is stored and persists nothing', async () => {
    const res = await postConfig({
      apiKey: ECHOED_MASKED_KEY,
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('No hay una clave de API válida guardada');
    expect(storedCiphertext()).toBeUndefined();
  });

  it('refuses to point the stored key at a different provider', async () => {
    await seedStoredConfig();
    const ciphertextBefore = storedCiphertext();

    const res = await postConfig({
      apiKey: ECHOED_MASKED_KEY,
      model: 'gpt-4o-mini',
      providerId: 'openai',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AI_KEY_REQUIRED_FOR_PROVIDER_CHANGE');
    expect(storedCiphertext()).toBe(ciphertextBefore);
    expect(mockDbStore['ai_base_url']).toBe('https://openrouter.ai/api/v1');
  });
});

// ─── POST /api/config/ai — a genuinely new key still replaces ─────────────

describe('POST /api/config/ai with a genuinely new key', () => {
  it('replaces the stored key and re-encrypts it', async () => {
    await seedStoredConfig();
    const ciphertextBefore = storedCiphertext();

    const res = await postConfig({
      apiKey: NEW_KEY,
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.keyUnchanged).toBeUndefined();
    expect(storedCiphertext()).not.toBe(ciphertextBefore);

    clearAiConfigCache();
    expect((await getAiConfig()).apiKey).toBe(NEW_KEY);
  });

  it('saves the very first key when nothing was stored', async () => {
    const res = await postConfig({
      apiKey: NEW_KEY,
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(200);
    clearAiConfigCache();
    expect((await getAiConfig()).apiKey).toBe(NEW_KEY);
  });
});

// ─── PRESERVE: behaviour of the same route that the guard must not disturb ──

describe('POST /api/config/ai — unchanged validation contract', () => {
  it('still rejects an empty key with 400 and persists nothing', async () => {
    const res = await postConfig({ apiKey: '', providerId: 'openrouter' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('La clave no puede estar vacía');
    expect(storedCiphertext()).toBeUndefined();
  });

  it('still rejects an arbitrary baseUrl with 400 and persists nothing', async () => {
    const res = await postConfig({ apiKey: NEW_KEY, baseUrl: 'https://public.example.com' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AI_PROVIDER_RECONFIGURATION_REQUIRED');
    expect(storedCiphertext()).toBeUndefined();
  });
});

// ─── POST /api/config/ai/verify — the 429 hole is closed for placeholders ──

describe('POST /api/config/ai/verify with the masked placeholder', () => {
  it('rejects the placeholder without contacting the provider', async () => {
    await seedStoredConfig();

    const res = await postVerify({
      apiKey: ECHOED_MASKED_KEY,
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AI_API_KEY_MASKED');
    expect(body.success).toBeUndefined();
    expect(body.warning).toBeUndefined();
    // The masked value is never used for egress: no chance to see a 429 that
    // would come back as success-with-warning.
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('still reports success-with-warning on HTTP 429 for a real key', async () => {
    safeFetchMock.mockResolvedValue({ status: 429 } as never);

    const res = await postVerify({
      apiKey: NEW_KEY,
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.warning).toContain('Rate Limit');
  });

  it('still rejects an invalid real key with 401', async () => {
    safeFetchMock.mockResolvedValue({ status: 401 } as never);

    const res = await postVerify({
      apiKey: 'sk-or-v1-not-a-valid-key-0000',
      model: 'openrouter/free',
      providerId: 'openrouter',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('API Key inválida o sin permisos.');
  });
});
