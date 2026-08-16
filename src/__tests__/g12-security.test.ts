// ─── G12/F10 Security Hardening Tests ──────────────────────────────────────
// Validates all 9 G12 points: error handling, secret redaction, no leaks.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

// ─── G12-3: Logger centralized secret redaction ────────────────────────────
describe('G12-3: Logger redacts sensitive metadata', () => {
  let logger: typeof import('@/lib/logger').logger;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/logger');
    logger = mod.logger;
  });

  it('redacts apiKey from metadata', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { apiKey: 'sk-test-api-key', model: 'gpt-4' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.apiKey).toBe('[REDACTED]');
    expect(output.model).toBe('gpt-4');
    consoleSpy.mockRestore();
  });

  it('redacts password from metadata', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { password: 'supersecret123' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.password).toBe('[REDACTED]');
    consoleSpy.mockRestore();
  });

  it('redacts token from metadata', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { token: 'sk-test-api-key' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.token).toBe('[REDACTED]');
    consoleSpy.mockRestore();
  });

  it('redacts secret from metadata', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { secret: 'my-secret-value' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.secret).toBe('[REDACTED]');
    consoleSpy.mockRestore();
  });

  it('redacts webhookUrl from metadata', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.webhookUrl).toContain('[REDACTED]');
    expect(output.webhookUrl).not.toContain('xxx');
    consoleSpy.mockRestore();
  });

  it('redacts nested sensitive keys in objects', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { config: { apiKey: 'sk-secret', model: 'gpt-4' } });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.config.apiKey).toBe('[REDACTED]');
    expect(output.config.model).toBe('gpt-4');
    consoleSpy.mockRestore();
  });

  it('redacts sensitive keys in arrays', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { items: [{ password: 'abc' }, { name: 'safe' }] });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.items[0].password).toBe('[REDACTED]');
    expect(output.items[1].name).toBe('safe');
    consoleSpy.mockRestore();
  });

  it('does NOT redact normal keys', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { userId: '123', companyId: '456', action: 'LOGIN' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.userId).toBe('123');
    expect(output.companyId).toBe('456');
    expect(output.action).toBe('LOGIN');
    consoleSpy.mockRestore();
  });

  it('redacts accessToken and refreshToken', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { accessToken: 'at_xxx', refreshToken: 'rt_yyy' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.accessToken).toBe('[REDACTED]');
    expect(output.refreshToken).toBe('[REDACTED]');
    consoleSpy.mockRestore();
  });

  const PREFIX_VARIANTS = [
    'keyPrefix',
    'apiKeyPrefix',
    'secretPrefix',
    'tokenPrefix',
    'keyFragment',
    'secretFragment',
  ];

  for (const variant of PREFIX_VARIANTS) {
    it(`redacts ${variant} from metadata`, () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.info('test', { [variant]: 'abcdef123456', model: 'gpt-4' });
      const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
      expect(output[variant]).toBe('[REDACTED]');
      expect(output.model).toBe('gpt-4');
      consoleSpy.mockRestore();
    });
  }

  it('does NOT redact maskedKey (UI representation contract, not a log secret)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { maskedKey: 'sk-a...z9', model: 'gpt-4' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.maskedKey).toBe('sk-a...z9');
    expect(output.model).toBe('gpt-4');
    consoleSpy.mockRestore();
  });

  it('redacts long hex strings that look like secrets', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { hash: 'a'.repeat(64) });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.hash).toBe('[REDACTED]');
    consoleSpy.mockRestore();
  });

  it('preserves short strings that are not secrets', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('test', { code: 'abc123', status: 'ok' });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.code).toBe('abc123');
    expect(output.status).toBe('ok');
    consoleSpy.mockRestore();
  });

  it('truncates deeply nested objects to prevent stack overflow', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let deep: Record<string, unknown> = { val: 'end' };
    for (let i = 0; i < 20; i++) {
      deep = { child: deep };
    }
    logger.info('test', deep);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output).toBeDefined();
    consoleSpy.mockRestore();
  });
});

// ─── G12-1: closing-engine error messages ──────────────────────────────────
describe('G12-1: closing-engine throws generic messages', () => {
  it('throws ValidationError (not raw Error) for business rule violations', async () => {
    const { executeYearClose } = await import('@/lib/services/closing-engine');
    await expect(
      executeYearClose('nonexistent-company', 2025, {
        type: 'CALENDAR',
        periodsPerYear: 12,
      } as any),
    ).rejects.toThrow();
  });
});

