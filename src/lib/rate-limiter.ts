import { db } from '@/lib/db';

interface HitInfo {
  count: number;
  resetTime: number;
}

export class RateLimiter {
  private ipHits = new Map<string, HitInfo>();
  private emailHits = new Map<string, HitInfo>();

  constructor(
    private ipLimit: number = 5,
    private ipWindowMs: number = 15 * 60 * 1000,
    private emailLimit: number = 10,
    private emailWindowMs: number = 60 * 60 * 1000,
  ) {
    // Load persisted counters from DB silently (fire-and-forget)
    this._loadFromDb();
  }

  /**
   * Load existing rate-limit counters from the database.
   * Ensures rate limits survive server restarts.
   */
  private _loadFromDb(): void {
    const now = Date.now();
    db.rateLimit
      .findMany({
        where: { resetAt: { gte: new Date(now) } },
        take: 50000,
      })
      .then((records) => {
        for (const r of records) {
          const resetTime = r.resetAt.getTime();
          if (now >= resetTime) continue; // Skip expired windows

          if (r.key.startsWith('ip:')) {
            this.ipHits.set(r.key.slice(3), { count: r.hits, resetTime });
          } else if (r.key.startsWith('email:')) {
            this.emailHits.set(r.key.slice(6), { count: r.hits, resetTime });
          }
        }
      })
      .catch((err) => {
        console.warn('[RATE LIMITER] Failed to load persisted counters', String(err));
        // In-memory default starts empty — safe fallback
      });
  }

  private persist(key: string, hits: number, windowMs: number, resetTime: number): void {
    const resetAt = new Date(resetTime);
    db.rateLimit
      .upsert({
        where: { key },
        update: { hits, resetAt },
        create: { key, hits, resetAt, windowMs },
      })
      .catch(() => {
        // In-memory cache remains functional even if persistence fails
      });
  }

  public check(
    ip: string,
    email?: string,
  ): { success: boolean; limitType?: 'ip' | 'email'; resetTime?: number } {
    const now = Date.now();

    // Check IP
    let ipInfo = this.ipHits.get(ip);
    if (!ipInfo || now > ipInfo.resetTime) {
      ipInfo = { count: 0, resetTime: now + this.ipWindowMs };
      this.ipHits.set(ip, ipInfo);
    }

    if (ipInfo.count >= this.ipLimit) {
      return { success: false, limitType: 'ip', resetTime: ipInfo.resetTime };
    }

    // Check Email
    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      let emailInfo = this.emailHits.get(normalizedEmail);
      if (!emailInfo || now > emailInfo.resetTime) {
        emailInfo = { count: 0, resetTime: now + this.emailWindowMs };
        this.emailHits.set(normalizedEmail, emailInfo);
      }

      if (emailInfo.count >= this.emailLimit) {
        return { success: false, limitType: 'email', resetTime: emailInfo.resetTime };
      }
    }

    return { success: true };
  }

  public increment(ip: string, email?: string): void {
    const now = Date.now();

    // Increment IP
    let ipInfo = this.ipHits.get(ip);
    if (!ipInfo || now > ipInfo.resetTime) {
      ipInfo = { count: 0, resetTime: now + this.ipWindowMs };
    }
    ipInfo.count++;
    this.ipHits.set(ip, ipInfo);
    this.persist(`ip:${ip}`, ipInfo.count, this.ipWindowMs, ipInfo.resetTime);

    // Increment Email
    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      let emailInfo = this.emailHits.get(normalizedEmail);
      if (!emailInfo || now > emailInfo.resetTime) {
        emailInfo = { count: 0, resetTime: now + this.emailWindowMs };
      }
      emailInfo.count++;
      this.emailHits.set(normalizedEmail, emailInfo);
      this.persist(`email:${normalizedEmail}`, emailInfo.count, this.emailWindowMs, emailInfo.resetTime);
    }
  }

  public reset(ip: string, email?: string): void {
    this.ipHits.delete(ip);
    if (email) {
      this.emailHits.delete(email.toLowerCase().trim());
    }
  }

  // Helper for tests to clean the memory
  public clear(): void {
    this.ipHits.clear();
    this.emailHits.clear();
  }
}

// Global singleton instance for authentication endpoints
export const authRateLimiter = new RateLimiter(5, 15 * 60 * 1000, 10, 60 * 60 * 1000);
