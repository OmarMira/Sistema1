import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseConversationalContext, parseWithAI, resolveGLAccount } from '@/lib/services/conversational-service';

vi.mock('@/lib/db', () => ({
  db: { glAccount: { findFirst: vi.fn() } },
}));

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

describe('parseConversationalContext — engine-based flow (real engine)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
  });

  it('debe resolver el nombre de la cuenta desde la BD cuando existe el código', async () => {
    const accounts: Record<string, any> = {
      '4000': { id: 'gl-4000', code: '4000', name: 'Revenue', companyId: 'company-1', isActive: true },
    };
    (db.glAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      ({ where }: any) => Promise.resolve(accounts[where.code] ?? null),
    );

    const result = await parseConversationalContext(
      'company-1',
      'gasto de materiales',
      'compra de materiales para oficina',
    );

    expect(db.glAccount.findFirst).toHaveBeenCalled();
    expect(result.role).toBe('GASTO_OPERATIVO');
    expect(result.glAccountCode).toBe('5000');
    expect(result.glAccountId).toBeNull();
    expect(result.account.name).toBe('Cuenta No Clasificada');
  });

  it('debe usar el nombre de la BD cuando el código existe en la BD', async () => {
    const accounts: Record<string, any> = {
      '5000': { id: 'gl-5000', code: '5000', name: 'Cost of Goods Sold', companyId: 'company-1', isActive: true },
    };
    (db.glAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      ({ where }: any) => Promise.resolve(accounts[where.code] ?? null),
    );

    const result = await parseConversationalContext(
      'company-1',
      'gasto de oficina',
      'compra de suministros',
    );

    expect(result.glAccountCode).toBe('5000');
    expect(result.glAccountId).toBe('gl-5000');
    expect(result.account.name).toBe('Cost of Goods Sold');
  });

  it('includes all contract fields including confidence/reasoning in the response', async () => {
    const accounts: Record<string, any> = {
      '5000': { id: 'gl-5000', code: '5000', name: 'Cost of Goods Sold', companyId: 'company-1', isActive: true },
    };
    (db.glAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      ({ where }: any) => Promise.resolve(accounts[where.code] ?? null),
    );

    const result = await parseConversationalContext(
      'company-1',
      'gasto de oficina',
      'compra de suministros',
    );

    expect(result).toHaveProperty('role');
    expect(result).toHaveProperty('glAccountCode');
    expect(result).toHaveProperty('glAccountId');
    expect(result).toHaveProperty('suggestSubAccount');
    expect(result).toHaveProperty('subAccountName');
    expect(result).toHaveProperty('account');
    expect(result).toHaveProperty('conditions');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('confidenceLabel');
    expect(result).toHaveProperty('explanation');
    expect(result).toHaveProperty('uncertaintyReasons');
    expect(typeof result.confidence).toBe('number');
    expect(['high', 'medium', 'low']).toContain(result.confidenceLabel);
    expect(typeof result.explanation).toBe('string');
    expect(Array.isArray(result.uncertaintyReasons)).toBe(true);
  });
});

describe('parseWithAI', () => {
  it('should return parsed result on successful API call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  role: 'SOCIO',
                  glAccountCode: '3010',
                  suggestSubAccount: false,
                  subAccountName: null,
                }),
              },
            },
          ],
        }),
    }) as unknown as typeof globalThis.fetch;

    const result = await parseWithAI('test pattern', 'test input', {
      apiKey: 'test-key',
      baseUrl: 'https://test.ai',
      model: 'test-model',
      fetch: mockFetch,
      readAssistantConfig: () => ({ systemInstruction: 'test', temperature: 0.1, maxTokens: 300 }),
    });

    expect(result.role).toBe('SOCIO');
    expect(result.glAccountCode).toBe('3010');
    expect(result.suggestSubAccount).toBe(false);
    expect(result.subAccountName).toBeNull();
  });

  it('should throw on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    }) as unknown as typeof globalThis.fetch;

    await expect(
      parseWithAI('test', 'test', {
        apiKey: 'key',
        baseUrl: 'https://test.ai',
        model: 'model',
        fetch: mockFetch,
        readAssistantConfig: () => ({}),
      }),
    ).rejects.toThrow('AI API returned status 400');
  });

  it('should throw on malformed JSON response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: 'not valid json' } }],
        }),
    }) as unknown as typeof globalThis.fetch;

    await expect(
      parseWithAI('test', 'test', {
        apiKey: 'key',
        baseUrl: 'https://test.ai',
        model: 'model',
        fetch: mockFetch,
        readAssistantConfig: () => ({}),
      }),
    ).rejects.toThrow();
  });

  it('should throw on timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const mockFetch = vi.fn().mockRejectedValue(abortError) as unknown as typeof globalThis.fetch;

    await expect(
      parseWithAI('test', 'test', {
        apiKey: 'key',
        baseUrl: 'https://test.ai',
        model: 'model',
        fetch: mockFetch,
        readAssistantConfig: () => ({}),
      }),
    ).rejects.toThrow('The operation was aborted');
  });

  it('should throw on missing configuration (empty env vars)', async () => {
    await expect(
      parseWithAI('test', 'test', {
        apiKey: '',
        baseUrl: '',
        model: '',
      }),
    ).rejects.toThrow('AI not configured');
  });
});

describe('resolveGLAccount', () => {
  it('should return account when code is found in DB', async () => {
    const mockDb = {
      glAccount: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'gl-4000',
          code: '4000',
          name: 'Revenue',
        }),
      },
    };

    const result = await resolveGLAccount('company-1', '4000', { db: mockDb as any });

    expect(result.glAccountId).toBe('gl-4000');
    expect(result.account.name).toBe('Revenue');
    expect(mockDb.glAccount.findFirst).toHaveBeenCalledWith({
      where: { companyId: 'company-1', code: '4000', isActive: true },
    });
  });

  it('should return null id when code is not found in DB', async () => {
    const mockDb = {
      glAccount: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const result = await resolveGLAccount('company-1', '9999', { db: mockDb as any });

    expect(result.glAccountId).toBeNull();
    expect(result.account.name).toBe('Cuenta No Clasificada');
  });

  it('should handle DB errors gracefully and log a warning', async () => {
    const mockDb = {
      glAccount: {
        findFirst: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      },
    };

    const result = await resolveGLAccount('company-1', '4000', { db: mockDb as any });

    expect(logger.warn).toHaveBeenCalledWith('GL_ACCOUNT_QUERY_FAIL', expect.any(Object));
    expect(result.glAccountId).toBeNull();
    expect(result.account.name).toBe('Cuenta No Clasificada');
  });

  it('should return default for empty glAccountCode', async () => {
    const result = await resolveGLAccount('company-1', '');

    expect(result.glAccountId).toBeNull();
    expect(result.account.name).toBe('Cuenta No Clasificada');
    expect(result.account.code).toBe('');
  });
});
