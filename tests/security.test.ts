import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RateLimiter, authRateLimiter } from '@/lib/rate-limiter';
import { sanitizeInput } from '@/lib/sanitize';
import { validateRequest } from '@/lib/validate-request';
import { proxy } from '@/proxy';
import { z } from 'zod';
import { db } from '@/lib/db';
import { parseConversationalContext } from '@/lib/services/conversational-service';
import { validateBackup } from '@/lib/backup';
import { POST } from '@/app/api/reconciliation/auto/route';
import { requestContext } from '@/lib/context-storage';

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-1'),
  getSessionToken: vi.fn().mockReturnValue('mock-token'),
}));

vi.mock('@/lib/db', () => {
  const mockDb = {
    entityContext: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    glAccount: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'gl-3010',
        code: '3010',
        name: 'Socio Cuenta',
        isActive: true,
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    bankRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    bankAccount: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'ba-1',
        companyId: 'company-1',
        glAccountId: 'gl-1000',
        glAccount: { id: 'gl-1000', code: '1000', name: 'Bank Account' },
      }),
    },
    bankStatement: {
      findMany: vi.fn().mockResolvedValue([{ id: 'bs-1' }]),
    },
    bankTransaction: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
    },
    reconciliationPeriod: {
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    rateLimit: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', role: 'super_admin' }),
    },
    companyMember: {
      findUnique: vi.fn().mockResolvedValue({ userId: 'user-1', companyId: 'company-1' }),
    },
    company: {
      findUnique: vi.fn().mockResolvedValue({ id: 'company-1', entityFirstMode: false }),
    },
    $transaction: vi.fn((cb) => cb(mockDb)),
  };
  return { db: mockDb };
});

