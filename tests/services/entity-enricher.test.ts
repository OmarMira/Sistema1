import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveContextRole,
  suggestGlAccount,
  majorityDirection,
  enrichCandidates,
} from '@/lib/services/entity-enricher';
import { roleIsValidForDirection } from '@/lib/services/direction-filter';
import type { EntityContextWithGlAccount } from '@/lib/types/entity-context';
import type { EntityCandidate } from '@/lib/services/entity-detector';
import type { EnrichmentInput, EnrichedCandidate } from '@/lib/services/entity-enricher';

// ─── Mocks for KE modules ──────────────────────────────────────────
const mockResolveEntity = vi.fn();
const mockLookupTreatment = vi.fn();
const mockCreateAdapter = vi.fn(() => ({ getByType: vi.fn() }));
const mockMatchAuthorizedPattern = vi.fn().mockResolvedValue({ kind: 'no_match' } as const);

vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: (...args: unknown[]) => mockResolveEntity(...args),
}));

vi.mock('@/memory/classification-knowledge', () => ({
  createAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
  lookupTreatment: (...args: unknown[]) => mockLookupTreatment(...args),
  matchAuthorizedPattern: (...args: unknown[]) => mockMatchAuthorizedPattern(...args),
}));

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
  // createAdapter is mocked, so only $transaction needs a real stub.
  // Build a structural mock that satisfies ExtendedPrismaClient via vi.fn().
  const mockPrismaClient = { $transaction: vi.fn() } as { $transaction: typeof vi.fn; [key: string]: unknown } & Record<string, unknown>;

  it('returns KE treatment GL when KNOWN + FOUND', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({ status: 'FOUND', glAccountId: 'gla_1' });
    const result = await suggestGlAccount('comp_1', 'acme corp', mockContextProveedor, 'debit', mockGlAccounts, mockPrismaClient);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('gla_1');
    expect(result!.code).toBe('6070');
    expect(result!.name).toBe('Costo de Ventas');
  });

  it('returns null when UNKNOWN', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'UNKNOWN' });
    const result = await suggestGlAccount('comp_1', 'unknown vendor', null, 'debit', mockGlAccounts, mockPrismaClient);
    expect(result).toBeNull();
  });

  it('returns null when KNOWN + NOT_FOUND', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_2' });
    mockLookupTreatment.mockResolvedValue({ status: 'NOT_FOUND' });
    const result = await suggestGlAccount('comp_1', 'some entity', null, 'debit', mockGlAccounts, mockPrismaClient);
    expect(result).toBeNull();
  });

  it('returns null when KNOWN + FOUND but GL account not in list', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_3' });
    mockLookupTreatment.mockResolvedValue({ status: 'FOUND', glAccountId: 'gla_not_in_list' });
    const result = await suggestGlAccount('comp_1', 'entity without gl', null, 'debit', mockGlAccounts, mockPrismaClient);
    expect(result).toBeNull();
  });

  it('throws on ERROR', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'ERROR', reason: 'ambiguous' });
    await expect(suggestGlAccount('comp_1', 'ambiguous entity', null, 'debit', mockGlAccounts, mockPrismaClient)).rejects.toThrow('KE entity resolution error');
  });
});

// ─── majorityDirection ─────────────────────────────────────────────
describe('majorityDirection', () => {
  it('returns "debit" when debitPct > 0.5', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0.3, debitPct: 0.7 },
    });
    expect(majorityDirection(candidate)).toBe('debit');
  });

  it('returns "credit" when creditPct > 0.5', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0.9, debitPct: 0.1 },
    });
    expect(majorityDirection(candidate)).toBe('credit');
  });

  it('returns null when ambiguous (50/50)', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0.5, debitPct: 0.5 },
    });
    expect(majorityDirection(candidate)).toBeNull();
  });

  it('returns null when both are 0', () => {
    const candidate = makeCandidate({
      directionProfile: { creditPct: 0, debitPct: 0 },
    });
    expect(majorityDirection(candidate)).toBeNull();
  });
});

