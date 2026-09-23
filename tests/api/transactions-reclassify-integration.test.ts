// TX-RECLASSIFY-UI-001 — Integration tests (T24–T36)
// Real PATCH /api/transactions/[id] re-classification of a CATEGORIZED
// transaction: void of the previous journal entry, re-post to the new GL,
// balance handling, and KE learning — all per the EXISTING published contract.
// Plus protection of the published TX-REVIEW-UI-001 uncategorized queue.

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
  const companyKnowledgeRows: Array<Record<string, unknown>> = [];
  const memoryVersions: Array<Record<string, unknown>> = [];

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
      if (where.isReconciled === false) results = results.filter((t) => t.isReconciled === false);
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
    createMany: vi.fn(async (args: { data: Array<{ glAccountId: string; debit: unknown; credit: unknown }> }) => ({
      count: args.data.length,
    })),
    deleteMany: vi.fn(async () => ({})),
    findMany: vi.fn(async (args?: { where?: { entryId?: string } }) => {
      // Return lines only for non-voided entries (voided entries have no active lines).
      const activeEntries = new Set(journalEntries.filter((e) => e.status !== 'void').map((e) => e.id));
      if (args?.where?.entryId) {
        return activeEntries.has(args.where.entryId)
          ? [{ glAccountId: 'gl-a', debit: 500, credit: 0 }]
          : [];
      }
      return [];
    }),
    aggregate: vi.fn(async () => ({ _sum: { debit: 0, credit: 0 } })),
  };
  const glAccountBalance = {
    findMany: vi.fn(async () => []),
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({})),
  };

  // CompanyKnowledge — in-memory store for resolveEntity + confirmEntityIdentity.
  // findMany tolerates `select` by returning full rows; create fills defaults
  // so toCompanyKnowledgeRecord(row) always finds relationship/mergedIntoId/dates.
  const companyKnowledge = {
    findMany: vi.fn(async (args?: { where?: { companyId?: string; status?: string } }) => {
      let results = companyKnowledgeRows;
      if (args?.where?.companyId) {
        results = results.filter((r) => r.companyId === args.where!.companyId);
      }
      if (args?.where?.status) {
        results = results.filter((r) => r.status === args.where!.status);
      }
      return results.map((r) => ({ ...r }));
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row = {
        id: `ck_${nextId++}`,
        relationship: null,
        mergedIntoId: null,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      };
      companyKnowledgeRows.push(row);
      return { ...row };
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = companyKnowledgeRows.find((r) => r.id === args.where.id);
      if (!row) throw new Error('CompanyKnowledge not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const row = companyKnowledgeRows.find((r) => r.id === args.where.id);
      return row ? { ...row } : null;
    }),
    count: vi.fn(async (args?: { where?: { companyId?: string; status?: string } }) => {
      let results = companyKnowledgeRows;
      if (args?.where?.companyId) {
        results = results.filter((r) => r.companyId === args.where!.companyId);
      }
      if (args?.where?.status) {
        results = results.filter((r) => r.status === args.where!.status);
      }
      return results.length;
    }),
  };

  const knowledgeAudit = {
    create: vi.fn(async (args?: { data?: Record<string, unknown> }) => ({
      id: `ka_${nextId++}`,
      ...(args?.data ?? {}),
    })),
    findMany: vi.fn(async () => []),
  };

  // memoryVersion — track rows so repo.update can compute the next
  // versionNumber (orderBy versionNumber desc) and tests can assert
  // version increases on treatment updates.
  const memoryVersion = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const row = { id: `mv_${nextId++}`, ...args.data };
      memoryVersions.push(row);
      return row;
    }),
    findFirst: vi.fn(async (args?: { where?: { itemId?: string } }) => {
      const rows = args?.where?.itemId
        ? memoryVersions.filter((v) => v.itemId === args.where!.itemId)
        : memoryVersions;
      if (rows.length === 0) return null;
      return rows.reduce((max, r) =>
        (r.versionNumber as number) > (max.versionNumber as number) ? r : max,
      );
    }),
    findMany: vi.fn(async () => [...memoryVersions]),
  };

  const self = {
    memoryItem,
    memoryVersion,
    relationship: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    contradiction: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    traceabilityLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    companyKnowledge,
    knowledgeAudit,
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
      companyKnowledgeRows.length = 0;
      memoryVersions.length = 0;
      nextId = 1;
    },
    _store: memStore,
    _bankTransactions: bankTransactions,
    _journalEntries: journalEntries,
    _companyKnowledge: companyKnowledgeRows,
    _memoryVersions: memoryVersions,
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
  requireCurrentUserId: () => 'user-1',
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
// Actual-passthrough: the REAL resolveEntity (alias matching) runs against the
// in-memory companyKnowledge store. Existing tests can still mockResolvedValue
// to force KNOWN/UNKNOWN; Vitest 4 mockReset restores vi.fn(impl) → impl, so
// after beforeEach's mockReset the original implementation is available again.
vi.mock('@/memory/entity-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/memory/entity-resolution')>();
  return {
    ...actual,
    resolveEntity: vi.fn(actual.resolveEntity),
  };
});

