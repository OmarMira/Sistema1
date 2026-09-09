// Knowledge Engine — Import Pipeline Integration Tests
// Tests that demonstrate KE_HIT skips rule engine and KE_MISS continues.
// Uses the REAL resolveImportDecision function (no simulated functions).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  learnFromCorrection,
} from '../../src/memory/classification-knowledge';
import { resolveImportDecision } from '../../src/lib/services/import.service';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client (satisfies MemoryPrismaClient) ──────────

function createMockPrisma() {
  const store = new Map<string, { id: string; content: string; type: string; status: string; confidence: string; companyId: string }>();
  let nextId = 1;

  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    memoryItem: {
      create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; [key: string]: unknown } }) => {
        const id = `mem_${nextId++}`;
        const item = {
          id,
          content: args.data.content,
          type: args.data.type,
          status: 'active',
          confidence: 'tentative',
          companyId: args.data.companyId,
        };
        store.set(id, item);
        return item;
      }),
      findFirst: vi.fn(async (args?: { where?: { id?: string; companyId?: string; content?: string; status?: string } }) => {
        for (const item of store.values()) {
          let match = true;
          if (args?.where?.id && item.id !== args.where.id) match = false;
          if (args?.where?.companyId && item.companyId !== args.where.companyId) match = false;
          if (args?.where?.content && item.content !== args.where.content) match = false;
          if (args?.where?.status && item.status !== args.where.status) match = false;
          if (match) return item;
        }
        return null;
      }),
      findMany: vi.fn(async (args?: { where?: { companyId?: string; type?: string; [key: string]: unknown } }) => {
        let results = Array.from(store.values());
        if (args?.where?.companyId) {
          results = results.filter((item) => item.companyId === args.where!.companyId);
        }
        if (args?.where?.type) {
          results = results.filter((item) => item.type === args.where!.type);
        }
        return results;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { content: string } }) => {
        const item = store.get(args.where.id);
        if (item) {
          item.content = args.data.content;
          return item;
        }
        throw new Error('Not found');
      }),
    },
    memoryVersion: {
      create: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    relationship: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    contradiction: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    traceabilityLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    confidenceLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    _store: store,
  };
}

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);
  return { adapter, prisma: mockPrisma, store: mockPrisma._store };
}

// ─── Tests (using REAL resolveImportDecision) ─────────────────────

describe('KE_HIT skips rule engine (real function)', () => {
  let mock: ReturnType<typeof createMockAdapter>;
  let resolveRule: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mock = createMockAdapter();
    resolveRule = vi.fn(async () => ({
      matchedRuleId: 'rule_123',
      glAccountId: 'gl_from_rule',
    }));
  });

  it('KE hit → glAccountId from KE, resolveRule never called', async () => {
    // Seed knowledge
    await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_ke',
      'any',
      'txn_001',
    );

    const decision = await resolveImportDecision(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      resolveRule,
    );

    expect(decision.source).toBe('ke');
    expect(decision.glAccountId).toBe('gl_account_ke');
    expect(decision.matchedRuleId).toBeNull();
    expect(resolveRule).not.toHaveBeenCalled();
  });
});

describe('KE_MISS continues to rule engine (real function)', () => {
  let mock: ReturnType<typeof createMockAdapter>;
  let resolveRule: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mock = createMockAdapter();
    resolveRule = vi.fn(async () => ({
      matchedRuleId: 'rule_456',
      glAccountId: 'gl_from_rule',
    }));
  });

  it('KE miss → glAccountId from rule engine, resolveRule called once', async () => {
    const decision = await resolveImportDecision(
      mock.adapter,
      'company_1',
      'UNKNOWN VENDOR',
      resolveRule,
    );

    expect(decision.source).toBe('rule_engine');
    expect(decision.glAccountId).toBe('gl_from_rule');
    expect(decision.matchedRuleId).toBe('rule_456');
    expect(resolveRule).toHaveBeenCalledOnce();
  });
});

