// ─── LRU Cache with BroadcastChannel Sync ─────────────────────────────────────
// Bounded in-process cache to avoid database load on static data.
// BroadcastChannel propagates invalidations across Next.js workers/processes.

export interface CacheEntry<T> {
  value: T;
  expiry: number;
}

export class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private max: number;
  private ttl: number;
  private channel: BroadcastChannel | null = null;
  private hits = 0;
  private misses = 0;

  constructor(max = 200, ttlMs = 5 * 60 * 1000, channelName = 'app-cache-sync') {
    this.max = max;
    this.ttl = ttlMs;

    if (typeof globalThis.BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (event) => {
        if (event.data && event.data.type === 'invalidate') {
          this.localInvalidate(event.data.key);
        } else if (event.data && event.data.type === 'clear') {
          this.localClear();
        }
      };
    }
  }

  get(key: K): V | null {
    const cached = this.cache.get(key);
    if (!cached) {
      this.misses++;
      return null;
    }

    if (Date.now() > cached.expiry) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    // Refresh position to maintain LRU property
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached.value;
  }

  getMetrics() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  set(key: K, value: V) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      // Evict least recently used (the first key in Map)
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttl,
    });
  }

  invalidate(key: K) {
    this.localInvalidate(key);
    if (this.channel) {
      this.channel.postMessage({ type: 'invalidate', key });
    }
  }

  clear() {
    this.localClear();
    if (this.channel) {
      this.channel.postMessage({ type: 'clear' });
    }
  }

  get size(): number {
    return this.cache.size;
  }

  private localInvalidate(key: K) {
    this.cache.delete(key);
  }

  private localClear() {
    this.cache.clear();
  }
}

// ─── Cache value type definitions ──────────────────────────────────────────
// These match the shape returned by the respective API routes.

interface GlAccountSummary {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string | null;
}

interface CompanySettingsData {
  company: Record<string, unknown>;
  stats: {
    memberCount: number;
    accountCount: number;
    periodCount: number;
  };
  periods: Array<{
    id: string;
    name: string;
    startDate: Date;
    endDate: Date;
    isLocked: boolean;
  }>;
}

// Global cached instances
export const journalAccountsCache = new LRUCache<string, GlAccountSummary[]>(
  100,
  5 * 60 * 1000,
  'journal-accounts-cache-sync',
);
export const companySettingsCache = new LRUCache<string, CompanySettingsData>(
  100,
  5 * 60 * 1000,
  'company-settings-cache-sync',
);
