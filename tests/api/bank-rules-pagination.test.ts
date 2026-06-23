import { describe, it, expect, vi } from 'vitest';
import { GET as bankRulesGET } from '../../src/app/api/bank-rules/route';
import { NextRequest } from 'next/server';

vi.mock('../../src/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-id-123'),
}));

vi.mock('../../src/lib/db', () => ({
  db: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-id-123', role: 'company_admin' }),
    },
    companyMember: {
      findUnique: vi.fn().mockResolvedValue({ id: 'member-123', userId: 'user-id-123', companyId: 'c123' }),
    },
    bankRule: {
      count: vi.fn().mockResolvedValue(5),
      findMany: vi.fn().mockImplementation(({ skip, take }) => {
        const mockRules = [
          { id: '1', companyId: 'c123', name: 'Rule 1', priority: 1, createdAt: new Date(), updatedAt: new Date(), _count: { transactions: 2 } },
          { id: '2', companyId: 'c123', name: 'Rule 2', priority: 2, createdAt: new Date(), updatedAt: new Date(), _count: { transactions: 0 } },
          { id: '3', companyId: 'c123', name: 'Rule 3', priority: 3, createdAt: new Date(), updatedAt: new Date(), _count: { transactions: 1 } },
          { id: '4', companyId: 'c123', name: 'Rule 4', priority: 4, createdAt: new Date(), updatedAt: new Date(), _count: { transactions: 5 } },
          { id: '5', companyId: 'c123', name: 'Rule 5', priority: 5, createdAt: new Date(), updatedAt: new Date(), _count: { transactions: 3 } },
        ];
        if (take !== undefined && skip !== undefined) {
          return Promise.resolve(mockRules.slice(skip, skip + take));
        }
        return Promise.resolve(mockRules);
      }),
    },
  },
}));

describe('GET /api/bank-rules Pagination', () => {
  it('should return all rules under data array if page/limit are NOT provided (backward-compatible)', async () => {
    const request = new NextRequest('http://localhost:3000/api/bank-rules?companyId=c123');
    const response = await bankRulesGET(request, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(5);
    expect(body.pagination).toBeUndefined();
    expect(body.data[0]._matchCount).toBe(2);
  });

  it('should return paginated rules with pagination metadata if page/limit are provided', async () => {
    const request = new NextRequest('http://localhost:3000/api/bank-rules?companyId=c123&page=2&limit=2');
    const response = await bankRulesGET(request, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe('3');
    expect(body.data[1].id).toBe('4');
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.total).toBe(5);
    expect(body.pagination.totalPages).toBe(3);
  });
});
