import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Read per request so a process started in one mode cannot leak another's policy. */
function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * S8 — 'unsafe-eval' is a DEVELOPMENT-only concession.
 *
 * Only the dev bundler needs it (webpack `eval` source maps and React Refresh),
 * and nothing in this app calls `eval()` or `new Function()` (grep-verified), so
 * the production policy never ships it. `@sentry/nextjs` needs no eval in its
 * shipped browser bundle; only its dev tooling would.
 *
 * 'unsafe-inline' STAYS in both modes: Next.js injects inline bootstrap/hydration
 * scripts and this app has no nonce/hash infrastructure, so removing it without a
 * nonce rollout would break every page. Documented residual: an injected inline
 * script could still run — mitigated by the missing eval surface plus the strict
 * connect-src / frame-ancestors / base-uri / form-action directives below.
 */
function scriptSrcDirective(): string {
  return isDevMode()
    ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline'";
}

function getSecurityHeaders(): Record<string, string> {
  const extraSources = process.env.CSP_SOURCES ? ` ${process.env.CSP_SOURCES}` : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      scriptSrcDirective(),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${extraSources}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  };
}

interface CorsDecision {
  origin: string;
  allowCredentials: boolean;
}

function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * S8 — CORS never answers the literal `*`.
 *
 * `Access-Control-Allow-Origin: *` is meaningless for cookie-authenticated API
 * responses (browsers refuse to expose a credentialed response to a wildcard), so
 * the header only ever carries the request's own Origin, and only when that
 * origin is allowed:
 *   - ALLOWED_ORIGINS lists the origin  -> echo it, credentials allowed;
 *   - ALLOWED_ORIGINS is `*`           -> echo the request origin, but WITHOUT
 *     credentials, so the operator's wildcard never becomes a cross-site
 *     credential channel;
 *   - not listed                       -> no CORS header at all;
 *   - no Origin (same-origin request)  -> no CORS header (none is needed).
 */
function corsDecision(request: NextRequest): CorsDecision | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;

  const allowed = allowedOrigins();
  if (allowed.length === 0) return null;

  if (allowed.includes('*')) return { origin, allowCredentials: false };
  if (allowed.includes(origin)) return { origin, allowCredentials: true };

  // Dev mode: allow localhost variants
  if (isDevMode()) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return { origin, allowCredentials: true };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function corsHeaders(request: NextRequest): Headers | null {
  const decision = corsDecision(request);
  if (!decision) return null;

  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', decision.origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Company-Id, x-company-id',
  );
  // Credentials only for an explicitly allowed origin, never for the wildcard config.
  if (decision.allowCredentials) {
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

function csrfErrorResponse(headers: Headers): NextResponse {
  const h = Object.fromEntries(headers.entries());
  return new NextResponse(
    JSON.stringify({ error: 'CSRF validation failed: Origin mismatch', code: 'CSRF_ERROR' }),
    { status: 403, headers: { 'Content-Type': 'application/json', ...h } },
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const isApi = pathname.startsWith('/api/');

  const PUBLIC_API_ROUTES = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/verify',
    '/api/auth/resend-verification',
    '/api/health',
    '/api/bootstrap/check',
    '/api/bootstrap/restore',
  ];

  const securityHeaders = getSecurityHeaders();

  // 0. CORS preflight
  if (isApi && method === 'OPTIONS') {
    const cors = corsHeaders(request);
    const res = new NextResponse(null, { status: 204 });
    if (cors) cors.forEach((v, k) => res.headers.set(k, v));
    Object.entries(securityHeaders).forEach(([key, value]) => {
      res.headers.set(key, value);
    });
    return res;
  }

  // 1. Session presence check for protected API routes
  if (isApi && !PUBLIC_API_ROUTES.includes(pathname)) {
    const isProd = process.env.NODE_ENV === 'production';
    const cookieName = isProd ? '__Host-session' : 'session';
    const sessionToken =
      request.cookies.get(cookieName)?.value ??
      request.headers.get('authorization')?.replace('Bearer ', '') ??
      null;

    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'AUTH_REQUIRED' },
        { status: 401, headers: securityHeaders },
      );
    }
  }

  const response = NextResponse.next();

  // Apply base headers to every response
  if (isApi) {
    const cors = corsHeaders(request);
    if (cors) cors.forEach((v, k) => response.headers.set(k, v));
  }
  Object.entries(securityHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  // 1. CSRF Protection for API Mutations
  if (isApi && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const host = request.headers.get('host');

    if (origin) {
      const expectedOrigin = host ? `http://${host}` : null;
      const expectedOriginHttps = host ? `https://${host}` : null;

      if (origin !== expectedOrigin && origin !== expectedOriginHttps) {
        return csrfErrorResponse(response.headers);
      }
    } else if (referer) {
      try {
        const refererUrl = new URL(referer);
        if (refererUrl.host !== host) {
          return csrfErrorResponse(response.headers);
        }
      } catch {
        return csrfErrorResponse(response.headers);
      }
    } else {
      // No Origin AND no Referer — reject uniformly: every mutating /api/*
      // request must carry at least one browser-provided header.
      return csrfErrorResponse(response.headers);
    }
  }

  // Cache optimization for Next.js static assets
  if (pathname.startsWith('/_next/static')) {
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/image|favicon.ico).*)'],
};