import { db } from '@/lib/db';
import { GET as GET_QUEUE } from '@/app/api/transactions/route';
import { PATCH, GET } from '@/app/api/transactions/[id]/route';
import { createAdapter, learnEntityTreatment, lookupTreatment } from '@/memory/classification-knowledge';
import { resolveEntity } from '@/memory/entity-resolution';
import type { MemoryPrismaClient } from '@/memory/prisma-types';

const mockDb = db as unknown as ReturnType<typeof createMockDb>;
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const GL_A = 'gl-a';
const GL_B = 'gl-b';
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
  withJournal?: boolean;
}) {
  const tx: Record<string, unknown> = {
    id: opts.id,
    companyId: opts.companyId ?? COMPANY_A,
    statementId: 'stmt-1',
    date: new Date('2026-01-15'),
    description: opts.description,
    amount: opts.amount,
    glAccountId: opts.glAccountId ?? null,
    isReconciled: false,
    journalEntryId: null,
  };
  mockDb._bankTransactions.push(tx);
  if (opts.withJournal) {
    const entry = {
      id: `je_${opts.id}`,
      transactionId: opts.id,
      status: 'posted',
      companyId: tx.companyId,
    };
    mockDb._journalEntries.push(entry);
    tx.journalEntryId = entry.id;
  }
  return tx;
}

async function listQueue() {
  const res = await GET_QUEUE(
    new NextRequest('http://localhost/api/transactions?classificationStatus=uncategorized'),
  );
  return (await res.json()) as { transactions: Array<{ id: string }> };
}

function patchRequest(id: string, glAccountId: string, extra: Record<string, unknown> = {}) {
  return new NextRequest(`http://localhost/api/transactions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ glAccountId, ...extra }),
  });
}

function getRequest(id: string) {
  return new NextRequest(`http://localhost/api/transactions/${id}`, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.reset();
  harness.context = { userId: ACTOR, companyId: COMPANY_A };
  (resolveEntity as ReturnType<typeof vi.fn>).mockReset();
});

