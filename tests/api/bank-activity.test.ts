import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  statements: vi.fn(),
  transactions: vi.fn(),
  count: vi.fn(),
  entitlement: vi.fn(),
  context: vi.fn()
}));
vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (req: NextRequest) => unknown) => handler
}));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: mocks.context
}));
vi.mock('@/lib/module-entitlement-guard', () => ({
  requireModuleEntitlement: mocks.entitlement
}));
vi.mock('@/lib/db', () => ({
  db: {
    bankAccount: {
      findMany: mocks.accounts
    },
    bankStatement: {
      findMany: mocks.statements
    },
    bankTransaction: {
      findMany: mocks.transactions,
      count: mocks.count
    }
  }
}));
import { GET } from '@/app/api/dashboard/bank-activity/route';
const account = {
  id: 'bank-a',
  accountName: 'Bank A',
  bankName: 'Bank A',
  currency: 'USD'
};
const statements = [{
  id: 's-a',
  startDate: new Date('2025-01-01Z'),
  endDate: new Date('2025-12-31Z'),
  openingBalance: 100,
  closingBalance: 105
}];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({
    userId: 'user-a',
    companyId: 'tenant-a'
  });
  mocks.entitlement.mockResolvedValue(undefined);
  mocks.accounts.mockResolvedValue([account]);
  mocks.statements.mockResolvedValue(statements);
  mocks.count.mockResolvedValue(1);
  mocks.transactions.mockResolvedValue([{
    id: 'tx-a',
    statementId: 's-a',
    date: new Date('2025-12-31Z'),
    description: 'Deposit',
    amount: 5,
    isReconciled: false,
    isIgnored: false,
    glAccount: null
  }]);
});
const request = (query = '') => GET(new NextRequest('http://localhost/api/dashboard/bank-activity' + query));
it('returns scoped bank facts independent of journals, pending reconciliation, or import year', async () => {
  const response = await request('?companyId=other-tenant');
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.year).toBe(2025);
  expect(data.total).toBe(1);
  expect(data.statements[0]).toEqual({
    id: 's-a',
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    openingBalance: 100,
    closingBalance: 105
  });
  expect(data.transactions[0]).toMatchObject({
    id: 'tx-a',
    statementId: 's-a',
    fecha: '2025-12-31',
    monto: 5,
    tipo: 'credito',
    conciliado: false,
    categoria: 'Sin asignar'
  });
  expect(mocks.entitlement).toHaveBeenCalledWith('accounting');
  expect(mocks.accounts.mock.calls[0][0].where).toEqual({
    companyId: 'tenant-a'
  });
  expect(mocks.statements.mock.calls[0][0].where).toMatchObject({
    bankAccountId: 'bank-a',
    bankAccount: {
      companyId: 'tenant-a'
    }
  });
  expect(mocks.transactions.mock.calls[0][0].where.statement).toMatchObject({
    bankAccountId: 'bank-a',
    bankAccount: {
      companyId: 'tenant-a'
    }
  });
});
it('rejects invalid years and foreign accounts without reading bank movements', async () => {
  expect((await request('?year=garbage')).status).toBe(400);
  expect((await request('?accountId=foreign')).status).toBe(404);
  expect(mocks.transactions).not.toHaveBeenCalled();
  expect(mocks.count).not.toHaveBeenCalled();
});
it('keeps bounded cursor pagination, full total and deterministic date/id ordering', async () => {
  const rows = Array.from({
    length: 501
  }, (_, i) => ({
    id: `tx-${i}`,
    statementId: 's-a',
    date: new Date('2025-01-02Z'),
    description: '',
    amount: -1,
    glAccount: null
  }));
  mocks.transactions.mockResolvedValue(rows);
  mocks.count.mockResolvedValue(650);
  const data = await (await request('?year=2025&cursor=tx-before')).json();
  expect(data.transactions).toHaveLength(500);
  expect(data.total).toBe(650);
  expect(data.hasMore).toBe(true);
  expect(data.nextCursor).toBe('tx-499');
  const query = mocks.transactions.mock.calls[0][0];
  expect(query.take).toBe(501);
  expect(query.cursor).toEqual({
    id: 'tx-before'
  });
  expect(query.skip).toBe(1);
  expect(query.orderBy).toEqual([{
    date: 'asc'
  }, {
    id: 'asc'
  }]);
  expect(query.where.date).toEqual({
    gte: new Date('2025-01-01Z'),
    lte: new Date('2025-12-31T23:59:59.999Z')
  });
});
it('requires company context and entitlement before all bank reads', async () => {
  mocks.entitlement.mockRejectedValueOnce(new Error('Forbidden'));
  await expect(request()).rejects.toThrow('Forbidden');
  expect(mocks.accounts).not.toHaveBeenCalled();
  expect(mocks.statements).not.toHaveBeenCalled();
  expect(mocks.transactions).not.toHaveBeenCalled();
});
