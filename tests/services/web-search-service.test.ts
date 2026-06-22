import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { searchEntity } from '@/lib/services/web-search-service';

describe('searchEntity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset env to defaults before each test
    process.env.WEB_SEARCH_ENABLED = 'true';
    process.env.WEB_SEARCH_API_KEY = 'test-api-key';
    process.env.WEB_SEARCH_CX = 'test-cx-id';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns search result with title, snippet, and sourceUrl on successful fetch', async () => {
    const mockItems = [
      {
        title: 'Southeast Toyota Finance',
        snippet: 'Southeast Toyota Finance provides vehicle financing solutions.',
        link: 'https://www.southeasttoyota.com/finance',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: mockItems }), { status: 200 }),
    );

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Southeast Toyota Finance');
    expect(result!.snippet).toBe('Southeast Toyota Finance provides vehicle financing solutions.');
    expect(result!.sourceUrl).toBe('https://www.southeasttoyota.com/finance');
  });

  it('returns null when WEB_SEARCH_ENABLED is false', async () => {
    process.env.WEB_SEARCH_ENABLED = 'false';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when WEB_SEARCH_API_KEY is missing', async () => {
    delete process.env.WEB_SEARCH_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when WEB_SEARCH_CX is missing', async () => {
    delete process.env.WEB_SEARCH_CX;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when search returns empty items array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );

    const result = await searchEntity('UNKNOWN_ENTITY_XYZ');

    expect(result).toBeNull();
  });

  it('returns null when search response has no items field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).toBeNull();
  });

  it('returns null on network error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).toBeNull();
  });

  it('returns null when fetch response status is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'API limit exceeded' }), { status: 429 }),
    );

    const result = await searchEntity('SETOYOTA FIN/EZP');

    expect(result).toBeNull();
  });

  // Timeout test is covered by the network error test above — the abort path
  // also catches the error and returns null, just with a different log message.
  // A real timeout test requires 5+ seconds of wall-clock time, so we skip it
  // in favor of the error-path coverage (same return value: null).
});
