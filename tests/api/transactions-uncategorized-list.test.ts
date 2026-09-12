// TX-REVIEW-UI-001 — GET /api/transactions?classificationStatus=uncategorized
// T1 authentication required; T2 tenant isolation; T3 only glAccountId=null;
// T4 categorized excluded; T5 empty -> []; T6 minimal fields; T7 client
// companyId cannot change tenant.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const rows: Array<Record<string, unknown>> = [];

function createMockDb() {
  return {
    bankTransaction: {
      findMany: vi.fn(async (args: {
        where?: {
          glAccountId?: unknown;
          isReconciled?: boolean;
          statement?: { bankAccount?: { companyId?: string } };
        };
        orderBy?: unknown;
        select?: Record<string, unknown>;
      }) => {
        const where = args.where ?? {};
        if (where.statement?.bankAccount?.companyId) {
          const companyId = where.statement.bankAccount.companyId;
          const requireNullGl = where.glAccountId === null;
          return rows
            .filter((r) => r.companyId === companyId)
            .filter((r) => (requireNullGl ? r.glAccountId === null : true))
            .map((r) => ({
              id: r.id,
              date: r.date,
              description: r.description,
              amount: r.amount,
              glAccountId: r.glAccountId,
              statement: {
                bankAccount: {
                  id: `bank-${r.companyId}`,
                  accountName: `Bank ${r.companyId}`,
                },
              },
            }));
        }
        return [];
      }),
    },
  };
}

vi.mock('@/lib/db', () => ({ db: createMockDb() }));
vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (request: NextRequest) => Promise<Response>) => handler,
}));
const companyContext = { userId: 'user-1', companyId: 'company-a' };
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: vi.fn(() => companyContext),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '@/lib/db';
import { GET } from '@/app/api/transactions/route';

const mockDb = db as unknown as ReturnType<typeof createMockDb>;

function seed(row: Record<string, unknown>) {
  rows.push(row);
}

function buildResponse(tx: Record<string, unknown>) {
  return {
    id: tx.id as string,
    date: tx.date as string,
    description: tx.description as string,
    amount: tx.amount as number,
    direction: (tx.amount as number) >= 0 ? 'credit' : 'debit',
    glAccountId: tx.glAccountId as string | null,
    bankAccountId: `bank-${tx.companyId as string}`,
    bankAccountName: `Bank ${tx.companyId as string}`,
  };
}

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
});

function makeRequest(query = '') {
  return new NextRequest(`http://localhost/api/transactions${query}`);
}

describe('GET /api/transactions — uncategorized review queue (TX-REVIEW-UI-001)', () => {
  it('T1: unauthenticated request is rejected', async () => {
    const { requireCompanyContext } = await import('@/lib/context-storage');
    (requireCompanyContext as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('UNAUTHENTICATED');
    });
    await expect(GET(makeRequest('?classificationStatus=uncategorized'))).rejects.toThrow(
      'UNAUTHENTICATED',
    );
  });

  it('T2: tenant isolation — only the active company transactions are returned', async () => {
    seed({
      id: 'tx-a', companyId: 'company-a', date: '2026-01-01', description: 'A',
      amount: 100, glAccountId: null, isReconciled: false,
    });
    seed({
      id: 'tx-b', companyId: 'company-b', date: '2026-01-02', description: 'B',
      amount: 200, glAccountId: null, isReconciled: false,
    });
    const res = await GET(makeRequest('?classificationStatus=uncategorized'));
    const body = await res.json();
    expect(body.transactions.map((t: { id: string }) => t.id)).toEqual(['tx-a']);
  });

  it('T3: only glAccountId=null rows are requested from the store', async () => {
    seed({
      id: 'tx-a', companyId: 'company-a', date: '2026-01-01', description: 'A',
      amount: 100, glAccountId: null, isReconciled: false,
    });
    const res = await GET(makeRequest('?classificationStatus=uncategorized'));
    expect(res.status).toBe(200);
    const where = (mockDb.bankTransaction.findMany.mock.calls[0][0] as { where: { glAccountId: unknown } }).where;
    expect(where.glAccountId).toBeNull();
  });

  it('T4: categorized transactions are excluded from the response', async () => {
    seed({
      id: 'tx-a', companyId: 'company-a', date: '2026-01-01', description: 'A',
      amount: 100, glAccountId: null, isReconciled: false,
    });
    seed({
      id: 'tx-c', companyId: 'company-a', date: '2026-01-03', description: 'C',
      amount: 300, glAccountId: 'gl-1', isReconciled: false,
    });
    const res = await GET(makeRequest('?classificationStatus=uncategorized'));
    const body = await res.json();
    expect(body.transactions.map((t: { id: string }) => t.id)).toEqual(['tx-a']);
  });

  it('T5: empty queue returns []', async () => {
    const res = await GET(makeRequest('?classificationStatus=uncategorized'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.transactions).toEqual([]);
  });

  it('T6: minimal fields are returned with correct shape', async () => {
    seed({
      id: 'tx-a', companyId: 'company-a', date: '2026-01-01', description: 'A',
      amount: 100, glAccountId: null, isReconciled: false,
    });
    const res = await GET(makeRequest('?classificationStatus=uncategorized'));
    const body = await res.json();
    expect(body.transactions[0]).toMatchObject({
      id: 'tx-a',
      date: '2026-01-01',
      description: 'A',
      amount: 100,
      direction: 'credit',
      glAccountId: null,
    });
    expect(Object.keys(body.transactions[0]).sort()).toEqual(
      ['amount', 'bankAccountId', 'bankAccountName', 'date', 'description', 'direction', 'glAccountId', 'id'].sort(),
    );
  });

  it('T7: client-supplied companyId cannot change tenant scoping', async () => {
    seed({
      id: 'tx-b', companyId: 'company-b', date: '2026-01-02', description: 'B',
      amount: 200, glAccountId: null, isReconciled: false,
    });
    const res = await GET(makeRequest('?classificationStatus=uncategorized&companyId=company-b'));
    const body = await res.json();
    // company-a is the session company; company-b rows must never appear.
    expect(body.transactions).toEqual([]);
    const where = (mockDb.bankTransaction.findMany.mock.calls[0][0] as { where: { statement: { bankAccount: { companyId: string } } } }).where;
    expect(where.statement.bankAccount.companyId).toBe('company-a');
  });

  it('rejects classificationStatus values outside the queue scope', async () => {
    const res = await GET(makeRequest('?classificationStatus=all'));
    expect(res.status).toBe(400);
  });
});
