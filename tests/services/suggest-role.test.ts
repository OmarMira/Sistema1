import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';

vi.mock('@/lib/ai-config', () => ({
  getAiConfig: vi.fn().mockResolvedValue({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://api.test.openrouter.ai/v1',
  }),
  clearAiConfigCache: vi.fn(),
}));

vi.mock('@/lib/services/web-search-service', () => ({
  searchEntity: vi.fn(),
}));

// ─── Helper ─────────────────────────────────────────────────────
async function makeRequest(
  body: unknown,
  token: string,
  cid: string,
): Promise<NextRequest> {
  return new NextRequest('http://localhost/api/learning/suggest-role', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-company-id': cid,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/learning/suggest-role — prompt construction', () => {
  let token: string;
  let companyId: string;

  beforeAll(async () => {
    await clearDatabase();
    process.env.SESSION_SECRET = 'test-session-secret-for-suggest-role-unit';
    const user = await createTestUser('suggest-role-unit@example.com');
    const company = await createTestCompany('Suggest Role Unit Co', 'BUSINESS', { autoRoleAssignment: true });
    companyId = company.id;
    await createTestCompanyMember(user.id, company.id);
    token = await createSession(user.id);

    process.env.AI_API_KEY = 'test-key';
    process.env.AI_BASE_URL = 'https://api.test.openrouter.ai/v1';
    process.env.AI_MODEL = 'test-model';
  });

  afterAll(async () => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    delete process.env.SESSION_SECRET;
    vi.restoreAllMocks();
    await clearDatabase();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes direction labels with percentages when directionProfile is provided', async () => {
    const { POST } = await import('@/app/api/learning/suggest-role/route');

    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            role: 'proveedor',
            confidence: 0.92,
            explanation: 'Parece un proveedor de servicios',
          }),
        },
      }],
    };

    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = typeof opts?.body === 'string' ? opts.body : null;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    const req = await makeRequest({
      description: 'Paga servicios mensuales',
      directionProfile: { creditPct: 0, debitPct: 1 },
      sampleDescriptions: ['Pago de servicios', 'Servicio mensual', 'Pago recurrente'],
    }, token, companyId);

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    const userPrompt: string = parsed.messages.find(
      (m: { role: string }) => m.role === 'user',
    )?.content || '';

    expect(userPrompt).toContain('money OUT');
    expect(userPrompt).toContain('money IN');
    expect(userPrompt).toContain('This entity has');
    expect(userPrompt).toContain('100% debit');
    expect(userPrompt).toContain('0% credit');
  });

  it('includes up to 3 sample descriptions in the prompt', async () => {
    const { POST } = await import('@/app/api/learning/suggest-role/route');

    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            role: 'proveedor',
            confidence: 0.9,
            explanation: 'Servicios',
          }),
        },
      }],
    };

    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = typeof opts?.body === 'string' ? opts.body : null;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    const req = await makeRequest({
      description: 'Paga servicios',
      directionProfile: { creditPct: 0, debitPct: 1 },
      sampleDescriptions: [
        'Pago de servicios mensuales',
        'Servicio eléctrico',
        'Agua potable',
        'Teléfono',
        'Internet',
      ],
    }, token, companyId);

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const parsed = JSON.parse(capturedBody!);
    const userPrompt: string = parsed.messages.find(
      (m: { role: string }) => m.role === 'user',
    )?.content || '';

    expect(userPrompt).toContain('Pago de servicios mensuales');
    expect(userPrompt).toContain('Servicio eléctrico');
    expect(userPrompt).toContain('Agua potable');
  });

  it('includes entity name and transaction count in prompt', async () => {
    const { POST } = await import('@/app/api/learning/suggest-role/route');

    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            role: 'proveedor',
            confidence: 0.85,
            explanation: 'test',
          }),
        },
      }],
    };

    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = typeof opts?.body === 'string' ? opts.body : null;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    const req = await makeRequest({
      description: 'Servicios generales',
      directionProfile: { creditPct: 0, debitPct: 1 },
      sampleDescriptions: ['Pago de servicios'],
    }, token, companyId);

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const parsed = JSON.parse(capturedBody!);
    const userPrompt: string = parsed.messages.find(
      (m: { role: string }) => m.role === 'user',
    )?.content || '';

    expect(userPrompt).toContain('Description');
    expect(userPrompt).toContain('Servicios generales');
  });

  it('works without directionProfile (backward compat)', async () => {
    const { POST } = await import('@/app/api/learning/suggest-role/route');

    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            role: 'gasto_operativo',
            confidence: 0.9,
            explanation: 'Gasto operativo',
          }),
        },
      }],
    };

    let capturedBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string, opts?: RequestInit) => {
      capturedBody = typeof opts?.body === 'string' ? opts.body : null;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    const req = await makeRequest({
      description: 'Gasto mensual',
    }, token, companyId);

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedRole).toBe('GASTO_OPERATIVO');
  });

  describe('web search fallback', () => {
    const lowConfidenceResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            role: 'gasto_operativo',
            confidence: 0.65,
            explanation: 'No estoy seguro',
          }),
        },
      }],
    };

    const highConfidenceResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            role: 'proveedor',
            confidence: 0.88,
            explanation: 'Parece un proveedor de servicios',
          }),
        },
      }],
    };

    beforeEach(() => {
      process.env.WEB_SEARCH_ENABLED = 'true';
      process.env.WEB_SEARCH_API_KEY = 'test-key';
      process.env.WEB_SEARCH_CX = 'test-cx-id';
      // Clear searchEntity mock state between tests
      vi.clearAllMocks();
    });

    afterEach(() => {
      delete process.env.WEB_SEARCH_ENABLED;
      delete process.env.WEB_SEARCH_API_KEY;
      delete process.env.WEB_SEARCH_CX;
    });

    it('calls searchEntity and re-prompts AI when confidence < 80%', async () => {
      const { searchEntity } = await import('@/lib/services/web-search-service');
      const mockSearchEntity = vi.mocked(searchEntity);
      mockSearchEntity.mockResolvedValue({
        title: 'Southeast Toyota Finance',
        snippet: 'Vehicle financing solutions provider',
        sourceUrl: 'https://example.com/toyota',
      });

      // First AI call returns low confidence, second returns high confidence
      let callCount = 0;
      let rePromptBody: string | null = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string, opts?: RequestInit) => {
        callCount++;
        if (callCount === 2) {
          rePromptBody = typeof opts?.body === 'string' ? opts.body : null;
        }
        const resp = callCount === 1 ? lowConfidenceResponse : highConfidenceResponse;
        return new Response(JSON.stringify(resp), { status: 200 });
      });

      const { POST } = await import('@/app/api/learning/suggest-role/route');

      const req = await makeRequest({
        description: 'SETOYOTA FIN/EZP',
        directionProfile: { creditPct: 0, debitPct: 1 },
        companyId,
      }, token, companyId);

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockSearchEntity).toHaveBeenCalledWith('SETOYOTA FIN/EZP');
      expect(rePromptBody).not.toBeNull();
      // The re-prompt includes a third user message with web context
      expect(rePromptBody).toContain('Web search result');
      expect(rePromptBody).toContain('Southeast Toyota Finance');

      // Confidence should be 0.70 (capped)
      expect(body.confidence).toBe(0.70);
      expect(body.suggestedRole).toBe('PROVEEDOR');
    });

    it('does NOT call searchEntity when confidence >= 80%', async () => {
      const { searchEntity } = await import('@/lib/services/web-search-service');
      const mockSearchEntity = vi.mocked(searchEntity);

      const highConf = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: 'proveedor',
              confidence: 0.92,
              explanation: 'Claramente un proveedor',
            }),
          },
        }],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(highConf), { status: 200 }),
      );

      const { POST } = await import('@/app/api/learning/suggest-role/route');

      const req = await makeRequest({
        description: 'Proveedor de servicios',
      }, token, companyId);

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);

      expect(mockSearchEntity).not.toHaveBeenCalled();
    });

    it('does NOT call searchEntity when WEB_SEARCH_ENABLED is false', async () => {
      process.env.WEB_SEARCH_ENABLED = 'false';
      const { searchEntity } = await import('@/lib/services/web-search-service');
      const mockSearchEntity = vi.mocked(searchEntity);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(lowConfidenceResponse), { status: 200 }),
      );

      const { POST } = await import('@/app/api/learning/suggest-role/route');

      const req = await makeRequest({
        description: 'Gasto',
      }, token, companyId);

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);

      expect(mockSearchEntity).not.toHaveBeenCalled();
    });

    it('returns original result when searchEntity returns null', async () => {
      const { searchEntity } = await import('@/lib/services/web-search-service');
      const mockSearchEntity = vi.mocked(searchEntity);
      mockSearchEntity.mockResolvedValue(null);

      // Only one AI call (no re-prompt since search returned null)
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(lowConfidenceResponse), { status: 200 }),
      );

      const { POST } = await import('@/app/api/learning/suggest-role/route');

      const req = await makeRequest({
        description: 'Gasto',
      }, token, companyId);

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockSearchEntity).toHaveBeenCalled();
      // Original low confidence preserved
      expect(body.confidence).toBe(0.65);
      expect(body.suggestedRole).toBe('GASTO_OPERATIVO');
    });
  });
});
