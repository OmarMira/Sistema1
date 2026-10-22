import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/auth/register/route';

const mocks = vi.hoisted(() => ({ begin: vi.fn(), identity: vi.fn(), register: vi.fn(), reset: vi.fn(), increment: vi.fn() }));
vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/sessions', () => ({ createSession: vi.fn() }));
vi.mock('@/lib/validate-request', () => ({ validateRequest: (request: NextRequest) => request.json() }));
vi.mock('@/lib/validations/auth', () => ({ registerSchema: {} }));
vi.mock('@/lib/services/auth.service', () => ({ AuthService: { register: mocks.register } }));
vi.mock('@/lib/identity/runtime', () => ({ createIdentityService: mocks.identity }));
vi.mock('@/lib/rate-limiter', () => ({ authRateLimiter: { check: () => ({ success: true }), reset: mocks.reset, increment: mocks.increment } }));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: () => null }));
const user = { id: 'user-1', email: 'test@example.invalid', firstName: 'Test', lastName: 'User', platformRole: 'user' };
const company = { id: 'company-1', legalName: 'Test Company', entityType: 'BUSINESS', taxId: null, isOnboardingComplete: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockReturnValue({ beginRegistration: mocks.begin });
  mocks.begin.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue({ user, company });
});
it.each(['accepted', 'rejected', 'unavailable'])('reports %s delivery without issuing an authenticated session', async (delivery) => {
  if (delivery === 'rejected') mocks.begin.mockRejectedValue(new Error('SMTP delivery rejected: private details'));
  if (delivery === 'unavailable') mocks.identity.mockReturnValue(null);
  const response = await POST(new NextRequest('http://localhost/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: user.email }), headers: { 'content-type': 'application/json' },
  }), { params: Promise.resolve({}) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ requiresVerification: true, deliveryFailed: delivery !== 'accepted', email: user.email,
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.platformRole }, companies: [company] });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(mocks.register).toHaveBeenCalledTimes(1);
  expect(mocks.reset).toHaveBeenCalledTimes(1);
  expect(mocks.increment).not.toHaveBeenCalled();
});
