import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// NOTE: rule-precedence-import-resolver is intentionally NOT mocked —
// the real resolver must run resolveWithV2 so the full productive chain
// (importFile → resolveImportDecision → resolveImportRule → resolveWithV2
// → pendingApproval.create) is exercised.

// Mock rule-engine-adapter: runRuleEngineV2 is consumed by both the real
// resolver and import.service (which also imports runRuleEngineV2Shadow).
const mockRunRuleEngineV2 = vi.hoisted(() => ({ fn: vi.fn() }));
const mockRunRuleEngineV2Shadow = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/services/rule-engine-adapter', () => ({
  runRuleEngineV2: mockRunRuleEngineV2.fn,
  runRuleEngineV2Shadow: mockRunRuleEngineV2Shadow.fn,
}));

// Mock flag module: import.service imports both names.
vi.mock('@/lib/rule-engine/flag', () => ({
  getEngineMode: vi.fn(() => 'v2'),
  isOperationalPolicyImportObservationEnabled: vi.fn(() => false),
}));

// Mock db
const mockPendingApprovalCreate = vi.fn();
const mockBankTransactionCreateMany = vi.fn();
const mockBankTransactionFindMany = vi.fn().mockResolvedValue([]);
const mockBankStatementFindFirst = vi.fn().mockResolvedValue(null);
const mockBankStatementFindMany = vi.fn().mockResolvedValue([]);
const mockBankStatementCreate = vi.fn().mockResolvedValue({ id: 'stmt-1' });
const mockBankRuleFindMany = vi.fn().mockResolvedValue([]);
const mockMemoryVersionCreate = vi.fn().mockResolvedValue({});

vi.mock('@/lib/db', () => ({
  db: {
    pendingApproval: { create: (...args: unknown[]) => mockPendingApprovalCreate(...args) },
    bankTransaction: {
      createMany: (...args: unknown[]) => mockBankTransactionCreateMany(...args),
      findMany: (...args: unknown[]) => mockBankTransactionFindMany(...args),
    },
    bankStatement: {
      findFirst: (...args: unknown[]) => mockBankStatementFindFirst(...args),
      findMany: (...args: unknown[]) => mockBankStatementFindMany(...args),
      create: (...args: unknown[]) => mockBankStatementCreate(...args),
    },
    bankRule: { findMany: (...args: unknown[]) => mockBankRuleFindMany(...args) },
    bankAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'bank-1', accountNo: '001' }) },
    company: { findUnique: vi.fn().mockResolvedValue({ id: 'company-1', legalName: 'Test Co', entityType: 'individual' }) },
    memoryItem: { findMany: vi.fn().mockResolvedValue([]) },
    companyKnowledge: { findMany: vi.fn().mockResolvedValue([]) },
    memoryVersion: { findMany: vi.fn().mockResolvedValue([]), create: mockMemoryVersionCreate },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const tx = {
        pendingApproval: { create: mockPendingApprovalCreate },
        bankTransaction: {
          createMany: mockBankTransactionCreateMany,
          findMany: mockBankTransactionFindMany,
        },
        bankStatement: {
          findFirst: mockBankStatementFindFirst,
          findMany: mockBankStatementFindMany,
          create: mockBankStatementCreate,
        },
        memoryItem: { findMany: vi.fn().mockResolvedValue([]) },
        companyKnowledge: { findMany: vi.fn().mockResolvedValue([]) },
        memoryVersion: { findMany: vi.fn().mockResolvedValue([]), create: mockMemoryVersionCreate },
      };
      return fn(tx);
    }),
  },
}));

// Mock JournalEntryService
const mockCreateFromBankTransaction = vi.fn();
vi.mock('@/lib/services/journal-entry.service', () => ({
  JournalEntryService: {
    createFromBankTransaction: (...args: unknown[]) => mockCreateFromBankTransaction(...args),
  },
}));

// Mock audit
vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: vi.fn(),
}));

