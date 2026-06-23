import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Hoisted mock factories (must be before vi.mock) ─────────
const { mockReadFileSync, mockAuditLogCreate, mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockAuditLogCreate: vi.fn().mockResolvedValue({}),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────
vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock('@/lib/db', () => ({
  db: {
    auditLog: {
      create: mockAuditLogCreate,
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

import { checkRateLimit } from '@/lib/security/rate-limiter';

const VALID_CONFIG = {
  version: '1.0',
  rateLimit: {
    default: { requestsPerMinute: 60, burstMultiplier: 2 },
    criticalEndpoints: {
      '/api/auth/login': { requestsPerMinute: 10, burstMultiplier: 1 },
      '/api/reconciliation': { requestsPerMinute: 20, burstMultiplier: 1.5 },
    },
    scope: 'per_user_company',
    windowMs: 60000,
  },
};

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure NODE_ENV is 'test' so config is NOT cached forever
    vi.stubEnv('NODE_ENV', 'test');
    // Default: valid config file
    mockReadFileSync.mockReturnValue(JSON.stringify(VALID_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /* ── Basic allowed / blocked ─────────────────────────── */

  it('allows requests under the default limit', () => {
    const result = checkRateLimit('user1', 'company1', '/api/transactions');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(120); // 60 * 2 (burst)
    expect(result.remaining).toBeGreaterThanOrEqual(119);
    expect(result.resetAt).toBeGreaterThan(0);
  });

  it('blocks requests exceeding the default limit', () => {
    const path = '/api/transactions';
    const limit = VALID_CONFIG.rateLimit.default.requestsPerMinute;
    const burst = VALID_CONFIG.rateLimit.default.burstMultiplier;
    const maxAllowed = Math.floor(limit * burst); // 120

    // Exhaust the limit
    for (let i = 0; i < maxAllowed; i++) {
      checkRateLimit('user1', 'company1', path);
    }

    const result = checkRateLimit('user1', 'company1', path);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns correct remaining count', () => {
    const path = '/api/transactions';
    checkRateLimit('user1', 'company1', path);
    const result = checkRateLimit('user1', 'company1', path);
    expect(result.remaining).toBe(118); // 120 - 2
  });

  /* ── Critical endpoints ───────────────────────────────── */

  it('applies critical endpoint limits for matching paths', () => {
    const result = checkRateLimit('user1', 'company1', '/api/auth/login');
    expect(result.limit).toBe(10); // 10 * 1
  });

  it('blocks on critical endpoint when exhausted', () => {
    const path = '/api/auth/login';
    const limit = VALID_CONFIG.rateLimit.criticalEndpoints['/api/auth/login'];
    const maxAllowed = Math.floor(limit.requestsPerMinute * limit.burstMultiplier); // 10

    for (let i = 0; i < maxAllowed; i++) {
      checkRateLimit('user1', 'company1', path);
    }

    const result = checkRateLimit('user1', 'company1', path);
    expect(result.allowed).toBe(false);
  });

  it('uses prefix matching for critical endpoints', () => {
    const result = checkRateLimit('user1', 'company1', '/api/reconciliation/123');
    expect(result.limit).toBe(30); // 20 * 1.5
  });

  /* ── Sliding window per user:companyId:path ──────────── */

  it('tracks separate windows per user', () => {
    checkRateLimit('user1', 'company1', '/api/test');
    checkRateLimit('user1', 'company1', '/api/test');
    const r1 = checkRateLimit('user1', 'company1', '/api/test'); // 3rd call

    // user2 has a separate window
    const r2 = checkRateLimit('user2', 'company1', '/api/test');
    expect(r2.remaining).toBeGreaterThan(r1.remaining);
  });

  it('tracks separate windows per company', () => {
    checkRateLimit('user1', 'company1', '/api/test');
    checkRateLimit('user1', 'company1', '/api/test');
    const r1 = checkRateLimit('user1', 'company1', '/api/test'); // 3rd call

    const r2 = checkRateLimit('user1', 'company2', '/api/test');
    expect(r2.remaining).toBeGreaterThan(r1.remaining);
  });

  it('tracks separate windows per path', () => {
    checkRateLimit('user1', 'company1', '/api/test');
    const r1 = checkRateLimit('user1', 'company1', '/api/test');
    const r2 = checkRateLimit('user1', 'company1', '/api/other');
    expect(r2.remaining).toBeGreaterThan(r1.remaining);
  });

  it('resets window when time expires', () => {
    const path = '/api/test';
    vi.useFakeTimers();
    checkRateLimit('user1', 'company1', path);

    // Advance past windowMs
    vi.advanceTimersByTime(60001);

    const result = checkRateLimit('user1', 'company1', path);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(119); // fresh window, 1 used

    vi.useRealTimers();
  });

  /* ── Audit logging on violation ──────────────────────── */

  it('logs an audit entry when rate limit is violated', () => {
    const path = '/api/auth/login';
    const limit = VALID_CONFIG.rateLimit.criticalEndpoints['/api/auth/login'];
    const maxAllowed = Math.floor(limit.requestsPerMinute * limit.burstMultiplier);

    for (let i = 0; i < maxAllowed; i++) {
      checkRateLimit('user1', 'company1', path);
    }

    // Clear any audit calls from the last ALLOWED call
    mockAuditLogCreate.mockClear();

    // This call will be the violation (count = 11 > 10)
    checkRateLimit('user1', 'company1', path);

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const callArg = mockAuditLogCreate.mock.calls[0][0];
    expect(callArg).toHaveProperty('data.companyId', 'company1');
    expect(callArg).toHaveProperty('data.userId', 'user1');
    expect(callArg).toHaveProperty('data.action', 'RATE_LIMIT_VIOLATION');
    expect(callArg).toHaveProperty('data.entity', 'Security');
  });

  it('does not log audit on allowed requests', () => {
    checkRateLimit('user1', 'company1', '/api/test');
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  /* ── Config fallback ─────────────────────────────────── */

  it('falls back to DEFAULT_CONFIG when file is missing', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = checkRateLimit('user1', 'company1', '/api/test');
    expect(result.limit).toBe(120); // 60 * 2 from DEFAULT_CONFIG
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[RATE LIMIT] Config file missing or corrupt, using defaults',
    );
  });

  it('falls back to DEFAULT_CONFIG when file has invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not json {{{');
    const result = checkRateLimit('user1', 'company1', '/api/test');
    expect(result.limit).toBe(120);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  /* ── Fail-safe on error ──────────────────────────────── */

  it('returns allowed:false and logs error on unexpected failure', () => {
    mockReadFileSync.mockReturnValue('{}'); // missing rateLimit key causes error
    const result = checkRateLimit('user1', 'company1', '/api/test');
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
    expect(result.remaining).toBe(0);
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[RATE LIMIT ERROR] Fail-safe active, denying request:',
      expect.any(Object),
    );
  });

  /* ── Config caching ──────────────────────────────────── */

  it('caches config for 300s in non-production', () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'development');

    checkRateLimit('user1', 'company1', '/api/test');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    // Still within TTL
    vi.advanceTimersByTime(299000);
    checkRateLimit('user1', 'company1', '/api/other');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1); // cached, no re-read

    vi.useRealTimers();
  });

  it('re-reads config after TTL expires in non-production', () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'development');

    checkRateLimit('user1', 'company1', '/api/test');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    // Beyond TTL
    vi.advanceTimersByTime(301000);
    checkRateLimit('user1', 'company1', '/api/other');
    expect(mockReadFileSync).toHaveBeenCalledTimes(2); // re-read

    vi.useRealTimers();
  });

  it('caches config forever in production', () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');

    checkRateLimit('user1', 'company1', '/api/test');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    // Far beyond TTL
    vi.advanceTimersByTime(999999);
    checkRateLimit('user1', 'company1', '/api/other');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1); // still cached

    vi.useRealTimers();
  });
});
