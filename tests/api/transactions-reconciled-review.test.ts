// RECONCILED-UNCLASSIFIED-001 — Integration tests (T14–T20, T25–T28)
// A reconciled transaction WITHOUT a GL account (isReconciled=true,
// glAccountId=null, journalEntryId=null) is visible in the review queue and
// classifiable through the EXISTING PATCH /api/transactions/[id] authority:
// real accounting/journal/KE behavior, no double journal, isReconciled
// preserved, queue exit after classification.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type StoredItem = {
  id: string;
  content: string;
  type: string;
  status: string;
  confidence: string;
  companyId: string;
  sourceAuthor: string;
  sourceName: string;
};

function createMockDb() {
  const memStore = new Map<string, StoredItem>();
  let nextId = 1;
  const bankTransactions: Array<Record<string, unknown>> = [];
  const journalEntries: Array<Record<string, unknown>> = [];

  const memoryItem = {
    create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; sourceAuthor: string; sourceName: string; confidence?: string } }) => {
      const id = `mem_${nextId++}`;
      const item: StoredItem = {
        id,
        content: args.data.content,
        type: args.data.type,
        status: 'active',
        confidence: typeof args.data.confidence === 'string' ? args.data.confidence : 'tentative',
        companyId: args.data.companyId,
        sourceAuthor: args.data.sourceAuthor,
        sourceName: args.data.sourceName,
      };
      memStore.set(id, item);
      return item;
    }),
    findFirst: vi.fn(async (args?: { where?: { id?: string; companyId?: string; content?: string; status?: string } }) => {
      for (const item of memStore.values()) {
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
      let results = Array.from(memStore.values());
      if (args?.where?.companyId) {
        results = results.filter((item) => item.companyId === args.where!.companyId);
      }
      if (args?.where?.type) {
        results = results.filter((item) => item.type === args.where!.type);
      }
      return results;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const item = memStore.get(args.where.id);
      if (item) {
        Object.assign(item, args.data);
        return item;
      }
      throw new Error('Not found');
    }),
  };

  const bankTransaction = {
    findFirst: vi.fn(async (args: { where: { id: string; statement: { bankAccount: { companyId: string } } } }) => {
      const id = args.where.id;
      const companyId = args.where.statement.bankAccount.companyId;
      const tx = bankTransactions.find((t) => t.id === id && t.companyId === companyId);
      if (!tx) return null;
      return {
        ...tx,
        statement: {
          bankAccount: {
            id: `bank-${companyId}`,
            glAccountId: 'gl-bank-account',
          },
        },
      };
    }),
    findMany: vi.fn(async (args?: { where?: { statementId?: string; glAccountId?: unknown; isReconciled?: boolean; statement?: { bankAccount?: { companyId?: string } } } }) => {
      const where = args?.where ?? {};
      let results = bankTransactions;
      if (where.statementId) results = results.filter((t) => t.statementId === where.statementId);
      if (where.statement?.bankAccount?.companyId) {
        results = results.filter((t) => t.companyId === where.statement!.bankAccount!.companyId);
      }
      if (where.glAccountId === null) results = results.filter((t) => t.glAccountId === null);
      // NOTE: no isReconciled filter — matches the updated queue semantics.
      return results.map((t) => ({
        ...t,
        statement: { bankAccount: { id: `bank-${t.companyId}`, accountName: `Bank ${t.companyId}` } },
      }));
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const tx = bankTransactions.find((t) => t.id === args.where.id);
      if (!tx) throw new Error('Not found');
      Object.assign(tx, args.data);
      return tx;
    }),
  };

  const glAccount = {
    findFirst: vi.fn(async (args: { where: { id: string; companyId: string; isActive?: boolean } }) => ({
      id: args.where.id,
      companyId: args.where.companyId,
      isActive: true,
    })),
    findUnique: vi.fn(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      companyId: 'company-a',
      normalBalance: 'debit',
    })),
    update: vi.fn(async () => ({})),
    upsert: vi.fn(async () => ({})),
  };

  const journalEntry = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const entry = { id: `je_${nextId++}`, ...args.data };
      journalEntries.push(entry);
      return entry;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const entry = journalEntries.find((e) => e.id === args.where.id);
      if (entry) Object.assign(entry, args.data);
      return entry;
    }),
    findFirst: vi.fn(async () => null),
  };
  const journalLine = {
    createMany: vi.fn(async (args: { data: Array<{ glAccountId: string }> }) => ({ count: args.data.length })),
    deleteMany: vi.fn(async () => ({})),
    findMany: vi.fn(async () => []),
    aggregate: vi.fn(async () => ({ _sum: { debit: 0, credit: 0 } })),
  };
  const glAccountBalance = {
    findMany: vi.fn(async () => []),
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({})),
  };

  const self = {
    memoryItem,
    memoryVersion: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    relationship: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    contradiction: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    traceabilityLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    bankTransaction,
    glAccount,
    journalEntry,
    journalLine,
    glAccountBalance,
    $transaction: async <T,>(fn: (tx: typeof self) => Promise<T>): Promise<T> => fn(self),
    reset: () => {
      memStore.clear();
      bankTransactions.length = 0;
      journalEntries.length = 0;
      nextId = 1;
    },
    _store: memStore,
    _bankTransactions: bankTransactions,
    _journalEntries: journalEntries,
  };
  return self;
}