// ─── roleIsValidForDirection ────────────────────────────────────────
describe('roleIsValidForDirection', () => {
  // F1: CLIENTE expects credit → credit-dominant profile = valid
  it('returns valid when CLIENTE direction matches (mostly credits)', () => {
    const result = roleIsValidForDirection('CLIENTE', { creditPct: 0.8, debitPct: 0.2 });
    expect(result.valid).toBe(true);
  });

  // F2: CLIENTE expects credit but profile is pure debit → invalid
  it('returns invalid when CLIENTE expects credit but profile is pure debit', () => {
    const result = roleIsValidForDirection('CLIENTE', { creditPct: 0.2, debitPct: 0.8 });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expects credit');
    expect(result.reason).toContain('debit');
  });

  // F3: SOCIO is bypass → always valid
  it('returns valid for SOCIO regardless of direction (bypass)', () => {
    expect(roleIsValidForDirection('SOCIO', { creditPct: 0.9, debitPct: 0.1 }).valid).toBe(true);
    expect(roleIsValidForDirection('SOCIO', { creditPct: 0.1, debitPct: 0.9 }).valid).toBe(true);
    expect(roleIsValidForDirection('SOCIO', { creditPct: 0.5, debitPct: 0.5 }).valid).toBe(true);
  });

  // F4: INGRESO expects credit but profile is pure debit → invalid
  it('returns invalid when INGRESO expects credit but profile is pure debit', () => {
    const result = roleIsValidForDirection('INGRESO', { creditPct: 0.2, debitPct: 0.8 });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expects credit');
  });

  // F5: PROVEEDOR expects debit but profile is pure credit → invalid
  it('returns invalid when PROVEEDOR expects debit but profile is pure credit', () => {
    const result = roleIsValidForDirection('PROVEEDOR', { creditPct: 0.8, debitPct: 0.2 });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expects debit');
    expect(result.reason).toContain('credit');
  });

  // F6: OTRO and IGNORADA are bypass → always valid
  it('returns valid for OTRO and IGNORADA (bypass)', () => {
    expect(roleIsValidForDirection('OTRO', { creditPct: 0.9, debitPct: 0.1 }).valid).toBe(true);
    expect(roleIsValidForDirection('OTRO', { creditPct: 0.1, debitPct: 0.9 }).valid).toBe(true);
    expect(roleIsValidForDirection('IGNORADA', { creditPct: 0.9, debitPct: 0.1 }).valid).toBe(true);
  });

  it('returns valid for non-canonical role string (no expected direction)', () => {
    expect(roleIsValidForDirection('CUALQUIER_COSA', { creditPct: 0.9, debitPct: 0.1 }).valid).toBe(true);
  });
});

