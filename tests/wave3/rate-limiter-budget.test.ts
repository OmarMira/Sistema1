import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger';

/**
 * S23e — rate limiter:
 *  1. a violation used to be written to AuditLog with companyId='global' and
 *     userId=<client IP>. Both violate foreign keys, so the insert always
 *     failed and the failure was swallowed. Now the audit row is written only
 *     when the identifiers are database-backed (session user + verified tenant);
 *     otherwise the violation is logged with the raw bucket identifiers.
 *  2. a per-path bucket alone never limits a client that fans out across paths,
 *     so a second in-memory budget caps every request of one user identity per
 *     window regardless of path.
 */

const auditCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'audit-1' }));

vi.mock('@/lib/db', () => ({
  db: {
    auditLog: { create: auditCreate },
  },
}));

import {
  checkRateLimit,
  resetRateLimitWindows,
  GLOBAL_USER_BUDGET,
} from '@/lib/security/rate-limiter';

const PATH = '/api/journal';

function violate(
  key: string,
  path: string,
  auditSubject?: { userId: string; companyId: string } | null,
  companyId: string = 'company-1',
) {
  // Drive the bucket past its limit (default config: 60 rpm × 1.5 burst = 90).
  let last = checkRateLimit(key, companyId, path, auditSubject);
  for (let i = 0; i < 200 && last.allowed; i++) {
    last = checkRateLimit(key, companyId, path, auditSubject);
  }
  return last;
}

describe('S23e — rate limiter violation audit and per-user budget', () => {
  beforeEach(() => {
    resetRateLimitWindows();
    auditCreate.mockClear();
  });

  it('never writes an audit row for identifiers that are not database ids', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Anonymous traffic: the bucket key is a client IP and the company is the
    // 'global' placeholder — exactly the pair that violated the FKs.
    const result = violate('203.0.113.7', PATH, null, 'global');

    expect(result.allowed).toBe(false);
    expect(auditCreate).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('203.0.113.7');
    expect(logged).toContain('global');
    warn.mockRestore();
  });

  it('writes exactly one audit row per window when the ids are database-backed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const subject = { userId: 'user-real-id', companyId: 'company-real-id' };

    const result = violate('user-real-id', PATH, subject);

    expect(result.allowed).toBe(false);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const payload = auditCreate.mock.calls[0]![0] as {
      data: { companyId: string; userId: string; action: string; details: string };
    };
    expect(payload.data.companyId).toBe('company-real-id');
    expect(payload.data.userId).toBe('user-real-id');
    expect(payload.data.action).toBe('RATE_LIMIT_VIOLATION');
    expect(JSON.parse(payload.data.details)).toMatchObject({ path: PATH, scope: 'path' });
    warn.mockRestore();
  });

  it('caps one user identity across every path (global per-user budget)', () => {
    const max = Math.floor(GLOBAL_USER_BUDGET.requestsPerMinute * GLOBAL_USER_BUDGET.burstMultiplier);

    let denied: ReturnType<typeof checkRateLimit> | null = null;
    for (let i = 0; i < max; i++) {
      // A different path every time: the per-path bucket never trips.
      const result = checkRateLimit('user-fanout', 'company-1', `/api/path-${i % 500}`);
      expect(result.allowed).toBe(true);
    }

    const over = checkRateLimit('user-fanout', 'company-1', '/api/another-path');
    denied = over;

    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('user');
    expect(denied.limit).toBe(max);
    expect(denied.remaining).toBe(0);
  });

  it('keeps the per-path contract (limit/remaining/resetAt) for allowed requests', () => {
    const result = checkRateLimit('user-plain', 'company-1', PATH);

    expect(result.allowed).toBe(true);
    expect(result.scope).toBe('path');
    expect(result.limit).toBe(90);
    expect(result.remaining).toBe(89);
    expect(result.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
