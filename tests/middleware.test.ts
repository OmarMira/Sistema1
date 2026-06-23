import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy as middleware } from '@/proxy';

function makeRequest(url: string, opts?: { method?: string; headers?: Record<string, string>; cookie?: string }) {
  const headers = new Headers(opts?.headers);
  if (opts?.cookie) {
    headers.set('cookie', opts.cookie);
  }
  return new NextRequest(url, {
    method: (opts?.method as string) ?? 'GET',
    headers,
  });
}

describe('proxy.ts - Session Presence', () => {
  it('returns 401 for API calls without session cookie', async () => {
    const req = makeRequest('http://localhost:3000/api/journal');
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it('allows API calls with session cookie present', async () => {
    const req = makeRequest('http://localhost:3000/api/journal', {
      cookie: 'session=abc123',
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it('allows public API routes without session', async () => {
    const req = makeRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it('allows health endpoint without session', async () => {
    const req = makeRequest('http://localhost:3000/api/health');
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it('allows non-API routes without session (static pages)', async () => {
    const req = makeRequest('http://localhost:3000/dashboard');
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});

describe('proxy.ts - Security Headers', () => {
  it('adds security headers to API responses', async () => {
    const req = makeRequest('http://localhost:3000/api/journal', {
      cookie: 'session=abc123',
    });
    const res = await middleware(req);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });
});

describe('proxy.ts - CSRF Protection', () => {
  it('rejects POST with mismatched Origin header', async () => {
    const req = makeRequest('http://localhost:3000/api/journal', {
      method: 'POST',
      headers: {
        Origin: 'http://hacker.com',
        Host: 'localhost:3000',
      },
      cookie: 'session=abc123',
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it('allows POST without Origin header (API clients)', async () => {
    const req = makeRequest('http://localhost:3000/api/journal', {
      method: 'POST',
      cookie: 'session=abc123',
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it('allows POST with matching Origin header', async () => {
    const req = makeRequest('http://localhost:3000/api/journal', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        Host: 'localhost:3000',
      },
      cookie: 'session=abc123',
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});
