import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveContextRole,
  suggestGlAccount,
  resolveDirection,
  enrichCandidates,
  checkRoleDirectionMismatch,
} from '@/lib/services/entity-enricher';
import type { EntityContextWithGlAccount } from '@/lib/types/entity-context';
import type { EntityCandidate } from '@/lib/services/entity-detector';
import type { EnrichmentInput, EnrichedCandidate } from '@/lib/services/entity-enricher';

// ─── Shared test data ─────────────────────────────────────────────

const mockContextProveedor: EntityContextWithGlAccount = {
  id: 'ctx_1',
  companyId: 'comp_1',
  pattern: 'acme corp',
  role: 'PROVEEDOR',
  roles: null,
  glAccountId: 'gla_1',
  source: 'user',
  userDescription: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  transactionDirection: null,
  glAccount: { id: 'gla_1', code: '6070', name: 'Costo de Ventas' },
};

const mockContextCliente: EntityContextWithGlAccount = {
  id: 'ctx_2',
  companyId: 'comp_1',
  pattern: 'wal-mart',
  role: 'CLIENTE',
  roles: null,
  glAccountId: null,
  source: 'user',
  userDescription: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  transactionDirection: null,
  glAccount: null,
};

const mockContextSocio: EntityContextWithGlAccount = {
  id: 'ctx_3',
  companyId: 'comp_1',
  pattern: 'laura quijano',
  role: 'SOCIO',
  roles: null,
  glAccountId: null,
  source: 'user',
  userDescription: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  transactionDirection: null,
  glAccount: null,
};

const mockGlAccounts = [
  { id: 'gla_1', name: 'Costo de Ventas', code: '6070', accountType: 'expense' },
  { id: 'gla_2', name: 'Cuentas por Cobrar', code: '4010', accountType: 'revenue' },
  { id: 'gla_3', name: 'Aportes de Socios', code: '3010', accountType: 'equity' },
];

function makeCandidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  return {
    id: 'can_1',
    canonicalName: 'ACME CORP',
    occurrences: 5,
    directionProfile: { creditPct: 0.8, debitPct: 0.2 },
    sampleDescriptions: ['Zelle payment to ACME CORP'],
    ...overrides,
  };
}

// ─── resolveContextRole ───────────────────────────────────────────
describe('resolveContextRole', () => {
  let input: EnrichmentInput;

  beforeEach(() => {
    input = {
      contexts: [mockContextProveedor, mockContextCliente, mockContextSocio],
      glAccounts: mockGlAccounts,
      rolePriorities: { PROVEEDOR: 1, CLIENTE: 2, SOCIO: 3 },
    };
  });

  it('matches context via normalizePattern().includes() on description', () => {
    const candidate = makeCandidate({ canonicalName: 'ACME CORP' });
    const description = 'Zelle payment to ACME CORP';
    const result = resolveContextRole(candidate, description, input);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('PROVEEDOR');
  });

  it('matches context via candidate name when it includes ctx pattern', () => {
    const candidate = makeCandidate({ canonicalName: 'ACME CORP SERVICES' });
    const description = 'Some random description with no match';
    // pattern "acme corp" should match candidate name "acme corp services"
    const result = resolveContextRole(candidate, description, input);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('PROVEEDOR');
  });

  it('returns null when no context matches', () => {
    const candidate = makeCandidate({ canonicalName: 'UNKNOWN VENDOR' });
    const description = 'Zelle payment to unknown vendor';
    const result = resolveContextRole(candidate, description, input);
    expect(result).toBeNull();
  });

  it('selects higher priority role when multiple contexts match', () => {
    // Both PROVEEDOR and SOCIO patterns overlap
    const candidate = makeCandidate({ canonicalName: 'OMAR MIRA' });
    const description = 'Zelle payment to OMAR MIRA';
    // Create a second PROVEEDOR context that also matches "omar mira"
    const inputWithOverlap: EnrichmentInput = {
      ...input,
      contexts: [
        { ...mockContextProveedor, pattern: 'omar mira' },
        { ...mockContextSocio, pattern: 'omar mira' },
      ],
    };
    const result = resolveContextRole(candidate, description, inputWithOverlap);
    expect(result).not.toBeNull();
    // PROVEEDOR has priority 1, SOCIO has 3 → PROVEEDOR wins
    expect(result!.role).toBe('PROVEEDOR');
  });

  it('handles SOCIO conflict via knownSocioPatterns', () => {
    // Transaction with merchant at P1 + SOCIO name at INDN
    const candidate = makeCandidate({ canonicalName: 'ACME CORP' });
    const description = 'AMERICAN EXPRESS DES:PMT ID:123 INDN:LAURA QUIJANO CO ID:987';
    const inputWithSocioConflict: EnrichmentInput = {
      contexts: [
        { ...mockContextProveedor, pattern: 'american express' },
        mockContextSocio,
      ],
      glAccounts: mockGlAccounts,
      rolePriorities: { PROVEEDOR: 1, SOCIO: 3 },
      knownSocioPatterns: ['laura quijano'],
    };
    const result = resolveContextRole(candidate, description, inputWithSocioConflict);
    expect(result).not.toBeNull();
    // SOCIO context should be excluded → only PROVEEDOR matches
    expect(result!.role).toBe('PROVEEDOR');
  });

  it('returns null when SOCIO conflict excludes all matches', () => {
    const candidate = makeCandidate({ canonicalName: 'LAURA QUIJANO' });
    const description = 'AMERICAN EXPRESS DES:PMT ID:123 INDN:LAURA QUIJANO CO ID:987';
    const inputSocioOnly: EnrichmentInput = {
      contexts: [mockContextSocio],
      glAccounts: mockGlAccounts,
      knownSocioPatterns: ['laura quijano'],
    };
    const result = resolveContextRole(candidate, description, inputSocioOnly);
    // SOCIO excluded by conflict, no other contexts → null
    expect(result).toBeNull();
  });
});

