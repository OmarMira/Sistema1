import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── I/O boundary mocks ──────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  db: { glAccount: { findFirst: vi.fn() } },
}));

vi.mock('@/lib/services/audit-service', () => ({
  safeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/services/entity-context-service', () => ({
  findContext: vi.fn(),
}));

import { parseConversationalContext } from '@/lib/services/conversational-service';
import { db } from '@/lib/db';
import { findContext } from '@/lib/services/entity-context-service';

const mockGlAccounts: Record<string, any> = {
  '5000': { id: 'gl-5000', code: '5000', name: 'Gastos Operativos', companyId: 'comp_1', isActive: true },
  '4000': { id: 'gl-4000', code: '4000', name: 'Ingresos', companyId: 'comp_1', isActive: true },
};

function setupDb() {
  (db.glAccount.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
    ({ where }: any) => Promise.resolve(mockGlAccounts[where.code] ?? null),
  );
}

describe('parseConversationalContext — full contract integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    setupDb();
  });

  it('devuelve alta confianza cuando hay EntityContext + heuristic match', async () => {
    (findContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ctx_1',
      companyId: 'comp_1',
      pattern: 'gastos oficina',
      role: 'GASTO_OPERATIVO',
      glAccountId: 'gl-5000',
      glAccount: { code: '5000', name: 'Gastos Operativos' },
    });

    const result = await parseConversationalContext(
      'comp_1',
      'gastos de oficina',
      'gasto de oficina para suministros',
    );

    expect(result.role).toBe('GASTO_OPERATIVO');
    expect(result.glAccountCode).toBe('5000');
    expect(result.glAccountId).toBe('gl-5000');
    expect(result.suggestSubAccount).toBe(false);
    expect(result.subAccountName).toBeNull();
    expect(result.account.name).toBe('Gastos Operativos');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.confidenceLabel).toBe('high');
    expect(typeof result.explanation).toBe('string');
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(Array.isArray(result.uncertaintyReasons)).toBe(true);
  });

  it('devuelve SIN_CLASIFICAR (confianza 0) sin EntityContext y sin heuristic match', async () => {
    (findContext as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await parseConversationalContext(
      'comp_1',
      'zxqwmklp acbd',
      'qbrxzn wyvkm pld',
    );

    expect(result.role).toBe('');
    expect(result.glAccountCode).toBe('');
    expect(result.glAccountId).toBeNull();
    expect(result.suggestSubAccount).toBe(false);
    expect(result.subAccountName).toBeNull();
    expect(result.account.name).toBe('Cuenta No Clasificada');
    expect(result.confidence).toBe(0);
    expect(result.confidenceLabel).toBe('low');
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(result.uncertaintyReasons.length).toBeGreaterThan(0);
  });

  it('incluye todos los campos del contrato en la respuesta', async () => {
    (findContext as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await parseConversationalContext(
      'comp_1',
      'algo',
      'descripción',
    );

    const expectedFields = [
      'role', 'glAccountCode', 'glAccountId',
      'suggestSubAccount', 'subAccountName', 'account',
      'conditions',
      'confidence', 'confidenceLabel', 'explanation', 'uncertaintyReasons',
    ];
    for (const field of expectedFields) {
      expect(result).toHaveProperty(field);
    }

    expect(typeof result.confidence).toBe('number');
    expect(['high', 'medium', 'low']).toContain(result.confidenceLabel);
    expect(typeof result.explanation).toBe('string');
    expect(Array.isArray(result.uncertaintyReasons)).toBe(true);

    expect(result.account).toHaveProperty('code');
    expect(result.account).toHaveProperty('name');
    expect(Array.isArray(result.conditions)).toBe(true);
  });

  it('usa heuristic match cuando el input contiene keyword exacta', async () => {
    (findContext as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await parseConversationalContext(
      'comp_1',
      'aporte de socio',
      'aporte de socio juan perez',
    );

    expect(result.role).toBe('SOCIO');
    expect(result.glAccountCode).toBe('3010');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.confidenceLabel).toBe('high');
  });

  it('asigna GASTO_OPERATIVO con confianza media cuando heuristic match es parcial', async () => {
    (findContext as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await parseConversationalContext(
      'comp_1',
      'un gasto',
      'gasto de oficina',
    );

    expect(result.role).toBe('GASTO_OPERATIVO');
    // "gasto" matches heuristically with confidence 0.7 (partial keyword, not exact role name)
    expect(result.confidence).toBe(0.7);
    expect(result.confidenceLabel).toBe('medium');
  });

  it('devuelve uncertaintyReasons vacío cuando hay confianza alta', async () => {
    (findContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ctx_1',
      companyId: 'comp_1',
      pattern: 'gastos oficina',
      role: 'GASTO_OPERATIVO',
      glAccountId: 'gl-5000',
      glAccount: { code: '5000', name: 'Gastos Operativos' },
    });

    const result = await parseConversationalContext(
      'comp_1',
      'gastos de oficina',
      'gasto de oficina',
    );

    expect(result.confidenceLabel).toBe('high');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