// Mock fiscal period guard
vi.mock('@/lib/fiscal-period-guard', () => ({
  assertActiveFiscalPeriod: vi.fn(),
}));

// Mock shadow
vi.mock('@/lib/services/rule-precedence-shadow', () => ({
  isRulePrecedenceShadowEnabled: vi.fn().mockReturnValue(false),
  toRulePrecedenceRule: vi.fn(),
  runShadowComparison: vi.fn(),
  accumulateShadowSummary: vi.fn(),
  persistShadowSummaryBestEffort: vi.fn(),
  createEmptyShadowImportSummary: vi.fn(),
}));

// Mock shadow metrics
vi.mock('@/lib/services/shadow-metrics-reader', () => ({
  ShadowMetricsReader: vi.fn().mockImplementation(() => ({})),
}));

// Mock operational policy
vi.mock('@/lib/operational-policy/policy-service', () => ({
  evaluateOperationalPolicy: vi.fn(),
}));

// Mock rule engine events
vi.mock('@/lib/rule-engine/events', () => ({
  buildDivergenceEvent: vi.fn(),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Matches what the real adapter produces today: NO proposedEntity field.
const AI_PROPOSAL = {
  role: 'expense',
  glAccountCode: '6100',
  glAccountId: null,
  suggestSubAccount: false,
  subAccountName: null,
};

const CSV = 'date,description,amount\n2026-01-15,NETFLIX,-15.99';

async function runImport() {
  const { ImportService } = await import('@/lib/services/import.service');
  return ImportService.importFile({
    companyId: 'company-1',
    bankAccountId: 'bank-1',
    fileName: 'test.csv',
    extension: 'csv',
    buffer: Buffer.from(CSV),
    content: CSV,
    userId: 'user-123',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('import AI proposal transport (full productive chain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('full v2 chain creates exactly one PendingApproval with the transported proposal', async () => {
    mockRunRuleEngineV2.fn.mockResolvedValue({
      outcome: 'pending',
      deterministicResult: 'no_match',
      aiProposal: AI_PROPOSAL,
    });

    await runImport();

    // Real resolver invoked the V2 engine.
    expect(mockRunRuleEngineV2.fn).toHaveBeenCalledTimes(1);

    // Real import.service persistence block fired.
    expect(mockPendingApprovalCreate).toHaveBeenCalledOnce();

    const callArgs = mockPendingApprovalCreate.mock.calls[0][0];
    expect(callArgs.data.action).toBe('ai_classification_proposal');
    expect(callArgs.data.status).toBe('pending');
    expect(callArgs.data.requestedBy).toBe('user-123');

    const payload = callArgs.data.payload;
    expect(payload.companyId).toBe('company-1');
    expect(payload.bankAccountId).toBe('bank-1');
    expect(payload.transactionId).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.deterministicResult).toBe('no_match');
    expect(payload.aiProposal).toEqual(AI_PROPOSAL);
    // Current adapter contract (observation, not a change): no proposedEntity.
    expect(payload.proposedEntity).toBeNull();
  });

  it('proposal does not auto-classify, auto-post, or trigger KE learning', async () => {
    mockRunRuleEngineV2.fn.mockResolvedValue({
      outcome: 'pending',
      deterministicResult: 'no_match',
      aiProposal: AI_PROPOSAL,
    });

    await runImport();

    const createManyCall = mockBankTransactionCreateMany.mock.calls[0][0];
    const txData = createManyCall.data[0];
    expect(txData.glAccountId).toBeNull();
    expect(txData.matchedRuleId).toBeNull();

    expect(mockCreateFromBankTransaction).not.toHaveBeenCalled();
    expect(mockMemoryVersionCreate).not.toHaveBeenCalled();
  });

  it('pending without aiProposal creates no PendingApproval', async () => {
    mockRunRuleEngineV2.fn.mockResolvedValue({
      outcome: 'pending',
      deterministicResult: 'no_match',
    });

    await runImport();

    expect(mockPendingApprovalCreate).not.toHaveBeenCalled();
  });
});
