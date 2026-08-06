import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getClientIp, getClientIpSource } from '@/lib/security/client-ip';

function requestWithXff(value: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (value !== null) headers['x-forwarded-for'] = value;
  return new NextRequest('http://localhost/api/test', { headers });
}

describe('client-ip — getClientIp / getClientIpSource', () => {
  beforeEach(() => {
    delete process.env.CLIENT_IP_SOURCE;
  });

  afterEach(() => {
    delete process.env.CLIENT_IP_SOURCE;
  });

  it('defaults to CLIENT_IP_SOURCE=none when env is unset', () => {
    expect(getClientIpSource()).toBe('none');
  });

  it('CLIENT_IP_SOURCE=none ignores every IP header and returns null', () => {
    process.env.CLIENT_IP_SOURCE = 'none';
    expect(getClientIp(requestWithXff('203.0.113.10'))).toBeNull();
    expect(getClientIp(requestWithXff('10.0.0.1, 203.0.113.10'))).toBeNull();
    expect(getClientIp(requestWithXff(null))).toBeNull();
  });

  describe('trusted-x-forwarded-for', () => {
    beforeEach(() => {
      process.env.CLIENT_IP_SOURCE = 'trusted-x-forwarded-for';
    });

    it('accepts a valid IPv4 as the first element', () => {
      expect(getClientIp(requestWithXff('203.0.113.10'))).toBe('203.0.113.10');
    });

    it('accepts a valid IPv6', () => {
      expect(getClientIp(requestWithXff('2001:db8::1'))).toBe('2001:db8::1');
    });

    it('truncates a comma-separated chain to the first element', () => {
      expect(getClientIp(requestWithXff('203.0.113.10, 198.51.100.9'))).toBe('203.0.113.10');
    });

    it('rejects an invalid IPv4 (octet out of range)', () => {
      expect(getClientIp(requestWithXff('999.999.999.999'))).toBeNull();
    });

    it('rejects a malformed IPv6', () => {
      expect(getClientIp(requestWithXff('2001:db8::gggg'))).toBeNull();
    });

    it('rejects non-IP values', () => {
      expect(getClientIp(requestWithXff('not-an-ip'))).toBeNull();
    });

    it('returns null when the header is absent', () => {
      expect(getClientIp(requestWithXff(null))).toBeNull();
    });
  });

  it('an unknown CLIENT_IP_SOURCE throws a configuration error (no silent fallback)', () => {
    process.env.CLIENT_IP_SOURCE = 'vercel';
    expect(() => getClientIpSource()).toThrow(/not supported/);
    expect(() => getClientIp(requestWithXff('203.0.113.10'))).toThrow(/not supported/);
  });
});