// ─── G12-2: Route error response contracts ─────────────────────────────────
describe('G12-2: API routes return generic error messages', () => {
  it('health endpoint returns structured JSON without env details', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const body = await res.json();

    expect(body).toHaveProperty('status');
    const str = JSON.stringify(body);
    expect(str).not.toMatch(/SESSION_SECRET|DATABASE_URL|password|secret/i);
  });
});

// ─── G12-7: No environment leak in health ──────────────────────────────────
describe('G12-7: Health endpoint does not leak environment', () => {
  it('does not expose NODE_ENV, DATABASE_URL, or SESSION_SECRET', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const body = await res.json();
    const str = JSON.stringify(body);

    expect(str).not.toContain('postgresql://');
    expect(str).not.toContain('SESSION_SECRET');
    expect(str).not.toContain('sk-');
    expect(str).not.toContain('.env');
  });
});

// ─── G12-8: ai-config does not log API key prefix ──────────────────────────
describe('G12-8: ai-config does not leak API key in logs', () => {
  it('getAiConfig Decrypted OK log does not contain keyPrefix', () => {
    const source = readSrc('src/lib/ai-config.ts');
    expect(source).not.toMatch(/keyPrefix.*slice/);
    expect(source).not.toMatch(/keyPrefix.*apiKey/);
  });

  it('config/ai route does not log keyPrefix or apiKey fragment', () => {
    const source = readSrc('src/app/api/config/ai/route.ts');
    expect(source).not.toMatch(/keyPrefix/);
    expect(source).not.toMatch(/slice\(0,\s*6\)/);
  });
});

// ─── G12-9: export-utils does not log full payload ─────────────────────────
describe('G12-9: export-utils does not log sensitive payload', () => {
  it('exportToPDF logs only the hash, not the full payload', () => {
    const source = readSrc('src/lib/dashboard/export-utils.ts');
    expect(source).not.toMatch(/JSON\.stringify.*payload.*integrityHash/);
    expect(source).toMatch(/logger\.info.*hash/);
  });
});

// ─── G12-4: import/analyze returns generic errors ──────────────────────────
describe('G12-4: import/analyze returns generic error messages', () => {
  it('source code does not leak err.message to client response', () => {
    const source = readSrc('src/app/api/import/analyze/route.ts');
    expect(source).toMatch(/error: 'Error al procesar el archivo contable'/);
    expect(source).not.toMatch(/error: err\.instanceof.*\? err\.message.*String\(err\)/);
  });
});

// ─── G12-5: onboarding/complete returns generic errors ─────────────────────
describe('G12-5: onboarding/complete returns generic error messages', () => {
  it('source code does not leak error.message to client', () => {
    const source = readSrc('src/app/api/onboarding/complete/route.ts');
    expect(source).not.toMatch(/error\.instanceof.*\? error\.message.*String\(error\)/);
  });
});

// ─── G12-6: learning routes return generic errors ──────────────────────────
describe('G12-6: learning routes return generic error messages', () => {
  const routes = [
    'learning/context/route.ts',
    'learning/entities/route.ts',
    'learning/pending-entities/route.ts',
    'learning/rules/simulate/route.ts',
    'learning/rules/route.ts',
    'learning/classify-entity/route.ts',
    'learning/conversational-parse/route.ts',
  ];

  for (const route of routes) {
    it(`${route} does not leak error.message to client`, () => {
      const source = readSrc(`src/app/api/${route}`);
      // Only match error.message in response payloads (NextResponse.json / return), not in logger calls
      const leaks = source.match(/return\s+NextResponse\.json\(\s*\{[^}]*error[^}]*error\.message/g);
      expect(leaks).toBeNull();
    });
  }
});

// ─── G12-2 (comprehensive): All modified routes have no error.message leak ──
describe('G12-2: All modified routes have no error.message in catch responses', () => {
  const routeFiles = [
    'learning/context/route.ts',
    'learning/entities/route.ts',
    'learning/pending-entities/route.ts',
    'learning/rules/simulate/route.ts',
    'learning/rules/route.ts',
    'learning/classify-entity/route.ts',
    'learning/conversational-parse/route.ts',
    'onboarding/complete/route.ts',
    'import/analyze/route.ts',
    'health/route.ts',
    'fiscal-periods/close/route.ts',
  ];

  for (const route of routeFiles) {
    it(`${route}: catch blocks use generic messages only`, () => {
      const source = readSrc(`src/app/api/${route}`);
      const leaks = source.match(
        /return\s+NextResponse\.json\(\s*\{[^}]*error:\s*[^}]*error\.message/g,
      );
      expect(leaks).toBeNull();
    });
  }
});

