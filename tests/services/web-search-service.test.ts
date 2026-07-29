import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchEntity } from '@/lib/services/web-search-service';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('searchEntity', () => {
  it('returns null when WEB_SEARCH_ENABLED is not true', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'false');
    const result = await searchEntity('SETOYOTA');
    expect(result).toBeNull();
  });

  it('returns null when WEB_SEARCH_API_KEY is missing', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', '');
    vi.stubEnv('WEB_SEARCH_CX', 'some-cx');
    const result = await searchEntity('SETOYOTA');
    expect(result).toBeNull();
  });

  it('returns null when WEB_SEARCH_CX is missing', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', 'some-key');
    vi.stubEnv('WEB_SEARCH_CX', '');
    const result = await searchEntity('SETOYOTA');
    expect(result).toBeNull();
  });

  it('returns SearchResult on successful API response', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_CX', 'test-cx');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [
            {
              title: 'Southeast Toyota Finance',
              snippet: 'Southeast Toyota Finance offers vehicle financing',
              link: 'https://www.setoyota.com/finance',
            },
          ],
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Southeast Toyota Finance');
    expect(result!.snippet).toBe('Southeast Toyota Finance offers vehicle financing');
    expect(result!.sourceUrl).toBe('https://www.setoyota.com/finance');
  });

  it('returns null on non-ok API response', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_CX', 'test-cx');

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await searchEntity('SETOYOTA');
    expect(result).toBeNull();
  });

  it('returns null when API returns no items', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_CX', 'test-cx');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await searchEntity('UNKNOWN_ENTITY_XYZ');
    expect(result).toBeNull();
  });

  it('returns null on fetch timeout (AbortError)', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_CX', 'test-cx');

    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', mockFetch);

    const result = await searchEntity('SETOYOTA');
    expect(result).toBeNull();
  });

  it('returns null on generic fetch error', async () => {
    vi.stubEnv('WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('WEB_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_CX', 'test-cx');

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await searchEntity('SETOYOTA');
    expect(result).toBeNull();
  });
});
