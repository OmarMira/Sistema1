import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  db: {
    glAccount: { findFirst: vi.fn() },
    bankAccount: { findMany: vi.fn() },
    bankTransaction: { findMany: vi.fn() },
    entityContext: { findMany: vi.fn() },
    bankRule: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/services/entity-detector', () => ({
  loadConfig: vi.fn(),
  clusterCandidates: vi.fn(),
  extractComponents: vi.fn(),
}));

vi.mock('@/lib/services/entity-context-service', () => ({
  saveContext: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

// ─── Imports after mocks ──────────────────────────────────────────────

import { db } from '@/lib/db';
import { loadConfig, clusterCandidates, extractComponents } from '@/lib/services/entity-detector';
import { saveContext } from '@/lib/services/entity-context-service';
import {
  classifyEntity,
  getEntityCandidates,
  detectEntityConflict,
  getKnownSocioPatterns,
} from '@/lib/services/entity-classifier';
import { ENTITY_ROLES, entityRoleSchema, UI_ROLES } from '@/lib/constants/entity-roles';

// ─── Helpers ───────────────────────────────────────────────────────────

const mockDb = db as unknown as {
  glAccount: { findFirst: ReturnType<typeof vi.fn> };
  bankAccount: { findMany: ReturnType<typeof vi.fn> };
  bankTransaction: { findMany: ReturnType<typeof vi.fn> };
  entityContext: { findMany: ReturnType<typeof vi.fn> };
  bankRule: { findMany: ReturnType<typeof vi.fn> };
};

function makeCandidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  return {
    id: 'cand-1',
    canonicalName: 'ACME CORP',
    displayName: 'ACME CORP',
    count: 5,
    totalAmount: 1500,
    avgAmount: 300,
    frequency: 5,
    firstSeen: '2026-01-01',
    lastSeen: '2026-06-01',
    hasContext: false,
    contextRole: '',
    suggestedAccountId: undefined,
    suggestedAccountCode: undefined,
    ...overrides,
  };
}

// We need the EntityCandidate type for the helper above
type EntityCandidate = {
  id: string;
  canonicalName: string;
  displayName: string;
  count: number;
  totalAmount: number;
  avgAmount: number;
  frequency: number;
  firstSeen: string;
  lastSeen: string;
  hasContext: boolean;
  contextRole: string;
  suggestedAccountId: string | undefined;
  suggestedAccountCode: string | undefined;
};

// ═══════════════════════════════════════════════════════════════════════
// classifyEntity
// ═══════════════════════════════════════════════════════════════════════

describe('classifyEntity()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls saveContext with correct params when no glAccountCode', async () => {
    (saveContext as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ctx-1' });

    await classifyEntity({
      companyId: 'comp-1',
      pattern: 'ACME CORP',
      role: 'PROVEEDOR',
      source: 'user',
      userId: 'user-1',
    });

    expect(saveContext).toHaveBeenCalledWith({
      companyId: 'comp-1',
      pattern: 'ACME CORP',
      role: 'PROVEEDOR',
      roles: undefined,
      glAccountId: null,
      source: 'user',
      userId: 'user-1',
    });
  });

  it('resolves glAccountCode to glAccountId and passes it', async () => {
    mockDb.glAccount.findFirst.mockResolvedValue({ id: 'gl-001', code: '4010' });
    (saveContext as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ctx-1' });

    await classifyEntity({
      companyId: 'comp-1',
      pattern: 'WAL-MART',
      role: 'PROVEEDOR',
      glAccountCode: '4010',
    });

    expect(mockDb.glAccount.findFirst).toHaveBeenCalledWith({
      where: { companyId: 'comp-1', code: '4010', isActive: true },
    });
    expect(saveContext).toHaveBeenCalledWith(
      expect.objectContaining({ glAccountId: 'gl-001' }),
    );
  });

  it('passes null glAccountId when glAccountCode yields no match', async () => {
    mockDb.glAccount.findFirst.mockResolvedValue(null);
    (saveContext as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ctx-1' });

    await classifyEntity({
      companyId: 'comp-1',
      pattern: 'UNKNOWN',
      role: 'OTRO',
      glAccountCode: '9999',
    });

    expect(saveContext).toHaveBeenCalledWith(
      expect.objectContaining({ glAccountId: null }),
    );
  });

  it('defaults source to "user" when not provided', async () => {
    (saveContext as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ctx-1' });

    await classifyEntity({
      companyId: 'comp-1',
      pattern: 'TEST',
      role: 'CLIENTE',
    });

    expect(saveContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'user' }),
    );
  });

  it('forwards roles array when provided', async () => {
    (saveContext as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ctx-1' });

    await classifyEntity({
      companyId: 'comp-1',
      pattern: 'MULTI-ROLE',
      role: 'SOCIO',
      roles: ['SOCIO', 'CLIENTE'],
    });

    expect(saveContext).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['SOCIO', 'CLIENTE'] }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getEntityCandidates
// ═══════════════════════════════════════════════════════════════════════

describe('getEntityCandidates()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no bank accounts exist', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([]);

    const result = await getEntityCandidates('comp-1');

    expect(result).toEqual([]);
    expect(mockDb.bankTransaction.findMany).not.toHaveBeenCalled();
  });

  it('returns empty array when no transactions exist', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba-1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([]);

    const result = await getEntityCandidates('comp-1');

    expect(result).toEqual([]);
    expect(clusterCandidates).not.toHaveBeenCalled();
  });

  it('returns candidates after filtering existing contexts and rules', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba-1' }, { id: 'ba-2' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { description: 'Zelle from ACME', amount: 100, date: '2026-06-01', id: 'tx-1' },
      { description: 'Zelle from WAL-MART', amount: 200, date: '2026-06-01', id: 'tx-2' },
    ]);

    const mockConfig = { rules: { anchor: { regex: '^.*$' } } };
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue(mockConfig);

    const walMartCandidate = makeCandidate({
      id: 'cand-wm',
      canonicalName: 'WAL-MART',
      count: 1,
      totalAmount: 200,
    });

    (clusterCandidates as ReturnType<typeof vi.fn>).mockReturnValue([walMartCandidate]);

    // Existing context for ACME — prevents ACME from appearing in candidates
    mockDb.entityContext.findMany.mockResolvedValue([
      { pattern: 'acme corp', glAccount: { code: '4010' } },
    ]);

    // No rules exist — doesn't filter anything out
    mockDb.bankRule.findMany.mockResolvedValue([]);

    const result = await getEntityCandidates('comp-1');

    expect(result).toHaveLength(1);
    expect(result[0].canonicalName).toBe('WAL-MART');
    expect(result[0].hasContext).toBe(false);
  });

  it('filters out candidates that match existing rules', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba-1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { description: 'Zelle from STARBUCKS', amount: 10, date: '2026-06-01', id: 'tx-1' },
      { description: 'Zelle from MCDONALDS', amount: 20, date: '2026-06-01', id: 'tx-2' },
    ]);

    const mockConfig = { rules: { anchor: { regex: '^.*$' } } };
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue(mockConfig);

    const starbucks = makeCandidate({ id: 'cand-sb', canonicalName: 'STARBUCKS' });
    const mcdonalds = makeCandidate({ id: 'cand-md', canonicalName: 'MCDONALDS' });
    (clusterCandidates as ReturnType<typeof vi.fn>).mockReturnValue([starbucks, mcdonalds]);

    mockDb.entityContext.findMany.mockResolvedValue([]);

    // Rule matches STARBUCKS
    mockDb.bankRule.findMany.mockResolvedValue([
      { conditionValue: 'starbucks', conditions: [] },
    ]);

    const result = await getEntityCandidates('comp-1');

    expect(result).toHaveLength(1);
    expect(result[0].canonicalName).toBe('MCDONALDS');
  });

  it('selects bank accounts with correct companyId filter', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([]);

    await getEntityCandidates('comp-specific');

    expect(mockDb.bankAccount.findMany).toHaveBeenCalledWith({
      where: { companyId: 'comp-specific', isActive: true },
      select: { id: true },
    });
  });

  it('handles candidate filtering by checking rule conditions array', async () => {
    mockDb.bankAccount.findMany.mockResolvedValue([{ id: 'ba-1' }]);
    mockDb.bankTransaction.findMany.mockResolvedValue([
      { description: 'Zelle from ACME', amount: 100, date: '2026-06-01', id: 'tx-1' },
    ]);

    const mockConfig = { rules: { anchor: { regex: '^.*$' } } };
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue(mockConfig);

    const acme = makeCandidate({ id: 'cand-acme', canonicalName: 'ACME CORP' });
    (clusterCandidates as ReturnType<typeof vi.fn>).mockReturnValue([acme]);

    mockDb.entityContext.findMany.mockResolvedValue([]);

    // Rule with conditions array matching ACME
    // Note: getEntityCandidates checks if cond.value contains patternLower, not the reverse
    mockDb.bankRule.findMany.mockResolvedValue([
      { conditionValue: null, conditions: [{ field: 'description', operator: 'contains', value: 'acme corp payment' }] },
    ]);

    const result = await getEntityCandidates('comp-1');

    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// detectEntityConflict (pure function — no mocks needed)
// ═══════════════════════════════════════════════════════════════════════

describe('detectEntityConflict()', () => {
  it('detects merchant in description', () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({});
    (extractComponents as ReturnType<typeof vi.fn>).mockReturnValue({
      merchant: 'AMERICAN EXPRESS',
      indnName: null,
    });

    const result = detectEntityConflict('AMERICAN EXPRESS payment', ['SOCIO PATTERN']);

    expect(result.hasMerchant).toBe(true);
    expect(result.hasSocioInIndn).toBe(false);
    expect(result.merchantName).toBe('AMERICAN EXPRESS');
  });

  it('detects SOCIO in INDN', () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({});
    (extractComponents as ReturnType<typeof vi.fn>).mockReturnValue({
      merchant: null,
      indnName: 'LAURA QUIJANO',
    });

    const result = detectEntityConflict('payment INDN:LAURA QUIJANO', ['laura quijano']);

    expect(result.hasMerchant).toBe(false);
    expect(result.hasSocioInIndn).toBe(true);
    expect(result.socioIndnName).toBe('LAURA QUIJANO');
  });

  it('returns hasSocioInIndn false when known patterns do not match', () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({});
    (extractComponents as ReturnType<typeof vi.fn>).mockReturnValue({
      merchant: null,
      indnName: 'MARIA GOMEZ',
    });

    const result = detectEntityConflict('payment INDN:MARIA GOMEZ', ['laura quijano', 'juan perez']);

    expect(result.hasSocioInIndn).toBe(false);
    expect(result.socioIndnName).toBe('MARIA GOMEZ');
  });

  it('returns empty conflict info when no merchant and no INDN', () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({});
    (extractComponents as ReturnType<typeof vi.fn>).mockReturnValue({
      merchant: null,
      indnName: null,
    });

    const result = detectEntityConflict('plain description', []);

    expect(result.hasMerchant).toBe(false);
    expect(result.hasSocioInIndn).toBe(false);
    expect(result.merchantName).toBeNull();
    expect(result.socioIndnName).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getKnownSocioPatterns
// ═══════════════════════════════════════════════════════════════════════

describe('getKnownSocioPatterns()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns patterns for contexts with SOCIO role', async () => {
    mockDb.entityContext.findMany.mockResolvedValue([
      { pattern: 'ACME PARTNERS', role: 'SOCIO', roles: null },
      { pattern: 'WAL-MART', role: 'PROVEEDOR', roles: null },
    ]);

    const result = await getKnownSocioPatterns('comp-1');

    expect(result).toEqual(['acme partners']);
  });

  it('checks roles JSON array for SOCIO membership', async () => {
    mockDb.entityContext.findMany.mockResolvedValue([
      { pattern: 'MULTI-ROLE ENTITY', role: 'CLIENTE', roles: JSON.stringify(['SOCIO', 'CLIENTE']) },
      { pattern: 'REGULAR VENDOR', role: 'PROVEEDOR', roles: null },
    ]);

    const result = await getKnownSocioPatterns('comp-1');

    expect(result).toEqual(['multi-role entity']);
  });

  it('returns empty array when no SOCIO contexts exist', async () => {
    mockDb.entityContext.findMany.mockResolvedValue([
      { pattern: 'CLIENTE A', role: 'CLIENTE', roles: null },
      { pattern: 'PROVEEDOR B', role: 'PROVEEDOR', roles: null },
    ]);

    const result = await getKnownSocioPatterns('comp-1');

    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Role schema validation (now accepts any string)
// ═══════════════════════════════════════════════════════════════════════

describe('entityRoleSchema', () => {
  it('accepts all base roles from ENTITY_ROLES', () => {
    for (const role of ENTITY_ROLES) {
      const result = entityRoleSchema.safeParse(role);
      expect(result.success).toBe(true);
    }
  });

  it('accepts any custom role string', () => {
    expect(entityRoleSchema.safeParse('FIDEICOMISO').success).toBe(true);
    expect(entityRoleSchema.safeParse('PLATAFORMA').success).toBe(true);
    expect(entityRoleSchema.safeParse('INVERSOR').success).toBe(true);
  });

  it('accepts lowercase strings', () => {
    expect(entityRoleSchema.safeParse('proveedor').success).toBe(true);
    expect(entityRoleSchema.safeParse('cliente').success).toBe(true);
  });

  it('UI_ROLES excludes IGNORADA', () => {
    expect(UI_ROLES).not.toContain('IGNORADA');
    expect(UI_ROLES).toHaveLength(ENTITY_ROLES.length - 1);
  });

  it('contains exactly 11 roles in ENTITY_ROLES', () => {
    expect(ENTITY_ROLES).toHaveLength(11);
    expect(ENTITY_ROLES).toEqual([
      'INQUILINO',
      'PROVEEDOR',
      'SOCIO',
      'CLIENTE',
      'EMPLEADO',
      'TARJETA_CREDITO',
      'PRESTAMO',
      'GASTO_OPERATIVO',
      'INGRESO',
      'OTRO',
      'IGNORADA',
    ]);
  });
});
