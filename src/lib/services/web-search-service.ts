import { logger } from '@/lib/logger';

export interface SearchResult {
  title: string;
  snippet: string;
  sourceUrl: string;
}

interface GoogleSearchResponse {
  items?: Array<{
    title: string;
    snippet: string;
    link: string;
  }>;
}

/**
 * Searches the web for an entity name using Google Custom Search API.
 * Opt-in via WEB_SEARCH_ENABLED env var (default: false).
 * Returns null if search is disabled, misconfigured, times out (5s), or yields no results.
 */
export async function searchEntity(entityName: string): Promise<SearchResult | null> {
  const enabled = process.env.WEB_SEARCH_ENABLED === 'true';
  const apiKey = process.env.WEB_SEARCH_API_KEY;
  const cx = process.env.WEB_SEARCH_CX;

  if (!enabled) {
    logger.warn('[WEB_SEARCH DISABLED]', {
      reason: 'WEB_SEARCH_ENABLED is not set to true',
    });
    return null;
  }

  if (!apiKey || !cx) {
    logger.warn('[WEB_SEARCH MISCONFIGURED]', {
      missing: !apiKey ? 'WEB_SEARCH_API_KEY' : 'WEB_SEARCH_CX',
    });
    return null;
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', entityName);
  url.searchParams.set('num', '1');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });

    if (!response.ok) {
      logger.warn('[WEB_SEARCH API_ERROR]', {
        status: response.status,
        entity: entityName,
      });
      return null;
    }

    const data: GoogleSearchResponse = await response.json();

    if (!data.items || data.items.length === 0) {
      logger.info('[WEB_SEARCH NO_RESULTS]', { entity: entityName });
      return null;
    }

    const item = data.items[0];

    logger.info('[WEB_SEARCH RESULT]', {
      entity: entityName,
      title: item.title,
    });

    return {
      title: item.title,
      snippet: item.snippet,
      sourceUrl: item.link,
    };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      logger.warn('[WEB_SEARCH TIMEOUT]', { entity: entityName });
    } else {
      logger.warn('[WEB_SEARCH ERROR]', {
        entity: entityName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
