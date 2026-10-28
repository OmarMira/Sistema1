import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestImportProfile } from '@/lib/import-ai-client';
import { AI_PROVIDERS } from '@/lib/constants/ai-config';

const mocks = vi.hoisted(() => ({ config: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/ai-config', () => ({ getAiConfig: mocks.config }));
const key = 'synthetic-key-not-a-real-credential';
const json = '{"synthetic":true}';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ apiKey: key, baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: json } }] })));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('structured PDF inference contract', () => {
  it('asks the selected free router for compatible JSON with a bounded final-output budget', async () => {
    expect(await requestImportProfile('Return JSON', 'Invented example, no customer data', 60000)).toBe(json);
    const [url, init] = mocks.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body.model).toBe('openrouter/free');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('models');
    expect(init.redirect).toBe('error');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(AI_PROVIDERS.filter(provider => provider.id !== 'openrouter'))('preserves the existing $id protocol without router-only parameters', async provider => {
    mocks.config.mockResolvedValue({ apiKey: key, baseUrl: provider.baseUrl, model: provider.defaultModel });
    if (provider.id === 'anthropic') mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: json }] })));
    expect(await requestImportProfile('Return JSON', 'Invented example', 60000)).toBe(json);
    const [, init] = mocks.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe(provider.defaultModel);
    expect(body.max_tokens).toBe(1500);
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('response_format');
    expect(new Headers(init.headers).get(provider.id === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(provider.id === 'anthropic' ? key : `Bearer ${key}`);
  });

  it.each([[401, 'credentials_rejected'], [402, 'credits_required'], [429, 'rate_limited']] as const)('reports safe HTTP %i metadata without reading or exposing the rejected body', async (status, reason) => {
    const response = new Response(`Sensitive ${key}`, { status });
    const read = vi.spyOn(response, 'json');
    mocks.fetch.mockResolvedValue(response);
    let failure: unknown;
    try { await requestImportProfile('Return JSON', 'Invented example', 60000); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ statusCode: 503, code: 'AI_PROVIDER_UNAVAILABLE', details: { reason, providerStatus: status } });
    expect(JSON.stringify(failure)).not.toContain(key);
    expect(read).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([['stop', 'empty_response'], ['length', 'response_truncated']] as const)('does not treat an empty %s response or private reasoning as a usable profile', async (finish, reason) => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: null, reasoning: `Private reasoning ${key}` } }] })));
    await expect(requestImportProfile('Return JSON', 'Invented example', 60000)).rejects.toMatchObject({ code: 'AI_PROFILE_GENERATION_FAILED', details: { reason } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes timeout from a rejected credential without retrying', async () => {
    mocks.fetch.mockRejectedValue(new DOMException('Synthetic timeout', 'TimeoutError'));
    await expect(requestImportProfile('Return JSON', 'Invented example', 60000)).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', details: { reason: 'timeout' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
