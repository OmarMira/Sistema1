import dns from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';
import { Readable } from 'stream';

/**
 * Fail-closed SSRF policy: only publicly routable destinations are allowed.
 * Returns true when the address must be blocked (reserved/private/special).
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return ipv4IsBlocked(ip.split('.').map(Number));
  }

  if (net.isIPv6(ip)) {
    // Canonicalize through Node's own URL normalizer so every equivalent
    // representation (dotted IPv4-mapped, full 8-group, compressed, etc.)
    // collapses to the same compact form before classification. This prevents
    // representation-based bypasses such as ::ffff:7f00:1 (hex form of
    // ::ffff:127.0.0.1) slipping past a textual dotted-only comparison.
    const normalized = canonicalIpv6(ip);

    // Loopback / unspecified
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized === '0:0:0:0:0:0:0:1' ||
      normalized === '0:0:0:0:0:0:0:0'
    ) {
      return true;
    }
    // Unique Local Addresses (fc00::/7)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // Link-Local (fe80::/10) and Site-Local (fec0::/10)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('fec') ||
      normalized.startsWith('fed') ||
      normalized.startsWith('fee') ||
      normalized.startsWith('fef')
    ) {
      return true;
    }
    // Multicast (ff00::/8)
    if (normalized.startsWith('ff')) return true;
    // Documentation (2001:db8::/32)
    if (normalized.startsWith('2001:db8')) return true;

    // IPv4-mapped IPv6 (::ffff:7f00:1 or ::ffff:127.0.0.1, etc.). Decode the
    // 32-bit suffix deterministically and re-classify it as the embedded IPv4.
    if (normalized.startsWith('::ffff:')) {
      const mapped = decodeMappedIpv4(normalized);
      if (mapped !== null) {
        return isPrivateIp(mapped);
      }
      // Unparseable mapped suffix (e.g. malformed hex) fails closed.
      return true;
    }

    return false;
  }

  // Unknown input fails closed
  return true;
}

/**
 * Collapses any IPv6 textual representation into Node's canonical compact form
 * (lowercased, ::-compressed, IPv4-mapped as hex) by round-tripping through
 * `new URL()`. Returns the raw input lowercased/trimmed if normalization fails.
 */
function canonicalIpv6(ip: string): string {
  try {
    const hostname = new URL(`http://[${ip.toLowerCase().trim()}]/`).hostname;
    return hostname.replace(/^\[|\]$/g, '');
  } catch {
    return ip.toLowerCase().trim();
  }
}

/**
 * Extracts the embedded IPv4 from an IPv4-mapped IPv6 address of the form
 * `::ffff:<suffix>`, where <suffix> is either a dotted quad or one/two hex
 * groups covering exactly 32 bits. Returns the dotted-quad string, or null
 * when the suffix is not a valid 32-bit IPv4-mapped payload.
 */
function decodeMappedIpv4(normalized: string): string | null {
  const suffix = normalized.substring('::ffff:'.length);

  if (net.isIPv4(suffix)) {
    return suffix;
  }

  const groups = suffix.split(':');
  if (groups.length < 1 || groups.length > 2) return null;
  let value = 0;
  for (const group of groups) {
    if (group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/.test(group)) {
      return null;
    }
    value = (value << 16) + parseInt(group, 16);
  }
  // Two hex groups are required to cover a full 32-bit IPv4; a single group
  // (16 bits) is not a complete mapped address and fails closed.
  if (groups.length !== 2) return null;

  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function ipv4IsBlocked([a, b, c]: number[]): boolean {
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // Private class A
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // Loopback
  if (a === 169 && b === 254) return true; // Link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // Private class B
  if (a === 192 && b === 168) return true; // Private class C
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a >= 224) return true; // Multicast + reserved/broadcast
  return false;
}

function assertSafeUrlSyntax(urlStr: string): { url: URL; hostname: string } {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid protocol: Only HTTP and HTTPS are allowed');
  }

  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  // Port policy: only standard 80/443 ports allowed. Verified against the real
  // product contract (2026-08-13): all AI providers shipped in
  // src/lib/constants/ai-config.ts are public HTTPS endpoints on 443, and no
  // docs, .env.example, tests or rules reference custom ports, Ollama/localhost
  // or any private AI endpoint. Policy is derived from product evidence, not an
  // assumption. If a custom-port or local provider is ever required, revisit
  // this gate with explicit evidence instead of silently relaxing it.
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('Only standard HTTP (80) and HTTPS (443) ports are allowed');
  }

  const hostname = normalizeHostname(url.hostname);
  if (hostname === 'localhost' || hostname === 'localhost.' || hostname === '0') {
    throw new Error(`Access to private/reserved host is blocked: ${hostname}`);
  }

  return { url, hostname };
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

