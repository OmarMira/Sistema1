import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEvaluate = vi.hoisted(() => ({ fn: vi.fn() }));
const mockImportAdapter = vi.hoisted(() => ({ fn: vi.fn() }));
const mockRunV2 = vi.hoisted(() => ({ fn: vi.fn() }));
const mockFindMatching = vi.hoisted(() => ({ fn: vi.fn() }));
const mockIsAdapter = vi.hoisted(() => ({ fn: vi.fn() }));
const mockIsV2 = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/lib/rule-engine/flag', () => ({
  isRuleEngineAdapterEnabled: mockIsAdapter.fn,
  isRuleEngineV2Enabled: mockIsV2.fn,
}));

vi.mock('@/lib/services/rule-precedence-engine', () => ({
  evaluateTransactionAgainstRules: mockEvaluate.fn,
}));

vi.mock('@/lib/services/rule-precedence-adapters', () => ({
  importAdapter: mockImportAdapter.fn,
}));

vi.mock('@/lib/services/rule-engine-adapter', () => ({
  runRuleEngineV2: mockRunV2.fn,
}));

vi.mock('@/lib/services/rule-matching-engine', () => ({
  findMatchingRule: mockFindMatching.fn,
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn() },
}));

import { resolveImportRule } from '@/lib/services/rule-precedence-import-resolver';
import type { RuleRecord } from '@/lib/services/rule-precedence-import-resolver';
import type { RuleMatchOutput } from '@/lib/services/rule-precedence-engine';

const RULES: RuleRecord[] = [
  {
    id: 'rule-1',
    name: 'Test Rule',
    companyId: 'c1',
    priority: 1,
    conditions: { description_contains: 'test' },
    conditionType: null,
    conditionValue: null,
    transactionDirection: null,
    glAccountId: 'gl-001',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  },
];

const TX_DATA = {
  id: 'tx-1',
  date: new Date('2026-07-18'),
  description: 'test transaction',
  amount: 100,
  bankAccountId: 'ba-1',
  reference: 'ref-123',
};

const COMPANY_ID = 'c1';

function engineMatch(overrides?: Partial<RuleMatchOutput>): RuleMatchOutput {
  return {
    winner: undefined,
    classification: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveImportRule', () => {
  describe('adapter path (RULE_ENGINE_ADAPTER_ENABLED = true)', () => {
    beforeEach(() => {
      mockIsAdapter.fn.mockReturnValue(true);
      mockIsV2.fn.mockReturnValue(false);
    });

    it('calls evaluateTransactionAgainstRules and importAdapter when adapter flag is on', async () => {
      const m = engineMatch({ winner: { ruleId: 'rule-1', ruleName: 'Test Rule' } });
      mockEvaluate.fn.mockResolvedValue(m);
      mockImportAdapter.fn.mockReturnValue({ matchedRuleId: 'rule-1', glAccountId: 'gl-001' });

      const result = await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(mockEvaluate.fn).toHaveBeenCalledTimes(1);
      expect(mockEvaluate.fn).toHaveBeenCalledWith(
        {
          id: TX_DATA.id,
          date: TX_DATA.date,
          description: TX_DATA.description,
          amount: TX_DATA.amount,
          bankAccountId: TX_DATA.bankAccountId,
        },
        expect.any(Array),
      );
      expect(mockImportAdapter.fn).toHaveBeenCalledTimes(1);
      expect(mockImportAdapter.fn).toHaveBeenCalledWith(m, expect.any(Array));
      expect(result).toEqual({ matchedRuleId: 'rule-1', glAccountId: 'gl-001' });
    });

    it('does NOT call V2 or legacy paths', async () => {
      mockEvaluate.fn.mockResolvedValue(engineMatch());
      mockImportAdapter.fn.mockReturnValue({ matchedRuleId: null, glAccountId: null });

      await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(mockRunV2.fn).not.toHaveBeenCalled();
      expect(mockFindMatching.fn).not.toHaveBeenCalled();
    });
  });

  describe('V2 path (RULE_ENGINE_V2_ENABLED = true)', () => {
    beforeEach(() => {
      mockIsAdapter.fn.mockReturnValue(false);
      mockIsV2.fn.mockReturnValue(true);
    });

    it('calls runRuleEngineV2 when V2 flag is on', async () => {
      mockRunV2.fn.mockResolvedValue({
        outcome: 'matched',
        matchedRuleId: 'rule-1',
        classification: { glAccountId: 'gl-001' },
      });

      const result = await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(mockRunV2.fn).toHaveBeenCalledTimes(1);
      expect(mockRunV2.fn).toHaveBeenCalledWith(
        {
          id: TX_DATA.id,
          date: TX_DATA.date,
          description: TX_DATA.description,
          amount: TX_DATA.amount,
          bankAccountId: TX_DATA.bankAccountId,
          reference: TX_DATA.reference,
        },
        expect.any(Array),
        { status: 'not_run' },
        COMPANY_ID,
      );
      expect(result).toEqual({ matchedRuleId: 'rule-1', glAccountId: 'gl-001' });
    });

    it('returns null/null when V2 outcome is pending with error', async () => {
      mockRunV2.fn.mockResolvedValue({
        outcome: 'pending',
        errorCode: 'engine_execution_error',
      });

      const result = await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(result).toEqual({ matchedRuleId: null, glAccountId: null });
    });

    it('does NOT call adapter or legacy paths', async () => {
      mockRunV2.fn.mockResolvedValue({ outcome: 'pending' });

      await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(mockEvaluate.fn).not.toHaveBeenCalled();
      expect(mockFindMatching.fn).not.toHaveBeenCalled();
    });

    it('passes reference to V2 engine', async () => {
      mockRunV2.fn.mockResolvedValue({
        outcome: 'matched',
        matchedRuleId: 'rule-1',
        classification: { glAccountId: 'gl-001' },
      });

      await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      const v2txnArg = mockRunV2.fn.mock.calls[0][0];
      expect(v2txnArg.reference).toBe('ref-123');
    });
  });

  describe('legacy path (both flags off)', () => {
    beforeEach(() => {
      mockIsAdapter.fn.mockReturnValue(false);
      mockIsV2.fn.mockReturnValue(false);
    });

    it('calls findMatchingRule when both flags are off', async () => {
      mockFindMatching.fn.mockResolvedValue({
        matchedRuleId: 'rule-1',
        glAccountId: 'gl-001',
      });

      const result = await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(mockFindMatching.fn).toHaveBeenCalledTimes(1);
      expect(mockFindMatching.fn).toHaveBeenCalledWith(
        { description: TX_DATA.description, amount: TX_DATA.amount },
        expect.any(Array),
        COMPANY_ID,
      );
      expect(result).toEqual({ matchedRuleId: 'rule-1', glAccountId: 'gl-001' });
    });

    it('does NOT call adapter or V2 paths', async () => {
      mockFindMatching.fn.mockResolvedValue({
        matchedRuleId: null,
        glAccountId: null,
      });

      await resolveImportRule(TX_DATA, RULES, COMPANY_ID);

      expect(mockEvaluate.fn).not.toHaveBeenCalled();
      expect(mockRunV2.fn).not.toHaveBeenCalled();
    });
  });
});