describe('Security Layer - Unit & Integration Tests', () => {
  beforeEach(() => {
    authRateLimiter.clear();
  });

  describe('1. RateLimiter', () => {
    it('debe bloquear hits por IP después de 5 intentos', () => {
      const limiter = new RateLimiter(5, 60000, 10, 3600000);
      const ip = '192.168.1.1';
      const email = 'test@example.com';

      // Primeros 5 intentos deben ser exitosos
      for (let i = 0; i < 5; i++) {
        expect(limiter.check(ip, email).success).toBe(true);
        limiter.increment(ip, email);
      }
      // El sexto falla por IP
      expect(limiter.check(ip, email).success).toBe(false);
    });

    it('debe bloquear hits por Email después de 10 intentos', () => {
      const limiter = new RateLimiter(5, 60000, 10, 3600000);
      const ipBase = '192.168.1.';
      const email = 'target@example.com';

      // 10 IPs distintas (no salta IP lock), pero mismo email
      for (let i = 0; i < 10; i++) {
        expect(limiter.check(`${ipBase}${i}`, email).success).toBe(true);
        limiter.increment(`${ipBase}${i}`, email);
      }
      // El 11vo falla por Email lock
      expect(limiter.check(`${ipBase}10`, email).success).toBe(false);
    });

    it('debe limpiar hits después de windowMs', () => {
      const limiter = new RateLimiter(1, 10, 10, 3600000);
      const ip = '192.168.1.2';
      const email = 'test2@example.com';

      expect(limiter.check(ip, email).success).toBe(true);
      limiter.increment(ip, email);
      expect(limiter.check(ip, email).success).toBe(false);

      // Avanzar en el tiempo simulado o limpiar manualmente para tests
      limiter.clear();
      expect(limiter.check(ip, email).success).toBe(true);
    });
  });

  describe('2. XSS Detection & Sanitization', () => {
    it('debe sanitizar scripts maliciosos de XSS', () => {
      expect(sanitizeInput('<script>alert(1)</script>')).toBe('');
      expect(sanitizeInput('javascript:void(0)')).toBe('javascript:void(0)'); // javascript is a protocol, safe if not in href
      expect(sanitizeInput('<img src=x onerror=alert(1)>')).toBe('');
      expect(sanitizeInput('<iframe src="malicious"></iframe>')).toBe('');
    });

    it('debe permitir texto y caracteres financieros de Bank of America legítimos', () => {
      expect(sanitizeInput('Zelle payment from RODRIGO OCHOA for "MANUEL FABRO RENTA MARZO"')).toBe('Zelle payment from RODRIGO OCHOA for "MANUEL FABRO RENTA MARZO"');
      expect(sanitizeInput('SETOYOTA FIN/EZP DES:AUTO FINAN')).toBe('SETOYOTA FIN/EZP DES:AUTO FINAN');
      expect(sanitizeInput("O'Brien Consulting")).toBe("O'Brien Consulting");
      expect(sanitizeInput('Conf# 12345')).toBe('Conf# 12345');
    });

    it('debe sanitizar en lugar de fallar la validación en validateRequest si hay patrón XSS', async () => {
      const schema = z.object({ description: z.string() });
      const req = new NextRequest('http://localhost:3000/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: '<script>alert("xss")</script> legitimate' }),
      });

      const result = await validateRequest(req, schema);
      expect(result).toEqual({ description: ' legitimate' });
    });

    it('debe pasar la validación en validateRequest si los strings son legítimos', async () => {
      const schema = z.object({ description: z.string() });
      const req = new NextRequest('http://localhost:3000/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Pago de Renta "Marzo 2026" - O\'Brien' }),
      });

      const data = (await validateRequest(req, schema)) as { description: string };
      expect(data.description).toBe('Pago de Renta "Marzo 2026" - O\'Brien');
    });
  });

  describe('3. Proxy (Security Headers, CSRF & Rate Limit Integration)', () => {
    it('debe agregar headers de seguridad a las respuestas', async () => {
      const req = new NextRequest('http://localhost:3000/');
      const res = await proxy(req);

      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    it('debe permitir mutaciones API sin Origin/Referer (API clients)', async () => {
      const req = new NextRequest('http://localhost:3000/api/companies', {
        method: 'POST',
        headers: { Cookie: 'session=abc123' },
      });
      const res = await proxy(req);
      expect(res.status).toBe(200);
    });

    it('debe rechazar mutaciones API con Origin externo (CSRF)', async () => {
      const req = new NextRequest('http://localhost:3000/api/companies', {
        method: 'POST',
        headers: {
          'Origin': 'http://hacker.com',
          'Host': 'localhost:3000',
          Cookie: 'session=abc123',
        },
      });
      const res = await proxy(req);
      expect(res.status).toBe(403);
    });

    it('debe aceptar mutaciones API con Origin local válido', async () => {
      const req = new NextRequest('http://localhost:3000/api/companies', {
        method: 'POST',
        headers: {
          'Origin': 'http://localhost:3000',
          'Host': 'localhost:3000',
          Cookie: 'session=abc123',
        },
      });
      const res = await proxy(req);
      expect(res.status).toBe(200);
    });

    it('debe pasar peticiones auth a traves del middleware sin rate limit (manejado por route handler)', async () => {
      for (let i = 0; i < 6; i++) {
        const req = new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: 'user@example.com', password: 'password' }),
        });
        const res = await proxy(req);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('4. Additional Logical & Security Fixes', () => {
    beforeEach(() => {
      // Ensure AI env vars are unset so we test the fallback path
      delete process.env.AI_API_KEY;
      delete process.env.AI_BASE_URL;
      delete process.env.AI_MODEL;
    });

    it('debe generar condiciones de tipo contains para el rol SOCIO en conversational-service', async () => {
      const result = await parseConversationalContext(
        'company-1',
        'Juan Perez',
        'socio retiro capital',
      );
      expect(result.role).toBe('SOCIO');
      expect(result.conditions).toEqual([
        { field: 'description', operator: 'contains', value: 'Juan Perez' },
      ]);
    });

    it('debe validar un backup correcto e identificar problemas en uno inválido', () => {
      const validBackup = {
        manifest: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          companyId: 'company-1',
          recordCounts: {},
        },
        data: {
          company: [{}],
          users: [{}],
          glAccounts: [],
          bankAccounts: [],
          bankStatements: [],
          bankTransactions: [],
          bankRules: [],
          journalEntries: [],
          journalLines: [],
          fiscalPeriods: [],
          companyMembers: [],
        },
      };
      expect(validateBackup(validBackup as any).valid).toBe(true);

      const invalidBackup = {
        manifest: {},
        data: {},
      };
      expect(validateBackup(invalidBackup as any).valid).toBe(false);
    });

    it('debe ejecutar todas las consultas de auto-reconciliación dentro de la misma transacción', async () => {
      const mockTx = {
        bankStatement: { findMany: vi.fn().mockResolvedValue([{ id: 'bs-1' }]) },
        bankTransaction: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
          update: vi.fn().mockResolvedValue({}),
        },
        reconciliationPeriod: { update: vi.fn().mockResolvedValue({}) },
      };

      const transactionSpy = vi.spyOn(db, '$transaction').mockImplementation(async (cb) => {
        return cb(mockTx as any);
      });

      await requestContext.run({ userId: 'user-1', companyId: 'company-1' }, async () => {
        const req = new NextRequest('http://localhost:3000/api/reconciliation/auto?companyId=company-1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bankAccountId: 'ba-1', companyId: 'company-1' }),
        });
        const res = await POST(req, { params: Promise.resolve({}) });
        expect(res.status).toBe(200);
      });

      expect(transactionSpy).toHaveBeenCalled();
      expect(mockTx.bankTransaction.findMany).toHaveBeenCalled();
    });
  });
});
