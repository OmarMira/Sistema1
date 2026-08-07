import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-1'));
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindFirst = vi.hoisted(() => vi.fn());
const mockDbJournalFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDbBankTxFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDbBankTxCount = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const mockDbBankTxAggregate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    _sum: { amount: 0 },
    _avg: { amount: 0 },
    _min: { amount: 0 },
    _max: { amount: 0 },
  }),
);
const mockDbSystemMemoryFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDbSystemMemoryUpdateMany = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: mockGetSessionUserId }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/ai-config', () => ({
  getAiConfig: vi.fn().mockResolvedValue({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://api.test.openrouter.ai/v1',
  }),
  clearAiConfigCache: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    companyMember: { findFirst: mockDbCompanyMemberFindFirst },
    journalEntry: { findMany: mockDbJournalFindMany },
    bankTransaction: {
      findMany: mockDbBankTxFindMany,
      count: mockDbBankTxCount,
      aggregate: mockDbBankTxAggregate,
    },
    systemMemory: {
      findMany: mockDbSystemMemoryFindMany,
      updateMany: mockDbSystemMemoryUpdateMany,
    },
  },
}));

import { POST } from '@/app/api/ai-assistant/route';

type Where = { date?: { gte?: Date; lte?: Date } };

function makeToolResponse(toolName: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

const FINAL_REPLY = { choices: [{ message: { role: 'assistant', content: 'Hecho' } }] };

async function runTool(toolName: string, args: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify(makeToolResponse(toolName, args)), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(FINAL_REPLY), { status: 200 }));

  const req = new NextRequest('http://localhost/api/ai-assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'consulta', companyId: 'c1' }),
  });

  const res = await POST(req, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}

function journalWhere(): Where {
  return mockDbJournalFindMany.mock.calls.at(-1)?.[0].where as Where;
}

function bankTxWhere(): Where {
  return mockDbBankTxFindMany.mock.calls.at(-1)?.[0].where as Where;
}

function statsWhere(): Where {
  return mockDbBankTxCount.mock.calls.at(-1)?.[0].where as Where;
}

describe('POST /api/ai-assistant — D6 date filter boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-1');
    mockCheckRateLimit.mockReturnValue({ allowed: true, limit: 100, remaining: 99, resetAt: Math.ceil(Date.now() / 1000) + 60 });
    mockDbCompanyMemberFindFirst.mockResolvedValue({ id: 'member-1', companyId: 'c1', userId: 'user-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('get_journal_entries', () => {
    it('includes the full end day (lte = T23:59:59.999Z)', async () => {
      const { status } = await runTool('get_journal_entries', { startDate: '2025-06-01', endDate: '2025-06-30' });
      expect(status).toBe(200);
      const where = journalWhere();
      expect(where!.date!.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(where!.date!.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });

    it('excludes next-day midnight', async () => {
      await runTool('get_journal_entries', { startDate: '2025-06-01', endDate: '2025-06-30' });
      expect(new Date('2025-07-01T00:00:00.000Z').getTime()).toBeGreaterThan(journalWhere()!.date!.lte!.getTime());
    });

    it('only endDate sent: no implicit lower bound', async () => {
      await runTool('get_journal_entries', { endDate: '2025-06-30' });
      const date = journalWhere()!.date!;
      expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
      expect(date.gte).toBeUndefined();
    });

    it('only startDate sent: no implicit upper bound', async () => {
      await runTool('get_journal_entries', { startDate: '2025-06-01' });
      const date = journalWhere()!.date!;
      expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(date.lte).toBeUndefined();
    });

    it('both sent: both bounds applied', async () => {
      await runTool('get_journal_entries', { startDate: '2025-06-01', endDate: '2025-06-30' });
      const date = journalWhere()!.date!;
      expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });

    it('neither sent: no date filter', async () => {
      await runTool('get_journal_entries', {});
      expect(journalWhere()!.date).toBeUndefined();
    });
  });

  describe('get_bank_transactions', () => {
    it('includes the full end day (lte = T23:59:59.999Z)', async () => {
      const { status } = await runTool('get_bank_transactions', { startDate: '2025-06-01', endDate: '2025-06-30' });
      expect(status).toBe(200);
      const where = bankTxWhere();
      expect(where!.date!.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(where!.date!.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });

    it('excludes next-day midnight', async () => {
      await runTool('get_bank_transactions', { startDate: '2025-06-01', endDate: '2025-06-30' });
      expect(new Date('2025-07-01T00:00:00.000Z').getTime()).toBeGreaterThan(bankTxWhere()!.date!.lte!.getTime());
    });

    it('only endDate sent: no implicit lower bound', async () => {
      await runTool('get_bank_transactions', { endDate: '2025-06-30' });
      const date = bankTxWhere()!.date!;
      expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
      expect(date.gte).toBeUndefined();
    });

    it('only startDate sent: no implicit upper bound', async () => {
      await runTool('get_bank_transactions', { startDate: '2025-06-01' });
      const date = bankTxWhere()!.date!;
      expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(date.lte).toBeUndefined();
    });

    it('both sent: both bounds applied', async () => {
      await runTool('get_bank_transactions', { startDate: '2025-06-01', endDate: '2025-06-30' });
      const date = bankTxWhere()!.date!;
      expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });

    it('neither sent: no date filter', async () => {
      await runTool('get_bank_transactions', {});
      expect(bankTxWhere()!.date).toBeUndefined();
    });
  });

  describe('get_transaction_stats', () => {
    it('includes the full end day (lte = T23:59:59.999Z)', async () => {
      const { status } = await runTool('get_transaction_stats', { startDate: '2025-06-01', endDate: '2025-06-30' });
      expect(status).toBe(200);
      const where = statsWhere();
      expect(where!.date!.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(where!.date!.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });

    it('excludes next-day midnight', async () => {
      await runTool('get_transaction_stats', { startDate: '2025-06-01', endDate: '2025-06-30' });
      expect(new Date('2025-07-01T00:00:00.000Z').getTime()).toBeGreaterThan(statsWhere()!.date!.lte!.getTime());
    });

    it('only endDate sent: no implicit lower bound', async () => {
      await runTool('get_transaction_stats', { endDate: '2025-06-30' });
      const date = statsWhere()!.date!;
      expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
      expect(date.gte).toBeUndefined();
    });

    it('only startDate sent: no implicit upper bound', async () => {
      await runTool('get_transaction_stats', { startDate: '2025-06-01' });
      const date = statsWhere()!.date!;
      expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(date.lte).toBeUndefined();
    });

    it('both sent: both bounds applied', async () => {
      await runTool('get_transaction_stats', { startDate: '2025-06-01', endDate: '2025-06-30' });
      const date = statsWhere()!.date!;
      expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
      expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });

    it('neither sent: no date filter', async () => {
      await runTool('get_transaction_stats', {});
      expect(statsWhere()!.date).toBeUndefined();
    });
  });
});