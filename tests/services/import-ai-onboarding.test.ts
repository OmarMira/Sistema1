import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDERS } from '@/lib/constants/ai-config';
import { clearAiConfigCache, getAiConfig, setAiConfig } from '@/lib/ai-config';
import { createProfileFromPdf, validateRegex } from '@/lib/bank-profile-onboarding';
import profileConfig from '@/lib/bank-profiles/boa-standard.json';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  upsertProfile: vi.fn(),
  sdk: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: { systemConfig: {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
    const value = mocks.store.get(where.key);
    return value ? { value } : null;
  }),
  upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
    mocks.store.set(where.key, create.value);
  }),
} } }));
vi.mock('@/lib/logger', () => ({ logger: mocks.logger }));
vi.mock('z-ai-web-dev-sdk', () => ({ default: { create: mocks.sdk } }));
vi.mock('@/lib/bank-profile-service', () => ({
  getAllActiveProfiles: vi.fn(async () => []),
  upsertBankProfile: mocks.upsertProfile,
}));

const apiKey = 'synthetic-customer-api-key-never-real';
// S1 (Wave 5): learning is company-scoped, so every call site states the tenant.
const companyId = 'synthetic-company-scope';
const analysis = {
  fullText: 'Synthetic Bank Statement', pageWidth: 600,
  firstPageSample: 'Synthetic Bank',
  blocksWithCoordinates: [{ text: '01/01/26 Test transaction 10.00', x: 10, y: 30, width: 200, page: 1 }],
};
const generated = { bankName: 'Synthetic Bank', fingerprints: ['synthetic', 'statement', 'test bank'], config: profileConfig };
const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  clearAiConfigCache();
  vi.stubEnv('SESSION_SECRET', 'synthetic-installation-secret-at-least-32-characters');
  vi.stubEnv('AI_API_KEY', '');
  vi.stubEnv('AI_BASE_URL', 'https://openrouter.ai/api/v1');
  vi.stubGlobal('fetch', mockFetch);
  mocks.sdk.mockRejectedValue(new Error('Implicit SDK configuration must not be used'));
  mocks.upsertProfile.mockImplementation(async (bankId, bankName, fingerprints, config, requiresReview) =>
    ({ bankId, bankName, fingerprints, config, requiresReview }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearAiConfigCache(); });

describe('PDF learning uses customer configuration', () => {
  it.each(AI_PROVIDERS)('uses saved $id destination, key and exact selected model', async (provider) => {
    await setAiConfig({ apiKey, baseUrl: provider.baseUrl, model: provider.defaultModel });
    const isAnthropic = provider.id === 'anthropic';
    mockFetch.mockResolvedValue(new Response(JSON.stringify(isAnthropic
      ? { content: [{ type: 'text', text: JSON.stringify(generated) }] }
      : { choices: [{ message: { content: JSON.stringify(generated) } }] }), { status: 200 }));

    const result = await createProfileFromPdf(analysis, companyId);
    expect(result.bankName).toBe('Synthetic Bank');
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${provider.baseUrl}/${isAnthropic ? 'messages' : 'chat/completions'}`);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body).model).toBe(provider.defaultModel);
    const headers = new Headers(init.headers);
    expect(headers.get(isAnthropic ? 'x-api-key' : 'authorization')).toBe(isAnthropic ? apiKey : `Bearer ${apiKey}`);
    expect(mocks.upsertProfile).toHaveBeenCalledTimes(1);
  });

  it('reports missing configuration before any request or learned-profile write', async () => {
    await expect(createProfileFromPdf(analysis, companyId)).rejects.toMatchObject({
      statusCode: 503, code: 'AI_CONFIG_MISSING',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.upsertProfile).not.toHaveBeenCalled();
  });

  it('rejects an unsupported destination without sending credentials or learning a profile', async () => {
    vi.stubEnv('AI_API_KEY', apiKey);
    vi.stubEnv('AI_BASE_URL', 'https://unapproved.example/v1');
    await expect(createProfileFromPdf(analysis, companyId)).rejects.toMatchObject({
      statusCode: 503, code: 'AI_PROVIDER_RECONFIGURATION_REQUIRED',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.upsertProfile).not.toHaveBeenCalled();
  });

  it('keeps provider failure distinct and never returns or logs its sensitive body', async () => {
    await setAiConfig({ apiKey });
    mockFetch.mockResolvedValue(new Response(`rejected ${apiKey}`, { status: 429 }));
    let failure: unknown;
    try { await createProfileFromPdf(analysis, companyId); } catch (err) { failure = err; }
    expect(failure).toMatchObject({ statusCode: 503, code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(String(failure)).not.toContain(apiKey);
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(apiKey);
    expect(mocks.upsertProfile).not.toHaveBeenCalled();
  });

  it('allows a bounded minute for first-format learning instead of a chat-sized deadline', async () => {
    await setAiConfig({ apiKey });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(generated) } }] })));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await createProfileFromPdf(analysis, companyId);
      expect(timeout).toHaveBeenCalledWith(60000);
    } finally { timeout.mockRestore(); }
  });

  it('keeps the existing missing-config message for other resolver consumers', async () => {
    await expect(getAiConfig()).rejects.toThrow('AI configuration missing. Set AI_API_KEY in .env or save via /api/config/ai.');
  });

  it('preserves the existing regex validation contract', () => {
    expect(() => validateRegex('^\\d{2}/\\d{2}/\\d{2}$', 'anchor')).not.toThrow();
    expect(() => validateRegex('[', 'anchor')).toThrow();
  });
});
