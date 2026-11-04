import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// S6: budgets must be company-scoped. Legacy flat entries ({ "<year>": { "<month>": {...} } })
// are unscoped data and must never be attributed to any company.
// The engine is exercised through its public entry point with the DB mocked, while the
// budgets file is a real file inside an isolated system temp directory.

const mockGroupBy = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: {
    journalLine: { groupBy: mockGroupBy },
    glAccount: { findMany: mockFindMany },
  },
}));

import { getVarianceReport } from '@/lib/budget/engine';

const scratchDir = mkdtempSync(join(tmpdir(), 'budget-scoping-'));

afterAll(() => {
  delete process.env.BUDGETS_FILE_PATH;
  rmSync(scratchDir, { recursive: true, force: true });
});

let fileCounter = 0;

function writeBudgets(content: unknown): string {
  const filePath = join(scratchDir, `budgets-${++fileCounter}.json`);
  writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  process.env.BUDGETS_FILE_PATH = filePath;
  return filePath;
}

function makeAccount(id: string, code: string, name: string, normalBalance: 'debit' | 'credit') {
  return { id, code, name, normalBalance };
}

const accountsByCompany: Record<string, ReturnType<typeof makeAccount>[]> = {
  'company-a': [
    makeAccount('a-4000', '4000', 'Ingresos A', 'credit'),
    makeAccount('a-4100', '4100', 'Ingresos secundarios A', 'credit'),
  ],
  'company-b': [
    makeAccount('b-4000', '4000', 'Ingresos B', 'credit'),
    makeAccount('b-4100', '4100', 'Ingresos secundarios B', 'credit'),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BUDGETS_FILE_PATH;
  mockFindMany.mockImplementation(async (args: { where: { companyId: string } }) =>
    accountsByCompany[args.where.companyId] ?? [],
  );
});

describe('budget company scoping (S6)', () => {
  it('does not let company A budget drive company B variance', async () => {
    writeBudgets({
      companies: {
        'company-a': { 2025: { 6: { '4000': 100000, '4100': 50000 } } },
      },
    });

    mockGroupBy.mockImplementation(async (args: { where: { entry: { companyId: string } } }) => {
      if (args.where.entry.companyId === 'company-a') {
        return [{ glAccountId: 'a-4000', _sum: { debit: 0, credit: 120000 } }];
      }
      return [{ glAccountId: 'b-4000', _sum: { debit: 0, credit: 50000 } }];
    });

    const companyA = await getVarianceReport('company-a', 2025, 6);
    const companyB = await getVarianceReport('company-b', 2025, 6);

    const aRow = companyA.find((r) => r.accountCode === '4000');
    expect(aRow?.budget).toBe(100000);
    expect(aRow?.actual).toBe(120000);
    expect(aRow?.variancePercent).toBe(20);
    expect(aRow?.status).toBe('WARNING');

    const aBudgetOnly = companyA.find((r) => r.accountCode === '4100');
    expect(aBudgetOnly?.budget).toBe(50000);
    expect(aBudgetOnly?.actual).toBe(0);

    // Company B shares the same account codes but has no budget of its own.
    const bRow = companyB.find((r) => r.accountCode === '4000');
    expect(bRow?.budget).toBe(0);
    expect(bRow?.actual).toBe(50000);
    expect(bRow?.variance).toBe(50000);
    expect(bRow?.variancePercent).toBe(100);
    expect(bRow?.status).toBe('CRITICAL');

    // A budget-only account of company A must not create a row for company B.
    expect(companyB.map((r) => r.accountCode)).not.toContain('4100');
  });

  it('does not attribute legacy unscoped entries to any company', async () => {
    writeBudgets({ 2025: { 6: { '4000': 50000 } } });

    mockGroupBy.mockImplementation(async (args: { where: { entry: { companyId: string } } }) => {
      if (args.where.entry.companyId === 'company-a') {
        return [{ glAccountId: 'a-4000', _sum: { debit: 0, credit: 120000 } }];
      }
      return [{ glAccountId: 'b-4000', _sum: { debit: 0, credit: 50000 } }];
    });

    const companyA = await getVarianceReport('company-a', 2025, 6);
    const companyB = await getVarianceReport('company-b', 2025, 6);

    expect(companyA).toHaveLength(1);
    expect(companyB).toHaveLength(1);
    expect(companyA[0].budget).toBe(0);
    expect(companyB[0].budget).toBe(0);
    expect(companyA[0].actual).toBe(120000);
    expect(companyB[0].actual).toBe(50000);
  });

  it('returns empty results for companies when the file only holds legacy data', async () => {
    writeBudgets({ 2025: { 6: { '4000': 50000 } } });
    mockGroupBy.mockResolvedValue([]);

    const report = await getVarianceReport('company-a', 2025, 6);

    expect(report).toEqual([]);
  });

  it('ignores legacy data even when it is under an explicit legacy section', async () => {
    writeBudgets({ legacy: { 2025: { 6: { '4000': 50000 } } } });
    mockGroupBy.mockResolvedValue([]);

    await expect(getVarianceReport('company-a', 2025, 6)).resolves.toEqual([]);
  });

  it('keeps company sections isolated from the legacy section', async () => {
    writeBudgets({
      companies: { 'company-a': { 2025: { 6: { '4000': 100000 } } } },
      legacy: { 2025: { 6: { '4000': 999999, '4100': 888888 } } },
    });
    mockGroupBy.mockImplementation(async (args: { where: { entry: { companyId: string } } }) => {
      if (args.where.entry.companyId === 'company-a') {
        return [{ glAccountId: 'a-4000', _sum: { debit: 0, credit: 100000 } }];
      }
      return [];
    });

    const companyA = await getVarianceReport('company-a', 2025, 6);
    const companyB = await getVarianceReport('company-b', 2025, 6);

    expect(companyA.map((r) => r.accountCode)).toEqual(['4000']);
    expect(companyA[0].budget).toBe(100000);
    expect(companyB).toEqual([]);
  });

  it('returns empty results without throwing when the budgets file is missing', async () => {
    process.env.BUDGETS_FILE_PATH = join(scratchDir, 'no-such-budgets-file.json');
    mockGroupBy.mockResolvedValue([]);

    await expect(getVarianceReport('company-a', 2025, 6)).resolves.toEqual([]);
  });

  it('returns empty results without throwing when the budgets file is malformed', async () => {
    const filePath = join(scratchDir, 'malformed-budgets.json');
    writeFileSync(filePath, '{not valid json', 'utf-8');
    process.env.BUDGETS_FILE_PATH = filePath;
    mockGroupBy.mockResolvedValue([]);

    await expect(getVarianceReport('company-a', 2025, 6)).resolves.toEqual([]);
  });
});
