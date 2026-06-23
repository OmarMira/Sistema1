import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateRequest } from '@/lib/validate-request';

const TestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

function mockRequest(body: any) {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('API Validation Middleware', () => {
  it('debe aceptar payload válido', async () => {
    const req = mockRequest({ email: 'test@example.com', password: 'secure123!' });
    const result = await validateRequest(req, TestSchema);
    expect(result).toHaveProperty('email', 'test@example.com');
  });

  it('debe rechazar payload inválido con 400', async () => {
    const req = mockRequest({ email: 'invalid', password: '123' });
    const result = await validateRequest(req, TestSchema);
    expect(result).toHaveProperty('status', 400);
  });

  it('debe rechazar JSON malformado', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json }',
    });
    const result = await validateRequest(req, TestSchema);
    expect(result).toHaveProperty('status', 400);
  });
});