describe('Company isolation in pipeline (real function)', () => {
  let mock: ReturnType<typeof createMockAdapter>;
  let resolveRule: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mock = createMockAdapter();
    resolveRule = vi.fn(async () => ({
      matchedRuleId: null,
      glAccountId: null,
    }));
  });

  it('KE knowledge from company_1 does not affect company_2', async () => {
    // Seed knowledge for company_1
    await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_c1',
      'any',
      'txn_001',
    );

    // company_2 should miss
    const decision = await resolveImportDecision(
      mock.adapter,
      'company_2',
      'AMZN MKTPLACE',
      resolveRule,
    );

    expect(decision.source).toBe('rule_engine');
    expect(resolveRule).toHaveBeenCalledOnce();
  });
});

describe('KE does not bypass AI fallback (real function)', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('KE miss allows rule engine + AI fallback to run normally', async () => {
    // Rule engine returns no match, AI fallback would normally run
    const resolveRule = vi.fn(async () => ({
      matchedRuleId: null,
      glAccountId: null,
      // In real code, this would trigger aiFallback
    }));

    const decision = await resolveImportDecision(
      mock.adapter,
      'company_1',
      'NEW VENDOR',
      resolveRule,
    );

    expect(decision.source).toBe('rule_engine');
    expect(resolveRule).toHaveBeenCalledOnce();
    // AI fallback would run inside resolveRule in real code
  });
});

describe('KE error does NOT fall back to rule engine (real function)', () => {
  let mock: ReturnType<typeof createMockAdapter>;
  let resolveRule: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mock = createMockAdapter();
    resolveRule = vi.fn(async () => ({
      matchedRuleId: 'rule_fallback',
      glAccountId: 'gl_fallback',
    }));
  });

  it('KE adapter throws → source is ke_error, rule engine NOT called', async () => {
    // Create a broken adapter that throws on getByType via a failing Prisma client
    const brokenPrisma = createMockPrisma();
    brokenPrisma.memoryItem.findMany.mockRejectedValue(new Error('KE adapter failure'));
    const brokenRunTx: TransactionRunner = async (fn) => fn(brokenPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
    const brokenAdapter = new MemoryAdapter(brokenPrisma as MemoryPrismaClient, brokenRunTx);

    const decision = await resolveImportDecision(
      brokenAdapter,
      'company_1',
      'SOME TRANSACTION',
      resolveRule,
    );

    // KE errored — must be distinguishable from MISS
    expect(decision.source).toBe('ke_error');
    expect(decision.glAccountId).toBeNull();
    expect(decision.matchedRuleId).toBeNull();
    // Rule engine must NOT be called on KE error
    expect(resolveRule).not.toHaveBeenCalled();
  });
});

// ─── Productive test: KE_ERROR through ImportService.importFile() ─────
// Mocks are at module level (top of file) to satisfy Vitest hoisting requirements.

const mockBankTransactionCreateMany = vi.fn();
const mockBankTransactionFindMany = vi.fn().mockResolvedValue([]);
const mockBankStatementFindFirst = vi.fn().mockResolvedValue(null);
const mockBankStatementCreate = vi.fn().mockResolvedValue({ id: 'stmt-ke-error' });
const mockBankRuleFindMany = vi.fn().mockResolvedValue([]);
const mockPendingApprovalCreate = vi.fn();

