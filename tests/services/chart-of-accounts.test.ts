import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHART_OF_ACCOUNTS, seedChartOfAccounts } from '@/lib/chart-of-accounts';

const VALID_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const VALID_BALANCES = ['debit', 'credit'] as const;

describe('CHART_OF_ACCOUNTS structure', () => {
  it('has at least 40 accounts', () => {
    expect(CHART_OF_ACCOUNTS.length).toBeGreaterThanOrEqual(40);
  });

  it('all accounts have required fields', () => {
    for (const account of CHART_OF_ACCOUNTS) {
      expect(account.code).toBeDefined();
      expect(typeof account.code).toBe('string');
      expect(account.code.length).toBeGreaterThan(0);

      expect(account.name).toBeDefined();
      expect(typeof account.name).toBe('string');
      expect(account.name.length).toBeGreaterThan(0);

      expect(account.type).toBeDefined();
      expect(typeof account.type).toBe('string');

      expect(account.normalBalance).toBeDefined();
      expect(typeof account.normalBalance).toBe('string');
    }
  });

  it('all accounts have valid account types', () => {
    for (const account of CHART_OF_ACCOUNTS) {
      expect(VALID_TYPES).toContain(account.type);
    }
  });

  it('all accounts have valid normalBalance values', () => {
    for (const account of CHART_OF_ACCOUNTS) {
      expect(VALID_BALANCES).toContain(account.normalBalance);
    }
  });

  it('has no duplicate codes', () => {
    const codes = CHART_OF_ACCOUNTS.map((a) => a.code);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });

  it('all parentCodes reference an existing code', () => {
    const codes = new Set(CHART_OF_ACCOUNTS.map((a) => a.code));
    for (const account of CHART_OF_ACCOUNTS) {
      if (account.parentCode) {
        expect(codes.has(account.parentCode)).toBe(true);
      }
    }
  });

  it('all parentCodes are defined for non-top-level accounts', () => {
    // Top-level accounts (e.g., 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000)
    const topLevelCodes = ['1000', '2000', '3000', '4000', '5000', '6000', '7000', '8000'];
    for (const account of CHART_OF_ACCOUNTS) {
      if (topLevelCodes.includes(account.code)) {
        expect(account.parentCode).toBeUndefined();
      } else {
        expect(account.parentCode).toBeDefined();
      }
    }
  });

  it('has the expected top-level account types', () => {
    const topLevel = CHART_OF_ACCOUNTS.filter((a) => !a.parentCode);
    const expected = [
      { code: '1000', type: 'asset' },
      { code: '2000', type: 'liability' },
      { code: '3000', type: 'equity' },
      { code: '4000', type: 'revenue' },
      { code: '5000', type: 'expense' },
      { code: '6000', type: 'expense' },
      { code: '7000', type: 'expense' },
      { code: '8000', type: 'expense' },
    ];

    for (const exp of expected) {
      const account = CHART_OF_ACCOUNTS.find((a) => a.code === exp.code);
      expect(account).toBeDefined();
      expect(account!.type).toBe(exp.type);
    }
  });
});

describe('seedChartOfAccounts', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockTx: { glAccount: { create: ReturnType<typeof vi.fn> } };
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    mockCreate = vi.fn().mockImplementation(() => {
      idCounter++;
      return Promise.resolve({ id: `generated-id-${idCounter}` });
    });
    mockTx = { glAccount: { create: mockCreate } };
  });

  it('creates all accounts with correct data', async () => {
    await seedChartOfAccounts(mockTx as any, 'company-abc');

    expect(mockCreate).toHaveBeenCalledTimes(CHART_OF_ACCOUNTS.length);

    // First account call should have null parentId (top-level)
    const firstCall = mockCreate.mock.calls[0][0];
    expect(firstCall.data.companyId).toBe('company-abc');
    expect(firstCall.data.code).toBe('1000');
    expect(firstCall.data.parentId).toBeNull();
    expect(firstCall.data.isSystem).toBe(true);
    expect(firstCall.data.isActive).toBe(true);
  });

  it('links child accounts to parent accounts via parentId', async () => {
    await seedChartOfAccounts(mockTx as any, 'company-xyz');

    // Find the call for account 1010 (child of 1000)
    const call1010 = mockCreate.mock.calls.find(
      (call: any[]) => call[0].data.code === '1010',
    );
    expect(call1010).toBeDefined();
    // parentId should be the generated id of account 1000 (which was created first as id-1)
    expect(call1010[0].data.parentId).toBe('generated-id-1');
  });

  it('sets parentId to null for top-level accounts', async () => {
    await seedChartOfAccounts(mockTx as any, 'company-1');

    const topLevelCodes = ['1000', '2000', '3000', '4000', '5000', '6000', '7000', '8000'];
    for (const code of topLevelCodes) {
      const call = mockCreate.mock.calls.find(
        (c: any[]) => c[0].data.code === code,
      );
      expect(call).toBeDefined();
      expect(call[0].data.parentId).toBeNull();
    }
  });
});