describe('TX-RECLASSIFY-UI-001 — real PATCH re-classification wiring (T24–T33)', () => {
  it('T24–T30: categorized transaction re-classified via the REAL PATCH — old entry voided, new GL reflected', async () => {
    // T24: transaction initially categorized in GL-A with an active journal
    // entry for GL-A (T25).
    seedTransaction({ id: 'tx-1', description: 'ABC 777 ENTITY-1', amount: -500, glAccountId: GL_A, withJournal: true });
    (resolveEntity as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'UNKNOWN' });

    // T26: human correction via the EXISTING PATCH changes to GL-B.
    const res = await PATCH(patchRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(200);

    // T30: bankTransaction.glAccountId reflects GL-B.
    const stored = mockDb._bankTransactions.find((t) => t.id === 'tx-1');
    expect(stored?.glAccountId).toBe(GL_B);

    // T27: the previous journal entry was voided per existing semantics
    // (PATCH :227-230 sets status 'void' when a journalEntryId exists).
    expect(mockDb.journalEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: `je_tx-1` },
        data: { status: 'void' },
      }),
    );

    // T28: a new posting was created and its lines correspond to GL-B per the
    // real JournalEntryService contract (negative amount → counterparty GL is
    // the DEBIT side: journal-entry.service.ts:40-41, :53-54).
    expect(mockDb.journalEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'posted',
          lines: {
            create: expect.arrayContaining([
              expect.objectContaining({ glAccountId: GL_B, debit: 500, credit: 0 }),
              expect.objectContaining({ glAccountId: 'gl-bank-account', debit: 0, credit: 500 }),
            ]),
          },
        }),
      }),
    );

    // T29: balance recalculation wiring — the real JournalEntryService
    // recalculates BOTH affected GL accounts (journal-entry.service.ts:70-71,
    // :86 glAccount.findUnique per account). The old GL-A and the new GL-B
    // must both have been recalculated.
    expect(mockDb.glAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: GL_B } }),
    );
    expect(mockDb.glAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: GL_A } }),
    );
  });

  it('T31+T32: existing learning receives the human correction (KNOWN entity)', async () => {
    seedTransaction({ id: 'tx-1', description: 'ABC 777 ENTITY-1', amount: -500, glAccountId: GL_A, withJournal: true });
    (resolveEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'KNOWN',
      entityId: 'entity-1',
    });

    const res = await PATCH(patchRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(200);
    expect(learnEntityTreatment).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_A,
      'entity-1',
      GL_B,
      'any',
      'user_correction',
      'tx-1',
    );

    // T32: resulting knowledge/confidence follows the existing policy — the
    // real learnEntityTreatment wrote a classification item with the new GL.
    const adapter = makeAdapter();
    const items = await adapter.getByType(COMPANY_A, 'classification');
    const learned = items.find((i) => {
      try {
        const parsed = JSON.parse(i.content) as { entityId?: string; glAccountId?: string };
        return parsed.entityId === 'entity-1' && parsed.glAccountId === GL_B;
      } catch {
        return false;
      }
    });
    expect(learned).toBeDefined();
  });

  it('T33: a subsequent equivalent occurrence can leverage the corrected knowledge via existing KE behavior', async () => {
    seedTransaction({ id: 'tx-1', description: 'ABC 777 ENTITY-1', amount: -500, glAccountId: GL_A, withJournal: true });
    (resolveEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'KNOWN',
      entityId: 'entity-1',
    });
    const first = await PATCH(patchRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(first.status).toBe(200);

    // Second equivalent occurrence: the KE store holds the corrected treatment
    // and lookupTreatment (existing behavior) can serve it.
    const adapter = makeAdapter();
    const { lookupTreatment } = await import('@/memory/classification-knowledge');
    const lookup = await lookupTreatment(adapter, COMPANY_A, 'entity-1');
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.glAccountId).toBe(GL_B);
    }
  });

  it('T22: cross-tenant transaction cannot be re-classified (404, no leak)', async () => {
    seedTransaction({ id: 'tx-b', description: 'B', amount: -100, companyId: COMPANY_B, glAccountId: GL_A, withJournal: true });
    const res = await PATCH(patchRequest('tx-b', GL_B), { params: Promise.resolve({ id: 'tx-b' }) });
    expect(res.status).toBe(404);
  });

  it('T23: cross-tenant GL cannot be used (PATCH validates GL ownership, 404)', async () => {
    seedTransaction({ id: 'tx-1', description: 'A', amount: -100, glAccountId: GL_A, withJournal: true });
    // glAccount.findFirst is company-scoped; simulate a foreign GL by returning null.
    mockDb.glAccount.findFirst.mockResolvedValueOnce(null);
    const res = await PATCH(patchRequest('tx-1', 'gl-foreign'), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(404);
  });
});