// ─── enrichCandidates ─────────────────────────────────────────────
describe('enrichCandidates', () => {
  let input: EnrichmentInput;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEntity.mockResolvedValue({ status: 'UNKNOWN' });
    mockLookupTreatment.mockResolvedValue({ status: 'NOT_FOUND' });
    input = {
      companyId: 'comp_1',
      prismaClient: { $transaction: vi.fn() } as { $transaction: typeof vi.fn; [key: string]: unknown } & Record<string, unknown>,
      contexts: [mockContextProveedor, mockContextCliente],
      glAccounts: mockGlAccounts,
      rolePriorities: { PROVEEDOR: 1, CLIENTE: 2 },
    };
  });

  it('returns empty array for empty candidates', async () => {
    const result = await enrichCandidates([], new Map(), input);
    expect(result).toEqual([]);
  });

  it('fully enriches a candidate with matching context and confidence fields', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({ status: 'FOUND', glAccountId: 'gla_1' });
    const candidate = makeCandidate({ canonicalName: 'ACME CORP' });
    const descs = new Map([['acme corp', 'Zelle payment to ACME CORP']]);
    const result = await enrichCandidates([candidate], descs, input);

    expect(result).toHaveLength(1);
    const enriched = result[0];
    expect(enriched.hasContext).toBe(true);
    expect(enriched.contextRole).toBe('PROVEEDOR');
    expect(enriched.suggestedAccountName).toBe('Costo de Ventas');
    expect(enriched.suggestedAccountCode).toBe('6070');
    expect(enriched.suggestedAccountId).toBe('gla_1');
    expect(enriched.confidence).toBe(0.85);
    expect(enriched.confidenceLabel).toBe('high');
    expect(enriched.explanation).toBeTruthy();
  });

  it('includes candidates without context but marks them as low confidence (no requireRole filter)', async () => {
    const withoutContext = makeCandidate({
      id: 'can_2',
      canonicalName: 'UNKNOWN VENDOR',
      sampleDescriptions: ['Zelle to unknown vendor'],
    });
    const descs = new Map([['unknown vendor', 'Zelle to unknown vendor']]);
    const result = await enrichCandidates([withoutContext], descs, input);

    expect(result).toHaveLength(1);
    const enriched = result[0];
    expect(enriched.hasContext).toBe(false);
    expect(enriched.confidence).toBe(0.55);
    expect(enriched.confidenceLabel).toBe('medium');
    expect(enriched.explanation).toBeTruthy();
  });

  it('smartFrequency: true adjusts minOccurrences (context → 1, no context → minOccurrences)', async () => {
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
    const result = await enrichCandidates(
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

  it('skips candidates that already have an existing rule', async () => {
    const candidate = makeCandidate({ canonicalName: 'ACME CORP' });
    const descs = new Map([['acme corp', 'Zelle payment to ACME CORP']]);
    const inputWithRules: EnrichmentInput = {
      ...input,
      existingRules: [
        { conditionValue: 'acme corp', conditionType: 'contains' },
      ],
    };
    const result = await enrichCandidates([candidate], descs, inputWithRules);

    expect(result).toHaveLength(0);
  });

  it('preserves directionProfile and occurrences in enriched output', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({ status: 'FOUND', glAccountId: 'gla_1' });
    const candidate = makeCandidate({
      canonicalName: 'ACME CORP',
      occurrences: 5,
      directionProfile: { creditPct: 0.2, debitPct: 0.8 },
    });
    const descs = new Map([['acme corp', 'Zelle payment to ACME CORP']]);
    const result = await enrichCandidates([candidate], descs, input);

    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(5);
    expect(result[0].directionProfile.debitPct).toBe(0.8);
  });
});
// ─── KE-EVOL-003: enricher confidence semantics (advisory, human-gated) ──