// ─── suggestGlAccount ─────────────────────────────────────────────
describe('suggestGlAccount', () => {
  it('returns context.glAccount when context has linked GL account', () => {
    const result = suggestGlAccount(mockContextProveedor, 'debit', mockGlAccounts);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('gla_1');
    expect(result!.code).toBe('6070');
    expect(result!.name).toBe('Costo de Ventas');
  });

  it('resolves debit account via ROLE_ACCOUNT_MAP when context has role but no glAccount', () => {
    // CLIENTE role: debit = '4010', credit = '4010', fallback = '4010'
    const result = suggestGlAccount(mockContextCliente, 'debit', mockGlAccounts);
    expect(result).not.toBeNull();
    expect(result!.code).toBe('4010');
  });

  it('resolves credit account via ROLE_ACCOUNT_MAP when direction is credit', () => {
    const result = suggestGlAccount(mockContextCliente, 'credit', mockGlAccounts);
    expect(result).not.toBeNull();
    expect(result!.code).toBe('4010');
  });

  it('returns null when no context and no role', () => {
    const result = suggestGlAccount(null, 'debit', mockGlAccounts);
    expect(result).toBeNull();
  });

  it('returns null when role has no mapping in ROLE_ACCOUNT_MAP', () => {
    const contextOtro: EntityContextWithGlAccount = {
      ...mockContextProveedor,
      pattern: 'otro',
      role: 'OTRO',
      glAccountId: null,
      glAccount: null,
    };
    const result = suggestGlAccount(contextOtro, 'debit', mockGlAccounts);
    expect(result).toBeNull();
  });
});

// ─── resolveDirection ─────────────────────────────────────────────
describe('resolveDirection', () => {
  it('returns "debit" when debitPct > 0.5', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0.3, debitPct: 0.7 },
    });
    expect(resolveDirection(candidate)).toBe('debit');
  });

  it('returns "credit" when creditPct > 0.5', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0.9, debitPct: 0.1 },
    });
    expect(resolveDirection(candidate)).toBe('credit');
  });

  it('returns null when ambiguous (50/50)', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0.5, debitPct: 0.5 },
    });
    expect(resolveDirection(candidate)).toBeNull();
  });

  it('returns null when both are 0', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0, debitPct: 0 },
    });
    expect(resolveDirection(candidate)).toBeNull();
  });
});

// ─── checkRoleDirectionMismatch ────────────────────────────────────
describe('checkRoleDirectionMismatch', () => {
  // F1: CLIENTE expects credit → mostly credits = no warning
  it('returns null when CLIENTE direction matches (mostly credits)', () => {
    const result = checkRoleDirectionMismatch('CLIENTE', 0.2, 0.8);
    expect(result).toBeNull();
  });

  // F2: CLIENTE expects credit but mostly debits → warning
  it('returns warning when CLIENTE expects credit but most txns are debits', () => {
    const result = checkRoleDirectionMismatch('CLIENTE', 0.8, 0.2);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain('expects credits');
    expect(result!.warning).toContain('debits');
  });

  // F3: SOCIO is 'mixed' → never warns
  it('returns null for SOCIO regardless of direction (mixed)', () => {
    expect(checkRoleDirectionMismatch('SOCIO', 0.9, 0.1)).toBeNull();
    expect(checkRoleDirectionMismatch('SOCIO', 0.1, 0.9)).toBeNull();
    expect(checkRoleDirectionMismatch('SOCIO', 0.5, 0.5)).toBeNull();
  });

  // F4: INGRESO expects credit but mostly debits → warning
  it('returns warning when INGRESO expects credit but most txns are debits', () => {
    const result = checkRoleDirectionMismatch('INGRESO', 0.8, 0.2);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain('expects credits');
  });

  // F5: PROVEEDOR expects debit but mostly credits → warning
  it('returns warning when PROVEEDOR expects debit but most txns are credits', () => {
    const result = checkRoleDirectionMismatch('PROVEEDOR', 0.2, 0.8);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain('expects debits');
    expect(result!.warning).toContain('credits');
  });

  // F6: OTRO and IGNORADA have no expected direction → always null
  it('returns null for OTRO and IGNORADA (no expected direction)', () => {
    expect(checkRoleDirectionMismatch('OTRO', 0.9, 0.1)).toBeNull();
    expect(checkRoleDirectionMismatch('OTRO', 0.1, 0.9)).toBeNull();
    expect(checkRoleDirectionMismatch('IGNORADA', 0.9, 0.1)).toBeNull();
  });

  it('returns null for non-canonical role string', () => {
    expect(checkRoleDirectionMismatch('CUALQUIER_COSA', 0.9, 0.1)).toBeNull();
  });
});

