import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiProposalData, ImportRuleResolution } from '../rule-precedence-adapters';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock resolveImportRule to return AI proposal
const mockResolveImportRule = vi.fn();
vi.mock('@/lib/services/rule-precedence-import-resolver', () => ({
  resolveImportRule: (...args: unknown[]) => mockResolveImportRule(...args),
}));

// Mock db
const mockPendingApprovalCreate = vi.fn();
const mockBankTransactionCreateMany = vi.fn();
const mockBankTransactionFindMany = vi.fn().mockResolvedValue([]);
const mockBankStatementFindFirst = vi.fn().mockResolvedValue(null);
const mockBankStatementFindMany = vi.fn().mockResolvedValue([]);
const mockBankStatementCreate = vi.fn().mockResolvedValue({ id: 'stmt-1' });
const mockBankRuleFindMany = vi.fn().mockResolvedValue([]);

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

// Mock flag
vi.mock('@/lib/rule-engine/flag', () => ({
  isOperationalPolicyImportObservationEnabled: vi.fn().mockReturnValue(false),
  getEngineMode: vi.fn().mockReturnValue('v2'),
}));

// Mock rule engine events
vi.mock('@/lib/rule-engine/events', () => ({
  buildDivergenceEvent: vi.fn(),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AI_PROPOSAL: AiProposalData = {
  role: 'expense',
  glAccountCode: '6100',
  glAccountId: null,
  conditions: undefined,
  suggestSubAccount: false,
  subAccountName: null,
};

const RESOLUTION_WITH_AI: ImportRuleResolution = {
  matchedRuleId: null,
  glAccountId: null,
  deterministicResult: 'no_match',
  aiProposal: AI_PROPOSAL,
};

const RESOLUTION_WITHOUT_AI: ImportRuleResolution = {
  matchedRuleId: 'rule-1',
  glAccountId: 'gl-1',
  deterministicResult: 'winner',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('import AI fallback integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveImportRule.mockResolvedValue(RESOLUTION_WITH_AI);
  });

  it('T12: creates PendingApproval with correct fields when aiProposal exists', async () => {
    // Import the service after mocks are set up
    const { ImportService } = await import('@/lib/services/import.service');

    await ImportService.importFile({
      companyId: 'company-1',
      bankAccountId: 'bank-1',
      fileName: 'test.csv',
      extension: 'csv',
      buffer: Buffer.from('date,description,amount\n2026-01-15,NETFLIX,-15.99'),
      content: 'date,description,amount\n2026-01-15,NETFLIX,-15.99',
      userId: 'user-123',
    });

    // Verify PendingApproval was created
    expect(mockPendingApprovalCreate).toHaveBeenCalledOnce();

    const callArgs = mockPendingApprovalCreate.mock.calls[0][0];
    expect(callArgs.data.action).toBe('ai_classification_proposal');
    expect(callArgs.data.status).toBe('pending');
    expect(callArgs.data.requestedBy).toBe('user-123');

    // Verify payload fields
    expect(callArgs.data.payload.companyId).toBe('company-1');
    expect(callArgs.data.payload.transactionId).toBeDefined();
    expect(callArgs.data.payload.bankAccountId).toBe('bank-1');
    expect(callArgs.data.payload.deterministicResult).toBe('no_match');
    expect(callArgs.data.payload.aiProposal).toEqual(AI_PROPOSAL);
  });

  it('T13: requestedBy is real userId, no synthetic fallback', async () => {
    const { ImportService } = await import('@/lib/services/import.service');

    await ImportService.importFile({
      companyId: 'company-1',
      bankAccountId: 'bank-1',
      fileName: 'test.csv',
      extension: 'csv',
      buffer: Buffer.from('date,description,amount\n2026-01-15,NETFLIX,-15.99'),
      content: 'date,description,amount\n2026-01-15,NETFLIX,-15.99',
      userId: 'real-user-456',
    });

    const callArgs = mockPendingApprovalCreate.mock.calls[0][0];
    expect(callArgs.data.requestedBy).toBe('real-user-456');

    // Verify no synthetic fallback
    expect(callArgs.data.requestedBy).not.toBe('system');
    expect(callArgs.data.requestedBy).not.toBe('unknown');
    expect(callArgs.data.requestedBy).not.toBe('anonymous');
  });

  it('T14: AI proposal does not auto-classify or auto-post', async () => {
    const { ImportService } = await import('@/lib/services/import.service');

    await ImportService.importFile({
      companyId: 'company-1',
      bankAccountId: 'bank-1',
      fileName: 'test.csv',
      extension: 'csv',
      buffer: Buffer.from('date,description,amount\n2026-01-15,NETFLIX,-15.99'),
      content: 'date,description,amount\n2026-01-15,NETFLIX,-15.99',
      userId: 'user-789',
    });

    // Verify BankTransaction was created with null glAccountId and matchedRuleId
    const createManyCall = mockBankTransactionCreateMany.mock.calls[0][0];
    const txData = createManyCall.data[0];
    expect(txData.glAccountId).toBeNull();
    expect(txData.matchedRuleId).toBeNull();

    // Verify JournalEntry was NOT created (no glAccountId)
    expect(mockCreateFromBankTransaction).not.toHaveBeenCalled();
  });

  it('does not create PendingApproval when aiProposal is absent', async () => {
    mockResolveImportRule.mockResolvedValue(RESOLUTION_WITHOUT_AI);

    const { ImportService } = await import('@/lib/services/import.service');

    await ImportService.importFile({
      companyId: 'company-1',
      bankAccountId: 'bank-1',
      fileName: 'test.csv',
      extension: 'csv',
      buffer: Buffer.from('date,description,amount\n2026-01-15,NETFLIX,-15.99'),
      content: 'date,description,amount\n2026-01-15,NETFLIX,-15.99',
      userId: 'user-101',
    });

    // Verify PendingApproval was NOT created
    expect(mockPendingApprovalCreate).not.toHaveBeenCalled();
  });
});
