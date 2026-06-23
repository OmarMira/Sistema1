import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-id-123'),
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-id-123', role: 'company_admin' }),
    },
    companyMember: {
      findUnique: vi.fn().mockResolvedValue({ id: 'member-123', userId: 'user-id-123', companyId: 'comp_1' }),
    },
    bankAccount: { findMany: vi.fn() },
    bankTransaction: { findMany: vi.fn() },
    bankRule: { findMany: vi.fn() },
    glAccount: { findMany: vi.fn() },
    entityContext: { findMany: vi.fn() },
  },
}));

// Mock loadRolePriorities to avoid file reads
vi.mock('@/lib/services/rule-matching-engine', () => ({
  loadRolePriorities: vi.fn().mockResolvedValue({
    PROVEEDOR: 1,
    CLIENTE: 2,
    SOCIO: 3,
    INQUILINO: 4,
    EMPLEADO: 5,
    TARJETA_CREDITO: 6,
    PRESTAMO: 7,
    GASTO_OPERATIVO: 8,
    INGRESO: 9,
    OTRO: 10,
    IGNORADA: 11,
  }),
  entityFirstCheck: vi.fn((tx, patterns, mode) => ({
    skipSocioRules: false,
  })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────

import { POST } from '@/app/api/ai-rules/scan/route';
import { db } from '@/lib/db';

// ─── Types ────────────────────────────────────────────────────────────

interface ScanPattern {
  id: string;
  description: string;
  rawDescription: string;
  occurrences: number;
  direction: string;
  averageAmount: number;
  suggestedAccount: string;
  suggestedAccountCode: string;
  suggestedAccountId: string;
  hasContext: boolean;
  contextRole: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  explanation: string;
}

// ─── Mock DB helper ──────────────────────────────────────────────────

const mockDb = db as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  companyMember: { findUnique: ReturnType<typeof vi.fn> };
  bankAccount: { findMany: ReturnType<typeof vi.fn> };
  bankTransaction: { findMany: ReturnType<typeof vi.fn> };
  bankRule: { findMany: ReturnType<typeof vi.fn> };
  glAccount: { findMany: ReturnType<typeof vi.fn> };
  entityContext: { findMany: ReturnType<typeof vi.fn> };
  company?: { findUnique: ReturnType<typeof vi.fn> };
};

function setupDefaultMocks() {
  mockDb.bankAccount.findMany.mockResolvedValue([
    { id: 'ba_1' },
    { id: 'ba_2' },
  ]);

  mockDb.bankTransaction.findMany.mockResolvedValue([
    { id: 'tx_1', description: 'Zelle payment to ACME CORP', amount: -150, date: new Date('2026-06-01'), matchedRuleId: null, glAccountId: null },
    { id: 'tx_2', description: 'Zelle payment to ACME CORP', amount: -200, date: new Date('2026-06-02'), matchedRuleId: null, glAccountId: null },
    { id: 'tx_3', description: 'Zelle payment to ACME CORP', amount: -175, date: new Date('2026-06-03'), matchedRuleId: null, glAccountId: null },
    { id: 'tx_4', description: 'Zelle payment to WAL-MART', amount: -320, date: new Date('2026-06-04'), matchedRuleId: null, glAccountId: null },
    { id: 'tx_5', description: 'Zelle payment to WAL-MART', amount: -280, date: new Date('2026-06-05'), matchedRuleId: null, glAccountId: null },
    { id: 'tx_6', description: 'Zelle payment to PUBLIX', amount: -45, date: new Date('2026-06-06'), matchedRuleId: null, glAccountId: null },
  ]);

  mockDb.glAccount.findMany.mockResolvedValue([
    { id: 'gla_1', name: 'Costo de Ventas', code: '6070', accountType: 'expense' },
    { id: 'gla_2', name: 'Cuentas por Cobrar', code: '4010', accountType: 'revenue' },
    { id: 'gla_3', name: 'Aportes de Socios', code: '3010', accountType: 'equity' },
  ]);

  mockDb.entityContext.findMany.mockResolvedValue([
    {
      id: 'ctx_1',
      companyId: 'comp_1',
      pattern: 'acme corp',
      role: 'PROVEEDOR',
      roles: null,
      glAccountId: 'gla_1',
      source: 'user',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      glAccount: { id: 'gla_1', code: '6070', name: 'Costo de Ventas' },
    },
    {
      id: 'ctx_2',
      companyId: 'comp_1',
      pattern: 'wal-mart',
      role: 'CLIENTE',
      roles: null,
      glAccountId: null,
      source: 'user',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      glAccount: null,
    },
  ]);

  mockDb.bankRule.findMany.mockResolvedValue([]);
}

async function callScanRoute(): Promise<{ patterns: ScanPattern[] }> {
  const request = new NextRequest('http://localhost:3000/api/ai-rules/scan', {
    method: 'POST',
    body: JSON.stringify({ companyId: 'comp_1' }),
    headers: { 'content-type': 'application/json' },
  });
  const response = await POST(request, { params: Promise.resolve({}) });
  const body = await response.json();
  return body;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('POST /api/ai-rules/scan — ScanPattern output shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns { patterns } with correct top-level shape', async () => {
    const body = await callScanRoute();
    expect(body).toHaveProperty('patterns');
    expect(Array.isArray(body.patterns)).toBe(true);
  });

  it('each pattern has all 11 required fields', async () => {
    const body = await callScanRoute();
    const pattern = body.patterns[0];

    const fields: (keyof ScanPattern)[] = [
      'id', 'description', 'rawDescription', 'occurrences', 'direction',
      'averageAmount', 'suggestedAccount', 'suggestedAccountCode',
      'suggestedAccountId', 'hasContext', 'contextRole',
    ];

    for (const field of fields) {
      expect(pattern).toHaveProperty(field);
    }
  });

  it('each pattern field has the correct type (string/number/boolean)', async () => {
    const body = await callScanRoute();
    const pattern = body.patterns[0];

    expect(typeof pattern.id).toBe('string');
    expect(typeof pattern.description).toBe('string');
    expect(typeof pattern.rawDescription).toBe('string');
    expect(typeof pattern.occurrences).toBe('number');
    expect(typeof pattern.direction).toBe('string');
    expect(typeof pattern.averageAmount).toBe('number');
    expect(typeof pattern.suggestedAccount).toBe('string');
    expect(typeof pattern.suggestedAccountCode).toBe('string');
    expect(typeof pattern.suggestedAccountId).toBe('string');
    expect(typeof pattern.hasContext).toBe('boolean');
    expect(typeof pattern.contextRole).toBe('string');
  });

  it('patterns are sorted by occurrences descending', async () => {
    const body = await callScanRoute();
    const occurrences = body.patterns.map((p: ScanPattern) => p.occurrences);
    for (let i = 1; i < occurrences.length; i++) {
      expect(occurrences[i]).toBeLessThanOrEqual(occurrences[i - 1]);
    }
  });

  it('known entity with context has correct enrichment fields', async () => {
    const body = await callScanRoute();
    // ACME CORP: 3 occurrences, has context PROVEEDOR with linked GL account
    const acme = body.patterns.find((p: ScanPattern) => p.description.toLowerCase().includes('acme'));
    expect(acme).toBeDefined();
    expect(acme!.occurrences).toBe(3);
    expect(acme!.hasContext).toBe(true);
    expect(acme!.contextRole).toBe('PROVEEDOR');
    expect(acme!.suggestedAccount).toBe('Costo de Ventas');
    expect(acme!.suggestedAccountCode).toBe('6070');
    expect(acme!.suggestedAccountId).toBe('gla_1');
  });

  it('entity without context is filtered out (smartFrequency minOccurrences)', async () => {
    const body = await callScanRoute();
    // PUBLIX has no matching context → should be filtered by requireRole
    const publix = body.patterns.find((p: ScanPattern) => p.description.toLowerCase().includes('publix'));
    expect(publix).toBeUndefined();
  });
});

describe('POST /api/ai-rules/scan — Edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty patterns when no bank accounts exist', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([]);
    const body = await callScanRoute();
    expect(body).toEqual({ patterns: [] });
  });

  it('returns empty patterns when all transactions are already ruled/classified', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba_1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { id: 'tx_1', description: 'Zelle payment to ACME CORP', amount: -150, date: new Date('2026-06-01'), matchedRuleId: 'rule_1', glAccountId: null },
      { id: 'tx_2', description: 'Zelle payment to WAL-MART', amount: -200, date: new Date('2026-06-02'), matchedRuleId: null, glAccountId: 'gla_1' },
    ]);
    mockDb.bankRule.findMany.mockResolvedValue([]);
    mockDb.glAccount.findMany.mockResolvedValue([]);
    mockDb.entityContext.findMany.mockResolvedValue([]);

    const body = await callScanRoute();
    expect(body).toEqual({ patterns: [] });
  });

  it('returns patterns without context enrichment when no entity contexts exist', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba_1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { id: 'tx_1', description: 'Zelle payment to ACME CORP', amount: -150, date: new Date('2026-06-01'), matchedRuleId: null, glAccountId: null },
      { id: 'tx_2', description: 'Zelle payment to ACME CORP', amount: -200, date: new Date('2026-06-02'), matchedRuleId: null, glAccountId: null },
      { id: 'tx_3', description: 'Zelle payment to ACME CORP', amount: -175, date: new Date('2026-06-03'), matchedRuleId: null, glAccountId: null },
    ]);
    mockDb.bankRule.findMany.mockResolvedValue([]);
    mockDb.glAccount.findMany.mockResolvedValue([]);
    mockDb.entityContext.findMany.mockResolvedValue([]);

    const body = await callScanRoute();
    expect(body.patterns.length).toBeGreaterThanOrEqual(1);
    expect(body.patterns[0].hasContext).toBe(false);
    expect(body.patterns[0].confidence).toBe(0);
    expect(body.patterns[0].confidenceLabel).toBe('low');
  });

  it('single-occurrence entities are filtered', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba_1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { id: 'tx_1', description: 'Zelle payment to ACME CORP', amount: -100, date: new Date('2026-06-01'), matchedRuleId: null, glAccountId: null },
      // Only 1 transaction for ACME CORP — insufficient for clusterCandidates minOccurrences
    ]);
    mockDb.bankRule.findMany.mockResolvedValue([]);
    mockDb.glAccount.findMany.mockResolvedValue([]);
    mockDb.entityContext.findMany.mockResolvedValue([]);

    const body = await callScanRoute();
    expect(body).toEqual({ patterns: [] });
  });

  it('entity with existing rule is skipped', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba_1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { id: 'tx_1', description: 'Zelle payment to ACME CORP', amount: -150, date: new Date('2026-06-01'), matchedRuleId: null, glAccountId: null },
      { id: 'tx_2', description: 'Zelle payment to ACME CORP', amount: -200, date: new Date('2026-06-02'), matchedRuleId: null, glAccountId: null },
      { id: 'tx_3', description: 'Zelle payment to ACME CORP', amount: -175, date: new Date('2026-06-03'), matchedRuleId: null, glAccountId: null },
      { id: 'tx_4', description: 'Zelle payment to WAL-MART', amount: -250, date: new Date('2026-06-04'), matchedRuleId: null, glAccountId: null },
      { id: 'tx_5', description: 'Zelle payment to WAL-MART', amount: -300, date: new Date('2026-06-05'), matchedRuleId: null, glAccountId: null },
    ]);
    mockDb.glAccount.findMany.mockResolvedValue([
      { id: 'gla_1', name: 'Costo de Ventas', code: '6070', accountType: 'expense' },
      { id: 'gla_2', name: 'Cuentas por Cobrar', code: '4010', accountType: 'revenue' },
    ]);
    mockDb.entityContext.findMany.mockResolvedValue([
      {
        id: 'ctx_1', companyId: 'comp_1', pattern: 'acme corp', role: 'PROVEEDOR',
        roles: null, glAccountId: 'gla_1', source: 'user',
        createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
        glAccount: { id: 'gla_1', code: '6070', name: 'Costo de Ventas' },
      },
      {
        id: 'ctx_2', companyId: 'comp_1', pattern: 'wal-mart', role: 'CLIENTE',
        roles: null, glAccountId: null, source: 'user',
        createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
        glAccount: null,
      },
    ]);
    // Existing rule covers ACME CORP
    mockDb.bankRule.findMany.mockResolvedValue([
      { conditionValue: 'acme corp', conditionType: 'contains' },
    ]);

    const body = await callScanRoute();
    // ACME should be skipped (existing rule), WAL-MART should appear
    const acme = body.patterns.find((p: ScanPattern) => p.description.toLowerCase().includes('acme'));
    const walmart = body.patterns.find((p: ScanPattern) => p.description.toLowerCase().includes('wal-mart'));
    expect(acme).toBeUndefined();
    expect(walmart).toBeDefined();
  });

  it('id is a base64-encoded string (no padding)', async () => {
    const body = await callScanRoute();
    for (const pattern of body.patterns) {
      expect(pattern.id).not.toContain('=');
      // Should be valid base64
      expect(() => Buffer.from(pattern.id, 'base64').toString('utf-8')).not.toThrow();
    }
  });
});