// ─── enrichCandidates ─────────────────────────────────────────────
describe('enrichCandidates', () => {
  let input: EnrichmentInput;

  beforeEach(() => {
    input = {
      contexts: [mockContextProveedor, mockContextCliente],
      glAccounts: mockGlAccounts,
      rolePriorities: { PROVEEDOR: 1, CLIENTE: 2 },
    };
  });

  it('returns empty array for empty candidates', () => {
    const result = enrichCandidates([], new Map(), input);
    expect(result).toEqual([]);
  });

  it('fully enriches a candidate with matching context and confidence fields', () => {
    const candidate = makeCandidate({ canonicalName: 'ACME CORP' });
    const descs = new Map([['acme corp', 'Zelle payment to ACME CORP']]);
    const result = enrichCandidates([candidate], descs, input);

    expect(result).toHaveLength(1);
    const enriched = result[0];
    expect(enriched.hasContext).toBe(true);
    expect(enriched.contextRole).toBe('PROVEEDOR');
    expect(enriched.suggestedAccountName).toBe('Costo de Ventas');
    expect(enriched.suggestedAccountCode).toBe('6070');
    expect(enriched.suggestedAccountId).toBe('gla_1');
    expect(enriched.confidence).toBe(0.95);
    expect(enriched.confidenceLabel).toBe('high');
    expect(enriched.explanation).toBeTruthy();
  });

  it('includes candidates without context but marks them as low confidence (no requireRole filter)', () => {
    const withoutContext = makeCandidate({
      id: 'can_2',
      canonicalName: 'UNKNOWN VENDOR',
      sampleDescriptions: ['Zelle to unknown vendor'],
    });
    const descs = new Map([['unknown vendor', 'Zelle to unknown vendor']]);
    const result = enrichCandidates([withoutContext], descs, input);

    expect(result).toHaveLength(1);
    const enriched = result[0];
    expect(enriched.hasContext).toBe(false);
    expect(enriched.confidence).toBe(0);
    expect(enriched.confidenceLabel).toBe('low');
    expect(enriched.explanation).toBeTruthy();
  });

  it('smartFrequency: true adjusts minOccurrences (context → 1, no context → minOccurrences)', () => {
    const withContext = makeCandidate({
      id: 'can_1',
      canonicalName: 'ACME CORP',
      occurrences: 1,
      sampleDescriptions: ['Zelle payment to ACME CORP'],
    });
    const withoutContext = makeCandidate({
      id: 'can_2',
      canonicalName: 'RARE VENDOR',
      occurrences: 1,
      sampleDescriptions: ['Zelle to rare vendor'],
    });
    const descs = new Map([
      ['acme corp', 'Zelle payment to ACME CORP'],
      ['rare vendor', 'Zelle to rare vendor'],
    ]);
    const result = enrichCandidates(
      [withContext, withoutContext],
      descs,
      input,
      { smartFrequency: true, minOccurrences: 2 },
    );

    // ACME has context → minOccurrences = 1 → included
    // RARE has no context → minOccurrences = 2 → filtered out
    expect(result).toHaveLength(1);
    expect(result[0].canonicalName).toBe('ACME CORP');
  });

  it('skips candidates that already have an existing rule', () => {
    const candidate = makeCandidate({ canonicalName: 'ACME CORP' });
    const descs = new Map([['acme corp', 'Zelle payment to ACME CORP']]);
    const inputWithRules: EnrichmentInput = {
      ...input,
      existingRules: [
        { conditionValue: 'acme corp', conditionType: 'contains' },
      ],
    };
    const result = enrichCandidates([candidate], descs, inputWithRules);

    expect(result).toHaveLength(0);
  });

  it('preserves directionProfile and occurrences in enriched output', () => {
    const candidate = makeCandidate({
      canonicalName: 'ACME CORP',
      occurrences: 5,
      directionProfile: { creditPct: 0.2, debitPct: 0.8 },
    });
    const descs = new Map([['acme corp', 'Zelle payment to ACME CORP']]);
    const result = enrichCandidates([candidate], descs, input);

    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(5);
    expect(result[0].directionProfile.debitPct).toBe(0.8);
  });
});
