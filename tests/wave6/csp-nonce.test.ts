/**
 * Wave 6 — S2: nonce-based CSP behind the opt-in `CSP_SCRIPT_NONCE` flag.
 *
 * Contract pinned here:
 *  (a) flag ON  + production -> `script-src 'self' 'nonce-<v>' 'strict-dynamic'`
 *      with no 'unsafe-inline' and no 'unsafe-eval';
 *  (b) the same nonce is forwarded to the server components through the
 *      `x-nonce` REQUEST header (observable as the x-middleware-request-* pair)
 *      and through the request's own CSP header, so Next.js can stamp it on its
 *      inline bootstrap scripts; a fresh nonce is minted per request;
 *  (c) flag OFF (default) and development keep today's policy — the flag is
 *      opt-in only, because Next.js can only apply a nonce to DYNAMICALLY
 *      rendered pages and this app's SPA entry `/` is prerendered;
 *  (d) `style-src` always keeps 'unsafe-inline' (documented residual: style
 *      injection is a lower risk than script injection and Tailwind/shadcn
 *      inject styles at runtime).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

/** The `name` directive of a served CSP header. */
function directiveOf(csp: string | null, name: string): string {
  const found = (csp ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name);
  if (!found) throw new Error(`no ${name} directive in: ${csp}`);
  return found;
}

function nonceOf(scriptSrc: string): string {
  const match = /'nonce-([^']+)'/.exec(scriptSrc);
  if (!match) throw new Error(`no nonce source in: ${scriptSrc}`);
  return match[1];
}

/** A page (non-API) navigation — the only place a CSP for scripts matters. */
function pageRequest(pathname: string) {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: 'GET',
    headers: { host: 'localhost:3000' },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── (a) flag ON in production: strict nonce policy ───────────────────

describe('S2 (a) — CSP_SCRIPT_NONCE=1 in production ships a nonce policy', () => {
  it("script-src carries 'nonce-<value>' + 'strict-dynamic' and no unsafe-*", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSP_SCRIPT_NONCE', '1');

    const res = await proxy(pageRequest('/dashboard'));
    const csp = res.headers.get('Content-Security-Policy');
    const scriptSrc = directiveOf(csp, 'script-src');

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    // A real, browser-usable base64 nonce (not a placeholder).
    const nonce = nonceOf(scriptSrc);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{16,}={0,2}$/);

    // The rest of the policy is untouched by the nonce rollout.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

// ─── (b) the nonce reaches the server through x-nonce ─────────────────

describe('S2 (b) — production nonce is forwarded via the x-nonce request header', () => {
  it('sets x-nonce (and the request CSP) to the same value the response CSP carries', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSP_SCRIPT_NONCE', '1');

    const res = await proxy(pageRequest('/dashboard'));
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const nonce = nonceOf(directiveOf(csp, 'script-src'));

    // NextResponse.next({ request }) forwards request headers as an
    // override list plus one x-middleware-request-* entry per header.
    expect(res.headers.get('x-middleware-override-headers')).toContain('x-nonce');
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    // Next.js parses the nonce out of the CSP header present on the REQUEST.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('mints a fresh nonce per request', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSP_SCRIPT_NONCE', '1');

    const first = nonceOf(
      directiveOf(
        (await proxy(pageRequest('/dashboard'))).headers.get('Content-Security-Policy'),
        'script-src',
      ),
    );
    const second = nonceOf(
      directiveOf(
        (await proxy(pageRequest('/dashboard'))).headers.get('Content-Security-Policy'),
        'script-src',
      ),
    );

    expect(first).not.toBe(second);
  });
});

// ─── (c) flag OFF and development keep the current policy ─────────────

describe('S2 (c) — the nonce is opt-in: default production and dev are unchanged', () => {
  it("PRESERVE: production without the flag keeps 'unsafe-inline', no nonce, no unsafe-eval", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSP_SCRIPT_NONCE', '');

    const res = await proxy(pageRequest('/dashboard'));
    const scriptSrc = directiveOf(res.headers.get('Content-Security-Policy'), 'script-src');

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain('nonce-');
    // Nothing is forwarded to the server: the response is a bare pass-through.
    expect(res.headers.get('x-middleware-request-x-nonce')).toBeNull();
    expect(res.headers.get('x-middleware-override-headers')).toBeNull();
  });

  it('development ignores the flag and keeps unsafe-eval + unsafe-inline', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CSP_SCRIPT_NONCE', '1');

    const res = await proxy(pageRequest('/dashboard'));
    const scriptSrc = directiveOf(res.headers.get('Content-Security-Policy'), 'script-src');

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('nonce-');
  });
});

// ─── (d) style-src residual, in every mode ────────────────────────────

describe("S2 (d) — style-src always keeps 'unsafe-inline' (documented residual)", () => {
  it('holds with the nonce flag on, off, and in development', async () => {
    for (const env of [
      { NODE_ENV: 'production', CSP_SCRIPT_NONCE: '1' },
      { NODE_ENV: 'production', CSP_SCRIPT_NONCE: '' },
      { NODE_ENV: 'development', CSP_SCRIPT_NONCE: '1' },
    ]) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

      const styleSrc = directiveOf(
        (await proxy(pageRequest('/dashboard'))).headers.get('Content-Security-Policy'),
        'style-src',
      );

      expect(styleSrc, JSON.stringify(env)).toBe("style-src 'self' 'unsafe-inline'");
    }
  });
});

// ─── PRESERVE: the nonce rollout does not disturb the auth/CORS paths ─

describe('S2 PRESERVE — nonce rollout leaves the session gate and preflight intact', () => {
  it('still answers 401 AUTH_REQUIRED for an unauthenticated API call (flag on)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSP_SCRIPT_NONCE', '1');

    const res = await proxy(
      new NextRequest('http://localhost:3000/api/journal', {
        method: 'GET',
        headers: { host: 'localhost:3000' },
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    // Security headers still ride along on the rejection.
    expect(directiveOf(res.headers.get('Content-Security-Policy'), 'script-src')).toContain(
      "'strict-dynamic'",
    );
  });

  it('still answers 204 for a CORS preflight (flag on)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSP_SCRIPT_NONCE', '1');
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com');

    const res = await proxy(
      new NextRequest('http://localhost:3000/api/journal', {
        method: 'OPTIONS',
        headers: { host: 'localhost:3000', origin: 'https://app.example.com' },
      }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
  });
});
