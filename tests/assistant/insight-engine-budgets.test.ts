import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// S6 follow-up (T12): the insight engine's budget alerts must read the company-scoped
// budget file through the budget engine. Legacy flat data ({ "<year>": { "<month>": ... } })
// is unscoped and must never produce an alert for any company.
// The DB is mocked; the budgets file is a real file inside an isolated system temp directory.

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  journalLineFindMany: vi.fn(),
  bankAccountFindFirst: vi.fn(),
  bankStatementFindFirst: vi.fn(),
  bankTransactionCount: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    bankAccount: { findFirst: mocks.bankAccountFindFirst },
    bankStatement: { findFirst: mocks.bankStatementFindFirst },
    journalLine: { findMany: mocks.journalLineFindMany, aggregate: mocks.aggregate },
    bankTransaction: { count: mocks.bankTransactionCount },
  },
}));

import { generateInsights } from '@/lib/assistant/insight-engine';

const scratchDir = mkdtempSync(join(tmpdir(), 'insight-budgets-'));

// Same UTC period the engine derives for its budget alerts.
const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1;

afterAll(() => {
  delete process.env.BUDGETS_FILE_PATH;
  rmSync(scratchDir, { recursive: true, force: true });
});

let fileCounter = 0;

function writeBudgets(content: unknown): void {
  const filePath = join(scratchDir, `budgets-${++fileCounter}.json`);
  writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  process.env.BUDGETS_FILE_PATH = filePath;
}

function setActuals(value: number): void {
  mocks.aggregate.mockResolvedValue({ _sum: { debit: value, credit: 0 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BUDGETS_FILE_PATH;
  mocks.bankAccountFindFirst.mockResolvedValue(null);
  mocks.bankStatementFindFirst.mockResolvedValue(null);
  mocks.journalLineFindMany.mockResolvedValue([]);
  mocks.bankTransactionCount.mockResolvedValue(0);
  mocks.aggregate.mockResolvedValue({ _sum: { debit: 0, credit: 0 } });
});

describe('insight engine budget alerts are company-scoped (T12)', () => {
  it('fires an alert from the caller company’s own budget', async () => {
    writeBudgets({ companies: { 'company-a': { [year]: { [month]: { '5000': 1000 } } } } });
    setActuals(2000);

    const insights = await generateInsights('company-a');
    const alerts = insights.filter((i) => i.type === 'budget_alert');

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe('budget_5000');
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].context).toMatchObject({ code: '5000', budget: 1000, actual: 2000 });
    expect(mocks.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entry: expect.objectContaining({ companyId: 'company-a' }),
          glAccount: { code: '5000' },
        }),
      }),
    );
  });

  it('does not fire from another company’s budget', async () => {
    writeBudgets({ companies: { 'company-a': { [year]: { [month]: { '5000': 1000 } } } } });
    setActuals(2000);

    const insights = await generateInsights('company-b');

    expect(insights.filter((i) => i.type === 'budget_alert')).toEqual([]);
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it('uses only the caller company’s section when several companies have budgets', async () => {
    writeBudgets({
      companies: {
        'company-a': { [year]: { [month]: { '5000': 1000 } } },
        'company-b': { [year]: { [month]: { '5100': 500 } } },
      },
    });
    setActuals(9000);

    const companyB = (await generateInsights('company-b')).filter((i) => i.type === 'budget_alert');
    expect(companyB.map((i) => i.context?.code)).toEqual(['5100']);

    const companyA = (await generateInsights('company-a')).filter((i) => i.type === 'budget_alert');
    expect(companyA.map((i) => i.context?.code)).toEqual(['5000']);
  });

  it('produces no alert from legacy flat unscoped data', async () => {
    writeBudgets({ [year]: { [month]: { '5000': 1000 } } });
    setActuals(2000);

    const insights = await generateInsights('company-a');

    expect(insights.filter((i) => i.type === 'budget_alert')).toEqual([]);
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it('still returns the executive summary when no budget file is available', async () => {
    process.env.BUDGETS_FILE_PATH = join(scratchDir, 'missing-budgets.json');

    const insights = await generateInsights('company-a');

    expect(insights.filter((i) => i.type === 'budget_alert')).toEqual([]);
    expect(insights.find((i) => i.id === 'exec_summary')).toBeDefined();
  });
});
