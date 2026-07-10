import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ─── Route handler under test ──────────────────────────────────
import { POST } from '@/app/api/learning/suggest-role/route';

// ─── Helper ─────────────────────────────────────────────────────
async function makeRequest(
  body: Record<string, unknown>,
  token: string,
  companyId: string,
): Promise<NextRequest> {
  return new NextRequest('http://localhost/api/learning/suggest-role', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-company-id': companyId,
    },
    body: JSON.stringify({ ...body, companyId }),
  });
}

describe('POST /api/learning/suggest-role', () => {
  let token: string;
  let companyId: string;
  let userId: string;

  beforeEach(async () => {
    await clearDatabase();
    process.env.SESSION_SECRET = 'test-session-secret-for-suggest-role';
    const user = await createTestUser('suggest-role-test@example.com');
    userId = user.id;
    const company = await createTestCompany('Suggest Role Co', 'BUSINESS', { autoRoleAssignment: true });
    companyId = company.id;
    await createTestCompanyMember(user.id, companyId);
    token = await createSession(user.id);
  });

  afterEach(async () => {
    await clearDatabase();
    delete process.env.SESSION_SECRET;
  });

  // ─── Validation tests (input/output mapping) ─────────────────
  describe('validation', () => {
    it('returns 400 for empty description', async () => {
      const req = await makeRequest({ description: '' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('min 3');
    });

    it('returns 400 for description shorter than 3 chars', async () => {
      const req = await makeRequest({ description: 'ab' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('min 3');
    });

    it('returns 400 for missing description field', async () => {
      const req = await makeRequest({}, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
    });
  });

  // ─── AI response mapping tests (with mocked fetch) ───────────
  describe('response mapping', () => {
    beforeEach(() => {
      process.env.AI_API_KEY = 'test-key';
      process.env.AI_BASE_URL = 'https://api.test.openrouter.ai/v1';
      process.env.AI_MODEL = 'test-model';
    });

    afterEach(() => {
      delete process.env.AI_API_KEY;
      delete process.env.AI_BASE_URL;
      delete process.env.AI_MODEL;
      vi.restoreAllMocks();
    });

    it('returns canonical role from AI response (PROVEEDOR)', async () => {
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'Paga servicios mensuales' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestedRole).toBe('PROVEEDOR');
      expect(body.confidence).toBe(0.92);
      expect(body.explanation).toBeDefined();
    });

    it('trims and uppercases role from AI', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: '  cliente ',
              confidence: 0.85,
              explanation: 'Recibe pagos regulares',
            }),
          },
        }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'Cobra por sus servicios' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestedRole).toBe('CLIENTE');
      expect(body.confidence).toBe(0.85);
    });

    it('rejects OTRO role from AI with 502', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: 'OTRO',
              confidence: 0.7,
              explanation: 'No es un rol válido',
            }),
          },
        }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'Vende en la calle' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain('OTRO');
    });

    it('coerces string confidence to number', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: 'empleado',
              confidence: '0.95',
              explanation: 'Pago de nómina',
            }),
          },
        }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'Pago de nómina mensual' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestedRole).toBe('EMPLEADO');
      expect(typeof body.confidence).toBe('number');
      expect(body.confidence).toBe(0.95);
    });

    it('handles AI API network failure gracefully (502)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const req = await makeRequest({ description: 'Paga servicios' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('handles AI API HTTP error gracefully (502)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Service Unavailable', { status: 503 }),
      );

      const req = await makeRequest({ description: 'Alquiler mensual' }, token, companyId);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(502);
    });
  });

  // ─── Auto-role-assignment flag behavior ───────────────────────────
  describe('auto-role-assignment flag', () => {
    beforeEach(() => {
      process.env.AI_API_KEY = 'test-key';
      process.env.AI_BASE_URL = 'https://api.test.openrouter.ai/v1';
      process.env.AI_MODEL = 'test-model';
    });

    afterEach(() => {
      delete process.env.AI_API_KEY;
      delete process.env.AI_BASE_URL;
      delete process.env.AI_MODEL;
      vi.restoreAllMocks();
    });

    it('autoRoleAssignment: false caps confidence at 0.69 and NO autoAssign signal', async () => {
      const company = await createTestCompany('AutoRole False Co', 'BUSINESS', { autoRoleAssignment: false });
      await createTestCompanyMember(userId, company.id);

      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: 'PROVEEDOR',
              confidence: 0.92,
              explanation: 'test provider confidence cap',
            }),
          },
        }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'Monthly service payment test' }, token, company.id);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.confidence).toBe(0.69);
      expect(body.autoAssign).toBeUndefined();
    });

    it('autoRoleAssignment: true with high confidence returns uncapped + autoAssign: true', async () => {
      const company = await createTestCompany('AutoRole True High Co', 'BUSINESS', { autoRoleAssignment: true });
      await createTestCompanyMember(userId, company.id);

      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: 'PROVEEDOR',
              confidence: 0.95,
              explanation: 'test high confidence auto-assign',
            }),
          },
        }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'High confidence vendor payment' }, token, company.id);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.confidence).toBe(0.95);
      expect(body.autoAssign).toBe(true);
    });

    it('autoRoleAssignment: true with confidence < 0.9 returns uncapped but no autoAssign', async () => {
      const company = await createTestCompany('AutoRole True Low Co', 'BUSINESS', { autoRoleAssignment: true });
      await createTestCompanyMember(userId, company.id);

      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              role: 'PROVEEDOR',
              confidence: 0.85,
              explanation: 'test moderate confidence no auto-assign',
            }),
          },
        }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const req = await makeRequest({ description: 'Moderate confidence utility payment' }, token, company.id);
      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.confidence).toBe(0.85);
      expect(body.autoAssign).toBeUndefined();
    });
  });
});
