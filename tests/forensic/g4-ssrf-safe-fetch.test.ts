import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import dns from 'dns';
import https from 'https';
import { Readable } from 'stream';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { clearDatabase, createTestCompany, createTestCompanyMember } from '../helpers/factories';
import { validateSafeUrl, safeFetch, isPrivateIp, resolveSafeTarget } from '@/lib/security/safe-fetch';

function mockDnsPublic() {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
}

function mockDnsPrivate() {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
}

function mockHttpsResponseOnce(
  statusCode: number,
  headers: Record<string, string>,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(https, 'request').mockImplementation(
    ((_url: URL, _opts: unknown, cb: (res: unknown) => void) => {
      const res = Readable.from([]) as unknown as {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
      } & NodeJS.ReadableStream;
      res.statusCode = statusCode;
      res.statusMessage = 'Found';
      res.headers = headers;
      cb(res);
      const req = { on: () => {}, end: () => {}, write: () => {} } as unknown as https.ClientRequest;
      return req;
    }) as unknown as typeof https.request,
  );
}

describe('G4-RC1 — SSRF: safe-fetch URL policy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows public https URL (dns resolves to public IP)', async () => {
    mockDnsPublic();
    const normalized = await validateSafeUrl('https://example.com/v1/chat');
    expect(normalized).toBe('https://example.com/v1/chat');
  });

  it('blocks localhost via explicit host alias (0 fetch calls)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
    await expect(safeFetch('http://localhost/chat', { timeoutMs: 50 })).rejects.toThrow(/private|localhost/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks loopback 127.0.0.1, RFC1918 and rejects before fetch (0 calls)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
    await expect(safeFetch('http://127.0.0.1/chat', { timeoutMs: 50 })).rejects.toThrow(/private/);
    await expect(safeFetch('http://10.0.0.5/chat', { timeoutMs: 50 })).rejects.toThrow(/private/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks ::1 loopback IPv6', async () => {
    await expect(validateSafeUrl('http://[::1]/chat')).rejects.toThrow(/private/);
  });

  it('blocks IPv4-mapped IPv6 loopback in every equivalent representation', () => {
    // dotted form
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    // Node-normalized hex form of ::ffff:127.0.0.1
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 RFC1918 in every equivalent representation', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:a00:1')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:c0a8:101')).toBe(true);
    expect(isPrivateIp('::ffff:172.16.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:ac10:1')).toBe(true);
  });

  it('allows IPv4-mapped IPv6 of a public IPv4', () => {
    expect(isPrivateIp('::ffff:93.184.216.34')).toBe(false);
    expect(isPrivateIp('::ffff:5db8:d822')).toBe(false);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIp('::ffff:808:808')).toBe(false);
  });

  it('blocks mapped IPv6 via validateSafeUrl after Node URL normalization', async () => {
    // new URL() normalizes http://[::ffff:127.0.0.1]/ to [::ffff:7f00:1]
    await expect(validateSafeUrl('http://[::ffff:127.0.0.1]/chat')).rejects.toThrow(/private/);
    await expect(validateSafeUrl('http://[::ffff:7f00:1]/chat')).rejects.toThrow(/private/);
    await expect(validateSafeUrl('http://[::ffff:10.0.0.1]/chat')).rejects.toThrow(/private/);
    await expect(validateSafeUrl('http://[::ffff:a00:1]/chat')).rejects.toThrow(/private/);
  });

  it('flags RFC1918 / CGNAT boundaries correctly', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
    expect(isPrivateIp('100.63.255.255')).toBe(false);
  });

  it('flags CGNAT, link-local and reserved special-use ranges', () => {
    expect(isPrivateIp('192.0.0.1')).toBe(true);
    expect(isPrivateIp('192.0.2.1')).toBe(true);
    expect(isPrivateIp('198.18.0.1')).toBe(true);
    expect(isPrivateIp('198.51.100.1')).toBe(true);
    expect(isPrivateIp('203.0.113.1')).toBe(true);
    expect(isPrivateIp('0.0.0.1')).toBe(true);
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('blocks link-local and cloud metadata', async () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    await expect(validateSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private/);
  });

  it('blocks public hostname whose DNS resolves to a private IP', async () => {
    mockDnsPrivate();
    await expect(validateSafeUrl('http://metadata.internal/chat')).rejects.toThrow(/resolves to blocked IP/);
  });

  it('pins a hostname to the validated addresses (DNS rebinding protected)', async () => {
    vi.spyOn(dns.promises, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const { lookup, validatedAddresses } = await resolveSafeTarget('https://example.com/chat');
    expect(validatedAddresses).toEqual(['93.184.216.34']);
    // a rebound DNS answer must NOT change the pinned target
    const rebound = await new Promise<{ address: string }[]>((resolve, reject) =>
      lookup('example.com', { all: true }, (err: Error | null, addrs: { address: string }[]) =>
        err ? reject(err) : resolve(addrs),
      ),
    );
    expect(rebound.map((a) => a.address)).toEqual(['93.184.216.34']);
  });

  it('pins the connection: https.request receives a lookup that ignores DNS rebinding', async () => {
    // Hop validation resolves the hostname ONCE to a public IP.
    const lookupSpy = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    // After validation, DNS "rebinds" to the metadata endpoint.
    mockDnsPrivate();

    let pinnedLookup: ((hostname: string, options: unknown, callback: (err: unknown, addrs?: unknown, family?: number) => void) => void) | undefined;
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(
      ((_url: URL, opts: { lookup?: unknown }, cb: (res: unknown) => void) => {
        pinnedLookup = opts.lookup as typeof pinnedLookup;
        const res = Readable.from([]) as unknown as {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        } & NodeJS.ReadableStream;
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = {};
        cb(res);
        const req = { on: () => {}, end: () => {}, write: () => {} } as unknown as https.ClientRequest;
        return req;
      }) as unknown as typeof https.request,
    );

    const response = await safeFetch('https://public.example.com/chat', { timeoutMs: 500 });
    expect(response.status).toBe(200);

    // 1) dns.promises.lookup was called exactly once for this hop.
    expect(lookupSpy).toHaveBeenCalledTimes(1);

    // 2) The connection received the pinned lookup function.
    expect(pinnedLookup).toBeDefined();

    // 3) Invoking the pinned lookup AFTER DNS rebinding still returns ONLY the validated public IP.
    //    Capture EXACTLY what the pinned lookup delivers — never hardcode the expected result inside
    //    the callback under test. With { all: true } the pinned lookup delivers the addresses array.
    const bound = await new Promise<{ address: string; family: number }[]>((resolve, reject) =>
      pinnedLookup!('public.example.com', { all: true }, (err, addrs) => {
        if (err) reject(err);
        else resolve((addrs as { address: string; family: number }[]) ?? []);
      }),
    );
    expect(Array.isArray(bound)).toBe(true);
    expect(bound.map((b) => b.address)).toEqual(['93.184.216.34']);
    expect(bound.some((b) => b.address === '169.254.169.254')).toBe(false);

    // 4) Only ONE connection was attempted, to the public destination.
    expect(httpsSpy).toHaveBeenCalledTimes(1);
    expect(String(httpsSpy.mock.calls[0][0])).toBe('https://public.example.com/chat');
  });

  it('single DNS resolution per hop even across a public→public redirect', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as any);
    let hop = 0;
    vi.spyOn(https, 'request').mockImplementation(
      ((_url: URL, _opts: unknown, cb: (res: unknown) => void) => {
        hop++;
        const res = Readable.from([]) as unknown as {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        } & NodeJS.ReadableStream;
        res.statusCode = hop === 1 ? 302 : 200;
        res.statusMessage = 'Found';
        res.headers = hop === 1 ? { location: 'https://public.example.com/v2' } : {};
        cb(res);
        const req = { on: () => {}, end: () => {}, write: () => {} } as unknown as https.ClientRequest;
        return req;
      }) as unknown as typeof https.request,
    );

    const response = await safeFetch('https://public.example.com/v1', { timeoutMs: 500 });
    expect(response.status).toBe(200);
    // one lookup per hop, two public hops total
    expect(lookupSpy).toHaveBeenCalledTimes(2);
  });

  it('blocks embedded credentials in URL', async () => {
    await expect(validateSafeUrl('http://user:pass@httpbin.org/chat')).rejects.toThrow(/credentials/);
  });

  it('controls ports (only 80/443)', async () => {
    mockDnsPublic();
    await expect(validateSafeUrl('https://example.com:8443/chat')).rejects.toThrow(/port/i);
    await expect(validateSafeUrl('https://example.com:443/chat')).resolves.toBeTruthy();
  });

  it('blocks redirect towards private destination (re-validates each hop)', async () => {
    mockDnsPublic();
    const httpsSpy = mockHttpsResponseOnce(302, {
      location: 'http://169.254.169.254/latest/meta-data/',
    });
    await expect(safeFetch('https://example.com/redirect', { timeoutMs: 50 })).rejects.toThrow(/private/);
    // only the public hop was requested; the private target was validated and refused
    expect(httpsSpy).toHaveBeenCalledTimes(1);
    expect(String(httpsSpy.mock.calls[0][0])).toBe('https://example.com/redirect');
  });

  it('applies timeout and never completes a hanging request', async () => {
    mockDnsPublic();
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(
      ((_url: URL, opts: { signal?: AbortSignal }, _cb: (res: unknown) => void) => {
        const events: Record<string, () => void> = {};
        const req = {
          on: (event: string, handler: (...args: unknown[]) => void) => {
            events[event] = handler;
            return req;
          },
          end: () => {},
          write: () => {},
          emit: (event: string, ...args: unknown[]) => (events[event] ? events[event](...args) : false),
        } as unknown as https.ClientRequest;
        opts.signal?.addEventListener('abort', () => req.emit('error', new Error('The operation was aborted')));
        return req;
      }) as unknown as typeof https.request,
    );
    const err = await safeFetch('https://example.com/long', { timeoutMs: 50 }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/aborted|abort/i);
    expect(httpsSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the per-hop timer and external abort listener on failure', async () => {
    mockDnsPublic();
    const external = new AbortController();
    const listenerSpy = {
      added: 0,
      removed: 0,
    };
    vi.spyOn(external.signal, 'addEventListener').mockImplementation((() => {
      listenerSpy.added++;
    }) as never);
    vi.spyOn(external.signal, 'removeEventListener').mockImplementation((() => {
      listenerSpy.removed++;
    }) as never);

    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(
      ((_url: URL, _opts: unknown, _cb: (res: unknown) => void) => {
        const events: Record<string, (...args: unknown[]) => void> = {};
        const req = {
          on: (event: string, handler: (...args: unknown[]) => void) => {
            events[event] = handler;
            return req;
          },
          end: () => {},
          write: () => {},
          emit: (event: string, ...args: unknown[]) => {
            if (events[event]) {
              events[event](...args);
              return true;
            }
            return false;
          },
        } as unknown as https.ClientRequest;
        setTimeout(() => req.emit('error', new Error('connection refused')), 5);
        return req;
      }) as unknown as typeof https.request,
    );

    const err = await safeFetch('https://example.com/fail', { timeoutMs: 1000, signal: external.signal }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/connection refused/);
    // the external abort listener must have been removed after the hop failed
    expect(listenerSpy.added).toBe(1);
    expect(listenerSpy.removed).toBe(1);
    expect(httpsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('RC2-P04 — requireGlobalAdminRole global-only gate', () => {
  let createdCompanyIds: string[] = [];

  beforeEach(async () => {
    createdCompanyIds = [];
    vi.restoreAllMocks();
    await clearDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
    if (createdCompanyIds.length) {
      await db.companyMember.deleteMany({ where: { companyId: { in: createdCompanyIds } } }).catch(() => {});
      await db.company.deleteMany({ where: { id: { in: createdCompanyIds } } }).catch(() => {});
    }
  });

  async function callVerify(userId: string, mockHttp: boolean) {
    return callVerifyWithBase(userId, mockHttp, 'https://public.example.com');
  }

  async function callVerifyWithBase(userId: string, mockHttp: boolean, baseUrl: string) {
    if (mockHttp) {
      mockDnsPublic();
      mockHttpsResponseOnce(200, {});
    }
    const token = await createSession(userId);
    const req = new NextRequest('http://localhost/api/config/ai/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ apiKey: 'sk-test-api-key', baseUrl }),
    });
    const { POST } = await import('@/app/api/config/ai/verify/route');
    return POST(req, { params: Promise.resolve({}) });
  }

  it('A: User.role=super_admin — access granted to global AI config', async () => {
    const user = await db.user.create({
      data: {
        email: 'rc2-super@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Test',
        lastName: 'Super',
        role: 'super_admin',
      },
    });
    const res = await callVerify(user.id, true);
    expect(res.status).toBe(200);
  });

  it('B: User.role=user — 403 on global AI config', async () => {
    const user = await db.user.create({
      data: {
        email: 'rc2-user@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Test',
        lastName: 'User',
        role: 'user',
      },
    });
    const res = await callVerify(user.id, false);
    expect(res.status).toBe(403);
  });

  it('C: User.role=user + CompanyMember.role=company_admin — 403 on global AI config (tenant authority does NOT grant global access)', async () => {
    const user = await db.user.create({
      data: {
        email: 'rc2-tenant-admin@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Test',
        lastName: 'TenantAdmin',
        role: 'user',
      },
    });
    const company = await createTestCompany('RC2 Tenant');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.push(company.id);

    const res = await callVerify(user.id, false);
    expect(res.status).toBe(403);
  });
});

describe('G4-RC1 — SSRF: /api/config/ai/verify authorization gate', () => {
  let createdCompanyIds: string[] = [];

  beforeEach(async () => {
    createdCompanyIds = [];
    vi.restoreAllMocks();
    await clearDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
    if (createdCompanyIds.length) {
      await db.companyMember.deleteMany({ where: { companyId: { in: createdCompanyIds } } }).catch(() => {});
      await db.company.deleteMany({ where: { id: { in: createdCompanyIds } } }).catch(() => {});
    }
  });

  it('a non-admin member cannot call verify: status 403 and outbound fetch = 0', async () => {
    const user = await db.user.create({
      data: {
        email: 'g4-viewer@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Test',
        lastName: 'Viewer',
        role: 'user',
      },
    });
    const company = await createTestCompany('G4 Tenant');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.push(company.id);

    const fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
    const token = await createSession(user.id);
    const req = new NextRequest('http://localhost/api/config/ai/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ apiKey: 'sk-test-api-key', baseUrl: 'https://public.example.com' }),
    });
    const { POST } = await import('@/app/api/config/ai/verify/route');
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});