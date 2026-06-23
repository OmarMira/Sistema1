import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ----- MOCKS -----
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockGroupBy = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock('path', () => ({
  join: vi.fn((...args: string[]) => args.join('/').replace(/^\/?/, '')),
}));

vi.mock('@/lib/db', () => ({
  db: {
    journalLine: { groupBy: mockGroupBy },
    glAccount: { findMany: mockFindMany },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    slowQuery: vi.fn(),
  },
}));

// ----- HELPERS -----
import type { BudgetComparison } from '@/lib/budget/engine';

function makeAccount(overrides: Record<string, any> = {}): any {
  return {
    id: 'acc-default',
    code: '4000',
    name: 'Test Account',
    companyId: 'c1',
    isActive: true,
    normalBalance: 'debit',
    ...overrides,
  };
}

function makeGroupByResult(overrides: Record<string, any> = {}): any {
  return {
    glAccountId: 'acc-default',
    _sum: { debit: 0, credit: 0 },
    ...overrides,
  };
}

// ----- IMPORT (after mocks) -----
import { getVarianceReport } from '@/lib/budget/engine';

describe('getVarianceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseAccounts = [
    makeAccount({ id: 'acc-revenue', code: '4000', name: 'Ingresos', normalBalance: 'credit' }),
    makeAccount({ id: 'acc-expense', code: '5000', name: 'Gastos', normalBalance: 'debit' }),
    makeAccount({ id: 'acc-other', code: '6000', name: 'Otros', normalBalance: 'debit' }),
  ];

  it('should compute basic variance report', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      2025: {
        6: {
          '4000': 100000,
          '5000': 60000,
        },
      },
    }));

    mockGroupBy.mockResolvedValue([
      makeGroupByResult({
        glAccountId: 'acc-revenue',
        _sum: { debit: 0, credit: 120000 },
      }),
      makeGroupByResult({
        glAccountId: 'acc-expense',
        _sum: { debit: 55000, credit: 0 },
      }),
    ]);

    mockFindMany.mockResolvedValue(baseAccounts);

    const result = await getVarianceReport('c1', 2025, 6);

    // Revenue: budget=100000, actual=120000 (credit normal => c - d = 120000)
    // variance = 20000, variancePercent = (20000 / 100000)*100 = 20% => WARNING
    // Expense: budget=60000, actual=55000 (debit normal => d - c = 55000)
    // variance = -5000, variancePercent = (-5000 / 60000)*100 = -8.33% => OK (abs < 10)

    expect(result).toHaveLength(2);

    const revenue = result.find((r) => r.accountCode === '4000')!;
    expect(revenue.accountName).toBe('Ingresos');
    expect(revenue.budget).toBe(100000);
    expect(revenue.actual).toBe(120000);
    expect(revenue.variance).toBe(20000);
    expect(revenue.variancePercent).toBeCloseTo(20, 1);
    expect(revenue.status).toBe('WARNING');

    const expense = result.find((r) => r.accountCode === '5000')!;
    expect(expense.budget).toBe(60000);
    expect(expense.actual).toBe(55000);
    expect(expense.variance).toBe(-5000);
    expect(expense.variancePercent).toBeCloseTo(-8.33, 1);
    expect(expense.status).toBe('OK');
  });

  it('should return empty array when no accounts match budget codes', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      2025: { 6: { '9999': 1000 } },
    }));
    mockGroupBy.mockResolvedValue([]);
    mockFindMany.mockResolvedValue(baseAccounts);

    const result = await getVarianceReport('c1', 2025, 6);

    // Account code '9999' doesn't match any account in our mock -> filtered out by continue
    expect(result).toEqual([]);
  });

  it('should handle budget with no actuals (all zero)', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      2025: { 6: { '4000': 50000 } },
    }));
    mockGroupBy.mockResolvedValue([]); // no journal lines
    mockFindMany.mockResolvedValue(baseAccounts);

    const result = await getVarianceReport('c1', 2025, 6);

    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.accountCode).toBe('4000');
    expect(item.budget).toBe(50000);
    expect(item.actual).toBe(0);
    expect(item.variance).toBe(-50000);
    expect(item.variancePercent).toBeCloseTo(-100, 0);
    expect(item.status).toBe('CRITICAL'); // abs > 25
  });

  it('should handle actuals with no budget (budget amount 0)', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      2025: { 6: { '5000': 0 } }, // budget 0 for expense
    }));
    mockGroupBy.mockResolvedValue([
      makeGroupByResult({
        glAccountId: 'acc-expense',
        _sum: { debit: 30000, credit: 0 },
      }),
    ]);
    mockFindMany.mockResolvedValue(baseAccounts);

    const result = await getVarianceReport('c1', 2025, 6);

    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.budget).toBe(0);
    expect(item.actual).toBe(30000);
    // When budgetVal === 0, variancePercent is set to 100
    expect(item.variancePercent).toBe(100);
    expect(item.status).toBe('CRITICAL');
  });

  describe('variance percent thresholds', () => {
    it('should mark OK when abs(variancePercent) <= 10', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        2025: { 6: { '4000': 1000 } },
      }));
      mockGroupBy.mockResolvedValue([
        makeGroupByResult({
          glAccountId: 'acc-revenue',
          _sum: { debit: 0, credit: 1050 },
        }),
      ]);
      mockFindMany.mockResolvedValue(baseAccounts);

      const result = await getVarianceReport('c1', 2025, 6);
      // variance = 50, variancePercent = 5% => OK
      expect(result[0].variancePercent).toBe(5);
      expect(result[0].status).toBe('OK');
    });

    it('should mark WARNING when abs(variancePercent) is between 10 and 25', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        2025: { 6: { '4000': 1000 } },
      }));
      mockGroupBy.mockResolvedValue([
        makeGroupByResult({
          glAccountId: 'acc-revenue',
          _sum: { debit: 0, credit: 1200 },
        }),
      ]);
      mockFindMany.mockResolvedValue(baseAccounts);

      const result = await getVarianceReport('c1', 2025, 6);
      // variance = 200, variancePercent = 20% => WARNING
      expect(result[0].variancePercent).toBe(20);
      expect(result[0].status).toBe('WARNING');
    });

    it('should mark CRITICAL when abs(variancePercent) > 25', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        2025: { 6: { '4000': 1000 } },
      }));
      mockGroupBy.mockResolvedValue([
        makeGroupByResult({
          glAccountId: 'acc-revenue',
          _sum: { debit: 0, credit: 1400 },
        }),
      ]);
      mockFindMany.mockResolvedValue(baseAccounts);

      const result = await getVarianceReport('c1', 2025, 6);
      // variance = 400, variancePercent = 40% => CRITICAL
      expect(result[0].variancePercent).toBe(40);
      expect(result[0].status).toBe('CRITICAL');
    });

    it('should handle negative variance percent correctly', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        2025: { 6: { '4000': 1000 } },
      }));
      mockGroupBy.mockResolvedValue([
        makeGroupByResult({
          glAccountId: 'acc-revenue',
          _sum: { debit: 0, credit: 500 },
        }),
      ]);
      mockFindMany.mockResolvedValue(baseAccounts);

      const result = await getVarianceReport('c1', 2025, 6);
      // variance = -500, variancePercent = -50% => CRITICAL
      expect(result[0].variancePercent).toBe(-50);
      expect(result[0].status).toBe('CRITICAL');
    });
  });

  describe('sorting', () => {
    it('should sort results by abs(variancePercent) descending', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        2025: { 6: { '4000': 1000, '5000': 2000, '6000': 3000 } },
      }));
      mockGroupBy.mockResolvedValue([
        makeGroupByResult({
          glAccountId: 'acc-revenue',
          _sum: { debit: 0, credit: 500 },    // variance = -500, -50%
        }),
        makeGroupByResult({
          glAccountId: 'acc-expense',
          _sum: { debit: 1800, credit: 0 },   // variance = -200, -10%
        }),
        makeGroupByResult({
          glAccountId: 'acc-other',
          _sum: { debit: 5000, credit: 0 },   // variance = 2000, 66.67%
        }),
      ]);
      mockFindMany.mockResolvedValue(baseAccounts);

      const result = await getVarianceReport('c1', 2025, 6);

      expect(result).toHaveLength(3);
      // Sorted by abs(variancePercent) desc: 66.67 (6000), 50 (4000), 10 (5000)
      expect(result[0].accountCode).toBe('6000'); // 66.67%
      expect(result[1].accountCode).toBe('4000'); // 50%
      expect(result[2].accountCode).toBe('5000'); // 10%
    });
  });

  describe('DB interaction', () => {
    it('should query journalLine.groupBy with correct parameters', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ 2025: { 6: {} } }));
      mockGroupBy.mockResolvedValue([]);
      mockFindMany.mockResolvedValue([]);

      await getVarianceReport('c1', 2025, 6);

      expect(mockGroupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['glAccountId'],
          _sum: { debit: true, credit: true },
          where: expect.objectContaining({
            entry: expect.objectContaining({
              companyId: 'c1',
              status: 'posted',
            }),
          }),
        }),
      );
    });

    it('should query glAccount.findMany with correct parameters', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ 2025: { 6: {} } }));
      mockGroupBy.mockResolvedValue([]);
      mockFindMany.mockResolvedValue([]);

      await getVarianceReport('c1', 2025, 6);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { companyId: 'c1', isActive: true },
        select: { id: true, code: true, name: true, normalBalance: true },
      });
    });
  });
});
