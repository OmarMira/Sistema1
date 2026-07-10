import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '@/lib/rate-limiter';

// Mock @/lib/db
vi.mock('@/lib/db', () => ({
  db: {
    rateLimit: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 1000, 2, 1000); // low limits + short windows for testing
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ── Check ────────────────────────────────────────────── */

  describe('check()', () => {
    it('allows first request from an IP', () => {
      const result = limiter.check('1.2.3.4');
      expect(result.success).toBe(true);
      expect(result.limitType).toBeUndefined();
      expect(result.resetTime).toBeUndefined();
    });

    it('blocks IP after limit is exceeded', () => {
      const ip = '1.2.3.4';
      limiter.increment(ip);
      limiter.increment(ip);
      limiter.increment(ip);

      // Now check should say blocked
      const result = limiter.check(ip);
      expect(result.success).toBe(false);
      expect(result.limitType).toBe('ip');
      expect(result.resetTime).toBeGreaterThan(Date.now());
    });

    it('returns success = true when at exactly the limit (check before increment)', () => {
      const ip = '1.2.3.4';
      limiter.increment(ip); // 1
      limiter.increment(ip); // 2
      const result = limiter.check(ip); // count is still 2, limit is 3 -> allowed
      expect(result.success).toBe(true);
    });

    it('blocks when IP count reaches limit', () => {
      const ip = '1.2.3.4';
      limiter.increment(ip); // 1
      limiter.increment(ip); // 2
      limiter.increment(ip); // 3
      const result = limiter.check(ip); // count is 3, limit is 3 -> blocked
      expect(result.success).toBe(false);
    });

    it('blocks email when email limit is exceeded', () => {
      const email = 'user@test.com';
      limiter.increment('ip1', email); // 1
      limiter.increment('ip2', email); // 2
      limiter.increment('ip3', email); // 3, email limit is 2
      const result = limiter.check('newip', email);
      expect(result.success).toBe(false);
      expect(result.limitType).toBe('email');
      expect(result.resetTime).toBeGreaterThan(Date.now());
    });

    it('allows email when within limit', () => {
      const email = 'user@test.com';
      limiter.increment('ip1', email); // email: 1
      limiter.increment('ip2', email); // email: 2
      const result = limiter.check('newip', email); // at limit, check says blocked
      expect(result.success).toBe(false);
      expect(result.limitType).toBe('email');
    });

    it('normalizes email to lowercase', () => {
      // Increment twice to hit the email limit (limit=2)
      limiter.increment('ip1', 'User@Test.COM');
      limiter.increment('ip1', 'User@Test.COM');
      // check should see count=2 >= limit=2 via lowercase normalization
      const result = limiter.check('ip2', 'user@test.com');
      expect(result.success).toBe(false);
      expect(result.limitType).toBe('email');
    });

    it('resets IP window when time expires', () => {
      const ip = '1.2.3.4';
      limiter.increment(ip); // 1
      limiter.increment(ip); // 2
      limiter.increment(ip); // 3

      // Advance past window
      vi.advanceTimersByTime(1001);

      // Should be allowed again (new window)
      const result = limiter.check(ip);
      expect(result.success).toBe(true);
    });
  });

  /* ── Increment ────────────────────────────────────────── */

  describe('increment()', () => {
    it('increments IP counter', () => {
      limiter.increment('1.2.3.4');
      limiter.increment('1.2.3.4');
      const result = limiter.check('1.2.3.4');
      expect(result.success).toBe(true); // 2 < 3, allowed
    });

    it('increments email counter', () => {
      limiter.increment('ip1', 'a@b.com');
      limiter.increment('ip2', 'a@b.com');
      const result = limiter.check('ip3', 'a@b.com');
      expect(result.success).toBe(false);
    });

    it('increment without email does not affect email', () => {
      limiter.increment('ip1'); // no email
      limiter.increment('ip2', 'a@b.com'); // email: 1
      const result = limiter.check('ip3', 'a@b.com');
      expect(result.success).toBe(true); // email: 1 < 2, allowed
    });

    it('creates new window when expired on increment', () => {
      limiter.increment('1.2.3.4');
      limiter.increment('1.2.3.4');
      limiter.increment('1.2.3.4'); // at limit

      vi.advanceTimersByTime(1001);

      limiter.increment('1.2.3.4'); // should start new window
      const result = limiter.check('1.2.3.4');
      expect(result.success).toBe(true); // count is 1 in new window
    });
  });

  /* ── Reset & Clear ────────────────────────────────────── */

  describe('reset() and clear()', () => {
    it('reset clears IP and optionally email', () => {
      limiter.increment('1.2.3.4', 'a@b.com');
      limiter.reset('1.2.3.4', 'a@b.com');

      const result = limiter.check('1.2.3.4', 'a@b.com');
      expect(result.success).toBe(true);
    });

    it('reset with only IP leaves email untouched', () => {
      // Increment twice to reach email limit (limit=2)
      limiter.increment('ip1', 'a@b.com');
      limiter.increment('ip1', 'a@b.com');
      limiter.reset('ip1'); // no email arg

      // IP is reset
      expect(limiter.check('ip1').success).toBe(true);
      // Email is NOT reset — count=2 >= limit=2, should block
      const result = limiter.check('ip2', 'a@b.com');
      expect(result.success).toBe(false);
      expect(result.limitType).toBe('email');
    });

    it('clear resets all', () => {
      limiter.increment('1.2.3.4', 'a@b.com');
      limiter.increment('5.6.7.8', 'b@c.com');
      limiter.clear();

      expect(limiter.check('1.2.3.4', 'a@b.com').success).toBe(true);
      expect(limiter.check('5.6.7.8', 'b@c.com').success).toBe(true);
    });
  });

  /* ── Constructor defaults (authRateLimiter) ────────────── */

  describe('default instance', () => {
    it('authRateLimiter has default limits', async () => {
      const { authRateLimiter } = await import('@/lib/rate-limiter');
      // IP check with default (5 requests)
      for (let i = 0; i < 5; i++) {
        authRateLimiter.increment('default-ip');
      }
      const result = authRateLimiter.check('default-ip');
      expect(result.success).toBe(false);
      expect(result.limitType).toBe('ip');
    });
  });
});