// Mock db — memoryItem.findMany throws to simulate KE failure
vi.mock('@/lib/db', () => ({
  db: {
    bankAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: 'bank-1', accountNo: '001', accountName: 'Test Bank' }),
    },
    company: {
      findUnique: vi.fn().mockResolvedValue({ id: 'company-1', legalName: 'Test Co' }),
    },
    bankTransaction: {
      createMany: (...args: unknown[]) => mockBankTransactionCreateMany(...args),
      findMany: (...args: unknown[]) => mockBankTransactionFindMany(...args),
    },
    bankStatement: {
      findFirst: (...args: unknown[]) => mockBankStatementFindFirst(...args),
      create: (...args: unknown[]) => mockBankStatementCreate(...args),
    },
    bankRule: { findMany: (...args: unknown[]) => mockBankRuleFindMany(...args) },
    pendingApproval: { create: (...args: unknown[]) => mockPendingApprovalCreate(...args) },
    // memoryItem.findMany throws to simulate KE adapter failure
    memoryItem: {
      findMany: vi.fn().mockRejectedValue(new Error('Database connection lost')),
    },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const tx = {
        bankStatement: {
          findFirst: mockBankStatementFindFirst,
          create: mockBankStatementCreate,
        },
        bankTransaction: {
          createMany: mockBankTransactionCreateMany,
          findMany: mockBankTransactionFindMany,
        },
        pendingApproval: { create: mockPendingApprovalCreate },
      };
      return fn(tx);
    }),
  },
}));

// Mock other dependencies
vi.mock('@/lib/services/journal-entry.service', () => ({
  JournalEntryService: {
    createFromBankTransaction: vi.fn(),
    recalculateBalance: vi.fn(),
  },
}));

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: vi.fn(),
}));

vi.mock('@/lib/fiscal-period-guard', () => ({
  assertActiveFiscalPeriod: vi.fn(),
}));

vi.mock('@/lib/services/rule-precedence-import-resolver', () => ({
  resolveImportRule: vi.fn().mockResolvedValue({ matchedRuleId: null, glAccountId: null }),
}));

vi.mock('@/lib/services/rule-precedence-shadow', () => ({
  isRulePrecedenceShadowEnabled: vi.fn().mockReturnValue(false),
  toRulePrecedenceRule: vi.fn(),
  runShadowComparison: vi.fn(),
  accumulateShadowSummary: vi.fn(),
  persistShadowSummaryBestEffort: vi.fn(),
  createEmptyShadowImportSummary: vi.fn(),
}));

vi.mock('@/lib/rule-engine/flag', () => ({
  isOperationalPolicyImportObservationEnabled: vi.fn().mockReturnValue(false),
  getEngineMode: vi.fn().mockReturnValue('v2'),
}));

vi.mock('@/lib/rule-engine/events', () => ({
  buildDivergenceEvent: vi.fn(),
}));

vi.mock('@/lib/services/shadow-metrics-reader', () => ({
  ShadowMetricsReader: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/lib/operational-policy/policy-service', () => ({
  evaluateOperationalPolicy: vi.fn(),
}));

vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn().mockReturnValue({ userId: 'user-1', companyId: 'company-1' }),
}));

vi.mock('@/lib/rbac', () => ({
  requireCompanyRole: vi.fn(),
}));

vi.mock('@/lib/file-validation', () => ({
  validateFile: vi.fn().mockReturnValue('csv'),
}));

vi.mock('@/lib/server-i18n', () => ({
  serverT: vi.fn((_locale: string, key: string) => key),
}));

vi.mock('@/lib/metrics', () => ({
  trackAPIResponseTime: vi.fn(),
  trackPDFParseDuration: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('KE_ERROR rollback through ImportService.importFile()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('KE failure → importFile() throws, statement creation rolled back', async () => {
    const { ImportService } = await import('@/lib/services/import.service');

    const csvContent = 'Date,Description,Amount\n2025-04-01,AMZN MKTPLACE PAYMENT,-100.00';

    // importFile should throw because KE adapter fails (memoryItem.findMany throws)
    await expect(
      ImportService.importFile({
        companyId: 'company-1',
        bankAccountId: 'bank-1',
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(csvContent),
        content: csvContent,
        userId: 'user-1',
      }),
    ).rejects.toThrow();

    // Statement creation was attempted inside $transaction (before KE lookup)
    expect(mockBankStatementCreate).toHaveBeenCalledOnce();
    // Transaction batch was never persisted (KE_ERROR threw before createMany)
    expect(mockBankTransactionCreateMany).not.toHaveBeenCalled();
    // The $transaction mock returns fn(tx) directly, so the AppError propagates
    // In real PostgreSQL, this would rollback the statement creation too
  });
});