type DnsLookupResult = { address: string; family: number };
type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrAddresses?: string | DnsLookupResult[],
  family?: number,
) => void;

interface DnsLookupAllOptions {
  all: true;
}
interface DnsLookupOneOptions {
  all?: false;
}
type DnsLookupRequestOptions = DnsLookupAllOptions | DnsLookupOneOptions;

export interface ResolvedSafeTarget {
  lookup: (
    hostname: string,
    options: DnsLookupRequestOptions,
    callback: DnsLookupCallback,
  ) => void;
  validatedAddresses: string[];
}

/**
 * Resolves a hostname exactly once and pins the connection to the validated
 * addresses. A public hostname that resolves to a blocked IP is rejected before
 * any socket is opened. This removes the DNS TOCTOU / rebinding window between
 * validation and connection because net.connect receives these same addresses.
 */
export async function resolveSafeTarget(urlStr: string): Promise<ResolvedSafeTarget> {
  const { url, hostname } = assertSafeUrlSyntax(urlStr);

  let addresses: DnsLookupResult[] = [];

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Access to private/reserved IP is blocked: ${hostname}`);
    }
    const family = net.isIPv4(hostname) ? 4 : 6;
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = (await dns.promises.lookup(hostname, { all: true, verbatim: true })) as DnsLookupResult[];
    } catch (lookupError) {
      throw new Error(`DNS resolution failed for ${hostname}`, { cause: lookupError });
    }
    if (addresses.length === 0) {
      throw new Error(`DNS resolution failed for ${hostname}`);
    }
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        throw new Error(`Hostname ${hostname} resolves to blocked IP: ${addr.address}`);
      }
    }
  }

  const validatedAddresses = addresses.map((a) => a.address);

  return {
    validatedAddresses,
    lookup: (
      host: string,
      opts: DnsLookupRequestOptions,
      callback: DnsLookupCallback,
    ) => {
      if (opts && 'all' in opts && opts.all) {
        callback(null, addresses);
      } else {
        const first = addresses[0];
        callback(null, first.address, first.family);
      }
    },
  };
}

/**
 * Validates a URL against the SSRF policy, resolving DNS for hostnames.
 * Convenience wrapper kept for save/validation paths; connection pinning is
 * performed by safeFetch via resolveSafeTarget.
 */
export async function validateSafeUrl(urlStr: string): Promise<string> {
  const { url, hostname } = assertSafeUrlSyntax(urlStr);

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Access to private/reserved IP is blocked: ${hostname}`);
    }
    return url.toString();
  }

  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new Error(`Hostname ${hostname} resolves to blocked IP: ${addr.address}`);
    }
  }
  return url.toString();
}

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * SSRF-safe fetch. Resolves and validates the destination ONCE, then performs
 * the real request via Node's http/https with an explicit `lookup` that returns
 * exactly the validated addresses — so the connection cannot go to a different
 * (e.g. rebound) IP. Redirects are handled manually and each hop is re-validated
 * with the same pinning. Timeout is applied to every request.
 */
export async function safeFetch(
  urlStr: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxRedirects = options.maxRedirects ?? 5;

  let currentUrl = urlStr;
  let redirectCount = 0;

  while (true) {
    const { lookup, validatedAddresses } = await resolveSafeTarget(currentUrl);
    const hostname = normalizeHostname(new URL(currentUrl).hostname);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let res: Response;
    try {
      res = await rawRequest(
        currentUrl,
        {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: options.body,
          lookup,
          signal: controller.signal,
        },
        validatedAddresses,
        hostname,
      );
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return res;
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error('Too many redirects');
      }

      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }
}

function rawRequest(
  urlStr: string,
  options: {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    lookup: ResolvedSafeTarget['lookup'];
    signal?: AbortSignal;
  },
  validatedAddresses: string[],
  hostname: string,
): Promise<Response> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        lookup: options.lookup as net.LookupFunction,
        signal: options.signal,
        hostname,
      } as https.RequestOptions,
      (res) => {
        let body: BodyInit;
        try {
          body = Readable.toWeb(res) as unknown as BodyInit;
        } catch {
          body = '';
        }
        resolve(
          new Response(body, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage,
            headers: res.headers as unknown as HeadersInit,
          }),
        );
      },
    );

    req.on('error', (err) => {
      const message = err?.message ?? String(err);
      reject(new Error(`safeFetch failed: ${message} (validated: ${validatedAddresses.join(', ')})`));
    });

    if (options.body) {
      req.write(options.body as string | Buffer);
    }
    req.end();
  });
}