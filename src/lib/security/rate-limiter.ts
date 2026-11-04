import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { logger } from '../logger';

type Budget = { requestsPerMinute: number; burstMultiplier: number };

type RateLimitConfig = {
  default: Budget;
  criticalEndpoints: Record<string, Budget>;
  scope: string;
  windowMs: number;
  /**
   * S23e: cross-path budget per user identity. Per-path buckets alone let a
   * client fan out across many endpoints and never hit a limit; this ceiling is
   * shared by every path a single user identity touches inside `windowMs`.
   */
  userBudget?: Budget;
};

/**
 * Default cross-path budget: 300 requests/minute with the usual burst ×2, i.e.
 * at most 600 requests per minute per user identity (session user, or trusted
 * client IP for anonymous traffic). Override with
 * `rateLimit.userBudget` in rules/security-config.json.
 */
export const GLOBAL_USER_BUDGET: Budget = { requestsPerMinute: 300, burstMultiplier: 2 };

/**
 * Identifiers that are PROVEN to exist in the database (a session user id and a
 * tenant id that already passed `requireActiveTenantAccess`). Anything else —
 * an IP used as the bucket key, the 'global' placeholder company — must never
 * reach the audit table: those writes violated the AuditLog foreign keys and
 * were swallowed by a catch.
 */
export type RateLimitAuditSubject = { userId: string; companyId: string };

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  /** Which budget produced this decision. */
  scope: 'path' | 'user';
  budgetLimit: number;
  budgetRemaining: number;
  budgetResetAt: number;
}

// Cache interno de ventanas deslizantes
const requestWindows = new Map<string, { count: number; resetAt: number; audited?: boolean }>();
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Limpieza cada 5 min para evitar memory leaks

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

function _startCleanup(): void {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of requestWindows.entries()) {
      if (now >= window.resetAt) requestWindows.delete(key);
    }
  }, CLEANUP_INTERVAL);
}

/** Exposed for hot-reload scenarios — prevents duplicate intervals in dev. */
export function stopRateLimitCleanup(): void {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

_startCleanup();

type SecurityConfig = {
  version: string;
  rateLimit: RateLimitConfig;
};

let cachedConfig: RateLimitConfig | null = null;
let lastLoadedTime = 0;
const CACHE_TTL = 300 * 1000; // 300s TTL in development

const DEFAULT_CONFIG: RateLimitConfig = {
  default: { requestsPerMinute: 60, burstMultiplier: 2 },
  criticalEndpoints: {},
  scope: 'global',
  windowMs: 60000,
  userBudget: GLOBAL_USER_BUDGET,
};

function getRateLimitConfig(): RateLimitConfig {
  const isProd = process.env.NODE_ENV === 'production';
  const now = Date.now();

  if (cachedConfig && (isProd || now - lastLoadedTime < CACHE_TTL)) {
    return cachedConfig;
  }

  try {
    const configPath = join(process.cwd(), 'rules/security-config.json');
    const fullConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as SecurityConfig;
    cachedConfig = fullConfig.rateLimit;
    lastLoadedTime = now;
    return cachedConfig;
  } catch {
    logger.warn('[RATE LIMIT] Config file missing or corrupt, using defaults');
    return DEFAULT_CONFIG;
  }
}

export function checkRateLimit(
  userId: string,
  companyId: string,
  path: string,
  auditSubject?: RateLimitAuditSubject | null,
): RateLimitResult {
  try {
    const config = getRateLimitConfig();

    const key = `${userId}:${companyId}`;
    const now = Date.now();

    // Determinar límite según ruta
    let limit = config.default.requestsPerMinute;
    let burst = config.default.burstMultiplier;
    for (const [prefix, cfg] of Object.entries(config.criticalEndpoints)) {
      if (path.startsWith(prefix)) {
        limit = cfg.requestsPerMinute;
        burst = cfg.burstMultiplier;
        break;
      }
    }

    const maxAllowed = Math.floor(limit * burst);
    const windowKey = `${key}:${path}`;
    let window = requestWindows.get(windowKey);

    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + config.windowMs };
      requestWindows.set(windowKey, window);
    }

    window.count++;
    const remaining = Math.max(0, maxAllowed - window.count);
    const pathAllowed = window.count <= maxAllowed;

    // S23e: cross-path per-user budget (independent of company and path).
    const userBudget = config.userBudget ?? GLOBAL_USER_BUDGET;
    const userMaxAllowed = Math.floor(userBudget.requestsPerMinute * userBudget.burstMultiplier);
    const userWindowKey = `user-budget:${userId}`;
    let userWindow = requestWindows.get(userWindowKey);
    if (!userWindow || now >= userWindow.resetAt) {
      userWindow = { count: 0, resetAt: now + config.windowMs };
      requestWindows.set(userWindowKey, userWindow);
    }
    userWindow.count++;
    const userBudgetRemaining = Math.max(0, userMaxAllowed - userWindow.count);
    const userAllowed = userWindow.count <= userMaxAllowed;

    const allowed = pathAllowed && userAllowed;
    const scope: 'path' | 'user' = userAllowed ? 'path' : 'user';
    const limitForScope = scope === 'user' ? userMaxAllowed : maxAllowed;
    const remainingForScope = scope === 'user' ? userBudgetRemaining : remaining;

    // Auditoría de violaciones: solo cuando ambos identificadores son ids reales
    // de la base (la escritura antigua usaba companyId='global' / userId=<ip> y
    // rompía las FKs; el catch se la tragaba). Como máximo una fila por ventana.
    if (!allowed) {
      if (auditSubject?.userId && auditSubject.companyId) {
        if (!window.audited) {
          window.audited = true;
          db.auditLog
            .create({
              data: {
                companyId: auditSubject.companyId,
                userId: auditSubject.userId,
                action: 'RATE_LIMIT_VIOLATION',
                entity: 'Security',
                details: JSON.stringify({
                  userId,
                  companyId,
                  path,
                  scope,
                  limit: limitForScope,
                  attempts: window.count,
                  userAttempts: userWindow.count,
                }),
              },
            })
            .catch((e) => logger.warn('[RATE LIMIT] Audit write failed', { error: String(e) }));
        }
      } else {
        // No FK-safe identifiers: log loudly with the RAW bucket identifiers so
        // the violation is still observable, and write nothing to the database.
        logger.warn('[RATE LIMIT] Violation without database-backed identity', {
          bucketKey: userId,
          companyId,
          path,
          scope,
          limit: limitForScope,
          attempts: window.count,
          userAttempts: userWindow.count,
        });
      }
    }

    return {
      allowed,
      limit: limitForScope,
      remaining: remainingForScope,
      resetAt: Math.ceil((scope === 'user' ? userWindow.resetAt : window.resetAt) / 1000),
      scope,
      budgetLimit: userMaxAllowed,
      budgetRemaining: userBudgetRemaining,
      budgetResetAt: Math.ceil(userWindow.resetAt / 1000),
    };
  } catch (error) {
    logger.error('[RATE LIMIT ERROR] Fail-safe active, denying request:', { error: String(error) });
    return {
      allowed: false,
      limit: 0,
      remaining: 0,
      resetAt: Math.ceil((Date.now() + 30000) / 1000),
      scope: 'path',
      budgetLimit: 0,
      budgetRemaining: 0,
      budgetResetAt: Math.ceil((Date.now() + 30000) / 1000),
    };
  }
}

/** Test hook: clear every in-memory window (never used in production paths). */
export function resetRateLimitWindows(): void {
  requestWindows.clear();
}