describe('TX-RECLASSIFY-UI-001 — TX-REVIEW-UI-001 queue protection (T34–T36)', () => {
  it('T34: glAccountId=null transactions still appear in the review queue', async () => {
    seedTransaction({ id: 'tx-null', description: 'Uncategorized', amount: -100 });
    const body = await listQueue();
    expect(body.transactions.map((t) => t.id)).toContain('tx-null');
  });

  it('T35: glAccountId!=null transactions remain excluded from that queue', async () => {
    seedTransaction({ id: 'tx-cat', description: 'Categorized', amount: -100, glAccountId: GL_A });
    const body = await listQueue();
    expect(body.transactions.map((t) => t.id)).not.toContain('tx-cat');
  });
});

// ─── S10/PASO 1A — identity confirmation closes the learning loop ──────────
// GL-only reclassification NEVER auto-creates identity; explicit
// confirmedEntity persists CompanyKnowledge + treatment + observation so a
// second occurrence X' resolves KNOWN and reuses the learned GL.

describe('S10/PASO 1A — explicit identity confirmation closes the learning loop', () => {
  const DESCRIPTION = 'ACME INV 2026-001';

  function confirmRequest(id: string, glAccountId: string) {
    return patchRequest(id, glAccountId, {
      confirmedEntity: { canonicalName: 'ACME Corp', entityType: 'company' },
    });
  }

  it('1. GL-only negative: UNKNOWN + no confirmedEntity → no companyKnowledge, no learning', async () => {
    // Real resolveEntity (actual-passthrough after mockReset) against the
    // empty store → UNKNOWN → learning skipped, identity never created.
    seedTransaction({ id: 'tx-1', description: DESCRIPTION, amount: -100, glAccountId: GL_A, withJournal: true });

    const res = await PATCH(patchRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(200);

    expect(mockDb._companyKnowledge).toHaveLength(0);
    expect(learnEntityTreatment).not.toHaveBeenCalled();

    // Normal accounting success stands.
    const body = (await res.json()) as { transaction: { glAccountId: string } };
    expect(body.transaction.glAccountId).toBe(GL_B);
  });

  it('1b. GL-only PATCH after reset never creates companyKnowledge for a no-match description', async () => {
    seedTransaction({ id: 'tx-1', description: 'NEVER SEEN DESCRIPTION', amount: -50, glAccountId: GL_A });
    const res = await PATCH(patchRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(200);
    expect(mockDb._companyKnowledge).toHaveLength(0);
  });

  it('2. UNKNOWN + confirmedEntity → identity learned, treatment + observation persisted, NO_CONFLICT', async () => {
    // first_appearance_unknown → identity_confirmed → company_knowledge_created
    seedTransaction({ id: 'tx-1', description: DESCRIPTION, amount: -100, glAccountId: GL_A, withJournal: true });

    const res = await PATCH(confirmRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    // detectConflictingPattern → NO_CONFLICT → 200 (never 409).
    expect(res.status).toBe(200);

    // companyKnowledge created under the transaction's companyId with the
    // observed description registered as an alias.
    expect(mockDb._companyKnowledge).toHaveLength(1);
    const knowledge = mockDb._companyKnowledge[0];
    expect(knowledge.companyId).toBe(COMPANY_A);
    expect(knowledge.canonicalName).toBe('ACME Corp');
    expect(knowledge.status).toBe('active');
    expect(knowledge.aliases as string[]).toContain(DESCRIPTION);
    const entityId = knowledge.id as string;
    expect(entityId).toBeTruthy();

    // Treatment learned for the new knowledge id and promoted to certain.
    const adapter = makeAdapter();
    const lookup = await lookupTreatment(adapter, COMPANY_A, entityId);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.glAccountId).toBe(GL_B);
      expect(lookup.confidence).toBe('certain');
    }

    // Classification memoryItem carries entityId + glAccountId.
    const classItems = await adapter.getByType(COMPANY_A, 'classification');
    const learned = classItems.find((i) => {
      try {
        const parsed = JSON.parse(i.content) as { entityId?: string; glAccountId?: string };
        return parsed.entityId === entityId && parsed.glAccountId === GL_B;
      } catch {
        return false;
      }
    });
    expect(learned).toBeDefined();

    // Observation recorded.
    const observations = await adapter.getByType(COMPANY_A, 'classification_observation');
    expect(observations.length).toBeGreaterThanOrEqual(1);
    const obs = observations.map((o) => {
      try {
        return JSON.parse(o.content) as { entityId?: string; originalDescription?: string };
      } catch {
        return {};
      }
    });
    expect(obs.some((o) => o.entityId === entityId && o.originalDescription === DESCRIPTION)).toBe(true);

    // NO_CONFLICT: no conflicting-pattern artifact was persisted.
    const conflicts = await adapter.getByType(COMPANY_A, 'classification_conflicting_pattern');
    expect(conflicts).toHaveLength(0);

    // Audit entry written by confirmEntityIdentity.
    expect(mockDb.knowledgeAudit.create).toHaveBeenCalled();
  });

  it('3. Second-appearance loop: X\' resolves KNOWN and reuses the learned GL (first_appearance_unknown → explicit_correction_recorded → identity_confirmed → company_knowledge_created → knowledge_reused)', async () => {
    seedTransaction({ id: 'tx-1', description: DESCRIPTION, amount: -100, glAccountId: GL_A, withJournal: true });
    const first = await PATCH(confirmRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(first.status).toBe(200);
    const entityId = mockDb._companyKnowledge[0].id as string;

    // knowledge_reused: real resolveEntity now returns KNOWN for X'.
    const resolution = await resolveEntity(COMPANY_A, DESCRIPTION);
    expect(resolution.status).toBe('KNOWN');
    if (resolution.status === 'KNOWN') {
      expect(resolution.entityId).toBe(entityId);
    }

    const adapter = makeAdapter();
    const lookup = await lookupTreatment(adapter, COMPANY_A, entityId);
    expect(lookup.status).toBe('FOUND');
    if (lookup.status === 'FOUND') {
      expect(lookup.glAccountId).toBe(GL_B);
    }

    // Second occurrence X' — PATCH WITHOUT confirmedEntity goes down the
    // KNOWN learning path with the existing entityId (no human identity
    // decision needed).
    (learnEntityTreatment as ReturnType<typeof vi.fn>).mockClear();
    seedTransaction({ id: 'tx-2', description: DESCRIPTION, amount: -80, glAccountId: null });
    const second = await PATCH(patchRequest('tx-2', GL_B), { params: Promise.resolve({ id: 'tx-2' }) });
    expect(second.status).toBe(200);
    expect(learnEntityTreatment).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_A,
      entityId,
      GL_B,
      'any',
      'user_correction',
      'tx-2',
    );
    // Still exactly one identity — the loop reused it, never duplicated it.
    expect(mockDb._companyKnowledge).toHaveLength(1);
  });

  it('5. Company isolation: company A confirmation invisible to company B', async () => {
    seedTransaction({ id: 'tx-1', description: DESCRIPTION, amount: -100, glAccountId: GL_A, withJournal: true });
    const res = await PATCH(confirmRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(res.status).toBe(200);
    const entityId = mockDb._companyKnowledge[0].id as string;

    // resolveEntity under company B → UNKNOWN (tenant-scoped store read).
    const foreign = await resolveEntity(COMPANY_B, DESCRIPTION);
    expect(foreign.status).toBe('UNKNOWN');

    // Treatment lookup under company B for that entityId → NOT_FOUND.
    const adapter = makeAdapter();
    const lookup = await lookupTreatment(adapter, COMPANY_B, entityId);
    expect(lookup.status).toBe('NOT_FOUND');

    // Company B data untouched: no knowledge rows, no memory items.
    expect(mockDb._companyKnowledge.filter((r) => r.companyId === COMPANY_B)).toHaveLength(0);
    const bItems = await adapter.getByType(COMPANY_B, 'classification');
    expect(bItems).toHaveLength(0);
  });

  it('6. Later GL correction: single active treatment, memoryVersion write, confidence intact', async () => {
    seedTransaction({ id: 'tx-1', description: DESCRIPTION, amount: -100, glAccountId: GL_A, withJournal: true });
    const first = await PATCH(confirmRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(first.status).toBe(200);
    const entityId = mockDb._companyKnowledge[0].id as string;

    const adapter = makeAdapter();
    const before = await lookupTreatment(adapter, COMPANY_A, entityId);
    expect(before.status).toBe('FOUND');
    const itemId = before.status === 'FOUND' ? before.memoryItemId : '';
    const versionsBefore = mockDb._memoryVersions.filter((v) => v.itemId === itemId);
    const maxVersionBefore = Math.max(...versionsBefore.map((v) => v.versionNumber as number));

    // Same entity, now KNOWN — different GL, no confirmedEntity needed.
    const second = await PATCH(patchRequest('tx-1', 'gl-c'), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(second.status).toBe(200);

    // EXACTLY ONE active classification item for the entityId (the write path
    // UPDATED the existing item — no parallel contradictory knowledge).
    const classItems = await adapter.getByType(COMPANY_A, 'classification');
    const forEntity = classItems.filter((i) => {
      if (i.status !== 'active') return false;
      try {
        return (JSON.parse(i.content) as { entityId?: string }).entityId === entityId;
      } catch {
        return false;
      }
    });
    expect(forEntity).toHaveLength(1);

    // memoryVersion versioning write occurred (C4/C5 update path).
    const versionsAfter = mockDb._memoryVersions.filter((v) => v.itemId === itemId);
    const maxVersionAfter = Math.max(...versionsAfter.map((v) => v.versionNumber as number));
    expect(maxVersionAfter).toBeGreaterThan(maxVersionBefore);
    expect(mockDb.memoryVersion.create).toHaveBeenCalled();

    // Confidence handling: still a single FOUND treatment with the new GL,
    // promoted to certain by the existing human-confirmation path.
    const after = await lookupTreatment(adapter, COMPANY_A, entityId);
    expect(after.status).toBe('FOUND');
    if (after.status === 'FOUND') {
      expect(after.glAccountId).toBe('gl-c');
      expect(after.confidence).toBe('certain');
    }
  });

  it('7. GET status endpoint: UNKNOWN before confirmation, KNOWN after', async () => {
    seedTransaction({ id: 'tx-1', description: DESCRIPTION, amount: -100, glAccountId: GL_A, withJournal: true });

    const before = await GET(getRequest('tx-1'), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      entityStatus: string;
      transaction: { id: string; description: string };
    };
    expect(beforeBody.entityStatus).toBe('UNKNOWN');
    expect(beforeBody.transaction).toEqual({ id: 'tx-1', description: DESCRIPTION });

    const patch = await PATCH(confirmRequest('tx-1', GL_B), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(patch.status).toBe(200);

    const after = await GET(getRequest('tx-1'), { params: Promise.resolve({ id: 'tx-1' }) });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { entityStatus: string; entityId?: string };
    expect(afterBody.entityStatus).toBe('KNOWN');
    expect(afterBody.entityId).toBe(mockDb._companyKnowledge[0].id);
  });
});