describe('enrichCandidates — uncertaintyReasons channel (KE-EVOL-003)', () => {
  let input: EnrichmentInput;

  beforeEach(() => {
    vi.clearAllMocks();
    input = {
      companyId: 'comp_1',
      prismaClient: { $transaction: vi.fn() } as { $transaction: typeof vi.fn; [key: string]: unknown } & Record<string, unknown>,
      contexts: [mockContextProveedor],
      glAccounts: mockGlAccounts,
      rolePriorities: { PROVEEDOR: 1 },
    };
  });

  function candidate() {
    return makeCandidate({ canonicalName: 'ACME CORP' });
  }

  function descriptions() {
    return new Map([['acme corp', 'Zelle payment to ACME CORP']]);
  }

  // T29: exact certain → advisory suggestion, no uncertainty disclosure
  it('T29: exact certain → advisory suggestion (no uncertaintyReasons)', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({
      status: 'FOUND', glAccountId: 'gla_1', direction: 'any', confidence: 'certain', memoryItemId: 'mem_1',
    });
    const result = await enrichCandidates([candidate()], descriptions(), input);

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedAccountId).toBe('gla_1');
    expect(result[0]!.uncertaintyReasons).toBeUndefined();
  });

  // T30: exact tentative → advisory suggestion (advisory state unchanged)
  it('T30: exact tentative → advisory suggestion', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({
      status: 'FOUND', glAccountId: 'gla_1', direction: 'any', confidence: 'tentative', memoryItemId: 'mem_1',
    });
    const result = await enrichCandidates([candidate()], descriptions(), input);

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedAccountId).toBe('gla_1');
  });

  // T31/T32: exact uncertain → suggestion stays + uncertaintyReasons, NOT collapsed to null
  it('T31/T32: exact uncertain → suggestion NOT collapsed to null; uncertaintyReasons populated', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({
      status: 'FOUND', glAccountId: 'gla_1', direction: 'any', confidence: 'uncertain', memoryItemId: 'mem_q',
    });
    const result = await enrichCandidates([candidate()], descriptions(), input);

    expect(result).toHaveLength(1);
    const enriched = result[0];
    expect(enriched.suggestedAccountId).toBe('gla_1');
    expect(enriched.suggestedAccountCode).toBe('6070');
    expect(enriched.uncertaintyReasons).toBeDefined();
    expect(enriched.uncertaintyReasons!.length).toBeGreaterThan(0);
    expect(enriched.uncertaintyReasons!.join(' ')).toContain('uncertain');
    expect(enriched.uncertaintyReasons!.join(' ')).toContain('mem_q');
  });

  // T33: structural certain → advisory suggestion
  it('T33: structural certain match → advisory suggestion', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({ status: 'NOT_FOUND' });
    mockMatchAuthorizedPattern.mockResolvedValue({
      kind: 'match', authorizedPatternId: 'apt_1', matchedPatternIds: ['apt_1'],
      entityId: 'ent_1', glAccountId: 'gla_1', direction: 'any',
      sourceCandidateId: 'can_1', observationIds: ['o1'], confidence: 'certain',
    });
    const result = await enrichCandidates([candidate()], descriptions(), input);

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedAccountId).toBe('gla_1');
    expect(result[0]!.uncertaintyReasons).toBeUndefined();
  });

  // T34/T35: structural uncertain → suggestion stays + uncertaintyReasons, NOT collapsed
  it('T34/T35: structural uncertain → suggestion + uncertaintyReasons, not null', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({ status: 'NOT_FOUND' });
    mockMatchAuthorizedPattern.mockResolvedValue({
      kind: 'match', authorizedPatternId: 'apt_q', matchedPatternIds: ['apt_q'],
      entityId: 'ent_1', glAccountId: 'gla_1', direction: 'any',
      sourceCandidateId: 'can_1', observationIds: ['o1'], confidence: 'uncertain',
    });
    const result = await enrichCandidates([candidate()], descriptions(), input);

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedAccountId).toBe('gla_1');
    expect(result[0]!.uncertaintyReasons).toBeDefined();
    expect(result[0]!.uncertaintyReasons!.join(' ')).toContain('uncertain');
    expect(result[0]!.uncertaintyReasons!.join(' ')).toContain('apt_q');
  });

  // T36: matcher ERROR keeps existing behavior
  it('T36: structural match ERROR keeps existing behavior (propagates)', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({ status: 'NOT_FOUND' });
    mockMatchAuthorizedPattern.mockResolvedValue({ kind: 'error', reason: 'DB failure' });

    await expect(enrichCandidates([candidate()], descriptions(), input)).rejects.toThrow('KE structural match error');
  });

  // T40: enricher stays advisory/human-gated — no new writes, reason derives from MemoryItem.confidence
  it('T40: uncertain disclosure does not write anything (advisory, human-gated)', async () => {
    mockResolveEntity.mockResolvedValue({ status: 'KNOWN', entityId: 'ent_1' });
    mockLookupTreatment.mockResolvedValue({
      status: 'FOUND', glAccountId: 'gla_1', direction: 'any', confidence: 'uncertain', memoryItemId: 'mem_q',
    });
    const result = await enrichCandidates([candidate()], descriptions(), input);

    expect(input.prismaClient.$transaction).not.toHaveBeenCalled();
    expect(result[0]!.suggestedAccountId).toBe('gla_1');
  });
});