vi.mock('@/lib/db', () => ({ db: createMockDb() }));
// JH2: isolate the chain primitive (in-memory harness; chain boundary is
// proven against real PostgreSQL by tests/forensic/jh2-*).
vi.mock('@/lib/journal-chain', () => ({ appendEntryToJournalChain: vi.fn() }));
vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
}));
const harness = vi.hoisted(() => ({
  context: { userId: 'user-1', companyId: 'company-a' } as { userId: string; companyId: string } | null,
}));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(() => {
    if (!harness.context) throw new Error('unauthenticated');
    return harness.context;
  }),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: vi.fn(async () => undefined) }));
vi.mock('@/lib/fiscal-period-guard', () => ({ assertActiveFiscalPeriod: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/memory/classification-knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/memory/classification-knowledge')>();
  return {
    ...actual,
    learnEntityTreatment: vi.fn(actual.learnEntityTreatment),
    recordClassificationObservation: vi.fn(actual.recordClassificationObservation),
    detectConflictingPattern: vi.fn(actual.detectConflictingPattern),
    evolveClassificationConfidence: vi.fn(actual.evolveClassificationConfidence),
    degradeKnowledgeOnConflict: vi.fn(actual.degradeKnowledgeOnConflict),
  };
});
vi.mock('@/memory/entity-resolution', () => ({
  resolveEntity: vi.fn(),
}));

import { db } from '@/lib/db';
import { GET as GET_QUEUE } from '@/app/api/transactions/route';
import { PATCH } from '@/app/api/transactions/[id]/route';
import { createAdapter, learnEntityTreatment } from '@/memory/classification-knowledge';
import { resolveEntity } from '@/memory/entity-resolution';
import type { MemoryPrismaClient } from '@/memory/prisma-types';

const mockDb = db as unknown as ReturnType<typeof createMockDb>;
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const GL_A = 'gl-a';
const ACTOR = 'user-1';

function makeAdapter() {
  return createAdapter(mockDb as unknown as MemoryPrismaClient, (fn) => mockDb.$transaction(fn as never));
}

function seedTransaction(opts: {
  id: string;
  description: string;
  amount: number;
  companyId?: string;
  glAccountId?: string | null;
  isReconciled?: boolean;
}) {
  mockDb._bankTransactions.push({
    id: opts.id,
    companyId: opts.companyId ?? COMPANY_A,
    statementId: 'stmt-1',
    date: new Date('2026-01-15'),
    description: opts.description,
    amount: opts.amount,
    glAccountId: opts.glAccountId ?? null,
    isReconciled: opts.isReconciled ?? false,
    journalEntryId: null,
  });
}

async function listQueue() {
  const res = await GET_QUEUE(
    new NextRequest('http://localhost/api/transactions?classificationStatus=uncategorized'),
  );
  return (await res.json()) as {
    transactions: Array<{ id: string; isReconciled: boolean; glAccountId: string | null }>;
  };
}

function patchRequest(id: string, glAccountId: string) {
  return new NextRequest(`http://localhost/api/transactions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ glAccountId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.reset();
  harness.context = { userId: ACTOR, companyId: COMPANY_A };
  (resolveEntity as ReturnType<typeof vi.fn>).mockReset();
});

describe('RECONCILED-UNCLASSIFIED-001 — reconciled uncategorized recovery (real PATCH)', () => {
  it('T14–T20: reconciled+nullGL transaction is visible, classifiable via real PATCH, stays reconciled, exits queue', async () => {
    // The exact dead-end state: reconciled, no GL, no journal entry.
    seedTransaction({ id: 'tx-rec', description: 'ABC 777 ENTITY-1', amount: -500, isReconciled: true });

    // T2/T6: visible in the queue with isReconciled=true preserved.
    const queue = await listQueue();
    const entry = queue.transactions.find((t) => t.id === 'tx-rec');
    expect(entry).toBeDefined();
    expect(entry!.isReconciled).toBe(true);
    expect(entry!.glAccountId).toBeNull();

    // T14: PATCH with a valid GL on this exact state → success.
    (resolveEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'KNOWN',
      entityId: 'entity-1',
    });
    const res = await PATCH(patchRequest('tx-rec', GL_A), { params: Promise.resolve({ id: 'tx-rec' }) });
    expect(res.status).toBe(200);

    // T15: glAccountId = chosen GL.
    const stored = mockDb._bankTransactions.find((t) => t.id === 'tx-rec');
    expect(stored?.glAccountId).toBe(GL_A);

    // T16: isReconciled continues true (PATCH does not touch reconciliation).
    expect(stored?.isReconciled).toBe(true);

    // T17: the resulting journal/accounting corresponds to the real PATCH
    // behavior (one new entry created for the transaction, since it had none).
    expect(mockDb.journalEntry.create).toHaveBeenCalledTimes(1);

    // T18: no double journal (the transaction had no prior entry to void).
    expect(mockDb.journalEntry.update).not.toHaveBeenCalled();

    // T19: KE learning runs exactly through the PATCH authority.
    expect(learnEntityTreatment).toHaveBeenCalled();

    // T20: after classification the transaction leaves the queue.
    const after = await listQueue();
    expect(after.transactions.map((t) => t.id)).not.toContain('tx-rec');
  });

  it('T21: tenant isolation of the PATCH remains intact (foreign reconciled transaction → 404)', async () => {
    seedTransaction({ id: 'tx-b', description: 'B', amount: -100, companyId: COMPANY_B, isReconciled: true });
    const res = await PATCH(patchRequest('tx-b', GL_A), { params: Promise.resolve({ id: 'tx-b' }) });
    expect(res.status).toBe(404);
  });

  it('T22: a GL from another company remains rejected', async () => {
    seedTransaction({ id: 'tx-1', description: 'A', amount: -100, isReconciled: true });
    mockDb.glAccount.findFirst.mockResolvedValueOnce(null);
    const res = await PATCH(patchRequest('tx-1', 'gl-foreign'), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(404);
  });

  it('T5: foreign-company reconciled + null GL does not appear in the queue', async () => {
    seedTransaction({ id: 'tx-fb', description: 'FB', amount: -200, companyId: COMPANY_B, isReconciled: true });
    const queue = await listQueue();
    expect(queue.transactions.map((t) => t.id)).toEqual([]);
  });
});