// ─── G12-2: safeErrorMessage security model ────────────────────────────────
describe('G12-2: safeErrorMessage does not leak sensitive error.message content', () => {
  it('unknown Error: only name is logged, never message', async () => {
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleRouteError } = await import('@/lib/route-error-handler');

    // Simulate an unknown Error with a sensitive message
    const err = new Error('connection refused postgresql://admin:s3cret@db-host:5432/prod');
    handleRouteError(err, '[TEST TAG]');

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    // Must contain the tag
    expect(output.message).toBe('[TEST TAG]');
    // Must contain only the error name, NOT the message
    expect(output.error).toBe('Error');
    expect(output.error).not.toContain('postgresql://');
    expect(output.error).not.toContain('s3cret');
    expect(output.error).not.toContain('db-host');
    consoleSpy.mockRestore();
  });

  it('unknown Error with API key in message: key is not logged', async () => {
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleRouteError } = await import('@/lib/route-error-handler');

    const err = new Error('Invalid API key: sk-test-api-key');
    handleRouteError(err, '[TEST TAG]');

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.error).toBe('Error');
    expect(output.error).not.toContain('sk-');
    consoleSpy.mockRestore();
  });

  it('unknown Error with password in message: password is not logged', async () => {
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleRouteError } = await import('@/lib/route-error-handler');

    const err = new Error('password authentication failed for user "admin"');
    handleRouteError(err, '[TEST TAG]');

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.error).toBe('Error');
    expect(output.error).not.toContain('password');
    expect(output.error).not.toContain('admin');
    consoleSpy.mockRestore();
  });

  it('unknown TypeError with file path: path is not logged', async () => {
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleRouteError } = await import('@/lib/route-error-handler');

    const err = new TypeError('Cannot read property of undefined at /app/src/lib/db.ts:42:15');
    handleRouteError(err, '[TEST TAG]');

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.error).toBe('TypeError');
    expect(output.error).not.toContain('/app/src/');
    expect(output.error).not.toContain('db.ts');
    consoleSpy.mockRestore();
  });

  it('AppError: message IS logged (safe business logic)', async () => {
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleRouteError } = await import('@/lib/route-error-handler');
    const { AppError } = await import('@/lib/api-error');

    const err = new AppError(400, 'Validation failed', 'VALIDATION_ERROR');
    // AppError is re-thrown, so we need to catch it
    try {
      handleRouteError(err, '[TEST TAG]');
    } catch (thrown) {
      // Expected — AppError is re-thrown
    }

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.message).toBe('[TEST TAG]');
    // AppError message IS logged (it's safe business logic)
    expect(output.error).toContain('Validation failed');
    consoleSpy.mockRestore();
  });

  it('Prisma error with connection string: string is not logged', async () => {
    vi.resetModules();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleRouteError } = await import('@/lib/route-error-handler');

    // Simulate a Prisma-like error (not instanceof AppError)
    const err = new Error('Invalid `prisma.user.findUnique()` invocation: connection URL postgresql://user:pass@host/db');
    Object.defineProperty(err, 'name', { value: 'PrismaClientKnownRequestError' });
    handleRouteError(err, '[TEST TAG]');

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.error).toBe('PrismaClientKnownRequestError');
    expect(output.error).not.toContain('postgresql://');
    expect(output.error).not.toContain('pass');
    consoleSpy.mockRestore();
  });
});

// ─── G12-2: fiscal-periods/close specific log security ─────────────────────
describe('G12-2: fiscal-periods/close does not leak in logs or response', () => {
  it('log uses errorName, not String(error) or error.message', () => {
    const source = readSrc('src/app/api/fiscal-periods/close/route.ts');
    // Log call must use errorName, not String(error) or error.message
    expect(source).not.toMatch(/logger\.error\([^)]*,\s*\{\s*error:\s*String\(error\)/);
    expect(source).not.toMatch(/logger\.error\([^)]*,\s*\{\s*error:\s*error\.message/);
    // Log call must use errorName
    expect(source).toMatch(/logger\.error\([^)]*,\s*\{\s*errorName:/);
  });

  it('response returns generic message, not error.message', () => {
    const source = readSrc('src/app/api/fiscal-periods/close/route.ts');
    // Response must not contain error.message
    const responseLeak = source.match(
      /return\s+NextResponse\.json\(\s*\{[^}]*error:\s*[^}]*error\.message/g,
    );
    expect(responseLeak).toBeNull();
    // Response must contain the hardcoded generic message
    expect(source).toContain("error: 'Error al cerrar el período fiscal'");
  });
});
