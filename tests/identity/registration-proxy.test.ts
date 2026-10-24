import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../../src/proxy';

const origin = 'http://localhost:3000';
function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, {
    method: 'POST', headers: { host: 'localhost:3000', origin, ...headers },
  });
}

describe('registration proxy boundary', () => {
  it.each(['/api/auth/verify', '/api/auth/resend-verification'])('allows %s without a session, preserving CSRF', async (path) => {
    const response = await proxy(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    const rejected = await proxy(request(path, { origin: 'https://attacker.invalid' }));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'CSRF validation failed: Origin mismatch', code: 'CSRF_ERROR' });
    expect(rejected.headers.get('x-frame-options')).toBe('DENY');
  });
  it.each(['/api/auth/login', '/api/auth/register', '/api/health', '/api/bootstrap/check', '/api/bootstrap/restore'])('keeps existing public path %s accessible', async (path) => {
    const response = await proxy(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
  it.each(['/api/auth/me', '/api/admin/users', '/api/auth/verify/extra'])('keeps %s protected', async (path) => {
    const response = await proxy(request(path));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('preserves authenticated requests and rejects mutations without browser origin', async () => {
    expect((await proxy(request('/api/auth/me', { authorization: 'Bearer test-session' }))).status).toBe(200);
    const req = request('/api/auth/register');
    req.headers.delete('origin');
    const response = await proxy(req);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('CSRF_ERROR');
  });
});
