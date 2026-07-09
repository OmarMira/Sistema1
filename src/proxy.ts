import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const isDev = process.env.NODE_ENV === 'development';

function getSecurityHeaders(): Record<string, string> {
  const extraSources = process.env.CSP_SOURCES ? ` ${process.env.CSP_SOURCES}` : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
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

function getCorsOrigin(request: NextRequest): string | null {
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  if (!allowedOriginsEnv) return null;

  const origin = request.headers.get('origin');
  if (!origin) return null;

  const allowed = allowedOriginsEnv.split(',').map((o) => o.trim());
  if (allowed.includes('*')) return '*';
  if (allowed.includes(origin)) return origin;

  // Dev mode: allow localhost variants
  if (isDev) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin;
    } catch {
      return null;
    }
  }

  return null;
}

function corsHeaders(request: NextRequest): Headers | null {
  const corsOrigin = getCorsOrigin(request);
  if (!corsOrigin) return null;

  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', corsOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Company-Id, x-company-id',
  );
  // Credentials only when origin is a specific domain, not wildcard
  if (corsOrigin !== '*') {
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

  const PUBLIC_API_ROUTES = ['/api/auth/login', '/api/auth/register', '/api/health', '/api/bootstrap/check', '/api/bootstrap/restore'];

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
    }
    // No origin AND no referer — likely a non-browser client (CLI, webhook, server-to-server).
    // Browsers always send Origin or Referer on cross-origin requests, so absence means
    // the request is not browser-initiated and CSRF is not applicable.
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
