import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEvaluate = vi.hoisted(() => ({ fn: vi.fn() }));
const mockApplyAllAdapter = vi.hoisted(() => ({ fn: vi.fn() }));
const mockTransactionMatchesRule = vi.hoisted(() => ({ fn: vi.fn() }));
const mockEvaluateWinningRule = vi.hoisted(() => ({ fn: vi.fn() }));
const mockIsAdapter = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/lib/rule-engine/flag', () => ({
  isRuleEngineAdapterEnabled: mockIsAdapter.fn,
}));

vi.mock('@/lib/services/rule-precedence-engine', () => ({
  evaluateTransactionAgainstRules: mockEvaluate.fn,
}));

vi.mock('@/lib/services/rule-precedence-adapters', () => ({
  applyAllAdapter: mockApplyAllAdapter.fn,
}));

vi.mock('@/lib/services/rule-matching-engine', () => ({
  transactionMatchesRule: mockTransactionMatchesRule.fn,
  evaluateWinningRule: mockEvaluateWinningRule.fn,
}));

import { resolveApplyAllRule } from '@/lib/services/rule-precedence-apply-all-resolver';
import type { RuleRecord } from '@/lib/services/rule-precedence-import-resolver';

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
  {
    id: 'rule-2',
    name: 'Second Rule',
    companyId: 'c1',
    priority: 2,
    conditions: { description_contains: 'other' },
    conditionType: null,
    conditionValue: null,
    transactionDirection: null,
    glAccountId: 'gl-002',
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

const LEGACY_CTX = {
  knownSocioPatterns: ['socio-pattern'],
  entityFirstMode: true,
  rolePriorities: { CLIENTE: 1, PROVEEDOR: 2 },
  entityContexts: [{ pattern: 'test', role: 'CLIENTE' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveApplyAllRule', () => {
  describe('adapter path (flag ON)', () => {
    beforeEach(() => {
      mockIsAdapter.fn.mockReturnValue(true);
    });

    it('calls evaluateTransactionAgainstRules and applyAllAdapter', async () => {
      const engineMatch = { winner: { ruleId: 'rule-1', ruleName: 'Test Rule' } };
      mockEvaluate.fn.mockResolvedValue(engineMatch);
      mockApplyAllAdapter.fn.mockReturnValue({
        matchedRuleId: 'rule-1',
        resolvedRule: {
          id: 'rule-1',
          name: 'Test Rule',
          priority: 1,
          glAccountId: 'gl-001',
          debitGlAccountId: null,
          creditGlAccountId: null,
        },
      });

      const result = await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      expect(mockEvaluate.fn).toHaveBeenCalledTimes(1);
      expect(mockApplyAllAdapter.fn).toHaveBeenCalledTimes(1);
      expect(mockApplyAllAdapter.fn).toHaveBeenCalledWith(engineMatch, expect.any(Array));
      expect(result.matchedRuleId).toBe('rule-1');
      expect(result.resolvedRule?.id).toBe('rule-1');
    });

    it('does NOT call legacy path functions', async () => {
      mockEvaluate.fn.mockResolvedValue({ winner: undefined });
      mockApplyAllAdapter.fn.mockReturnValue({ matchedRuleId: null, resolvedRule: null });

      await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      expect(mockTransactionMatchesRule.fn).not.toHaveBeenCalled();
      expect(mockEvaluateWinningRule.fn).not.toHaveBeenCalled();
    });
  });

  describe('legacy path (flag OFF)', () => {
    beforeEach(() => {
      mockIsAdapter.fn.mockReturnValue(false);
    });

    it('calls transactionMatchesRule with legacy context parameters', async () => {
      mockTransactionMatchesRule.fn.mockReturnValue(false);

      await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      // Should be called for each rule
      expect(mockTransactionMatchesRule.fn).toHaveBeenCalledTimes(2);
      // Called with transaction, rule, knownSocioPatterns, entityFirstMode
      const callArgs = mockTransactionMatchesRule.fn.mock.calls[0];
      expect(callArgs[1]).toBeDefined();
      expect(callArgs[2]).toEqual(LEGACY_CTX.knownSocioPatterns);
      expect(callArgs[3]).toBe(LEGACY_CTX.entityFirstMode);
    });

    it('calls evaluateWinningRule with matching rules and entityContexts', async () => {
      mockTransactionMatchesRule.fn.mockReturnValue(true);
      mockEvaluateWinningRule.fn.mockReturnValue(RULES[0]);

      await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      expect(mockEvaluateWinningRule.fn).toHaveBeenCalledTimes(1);
      const callArgs = mockEvaluateWinningRule.fn.mock.calls[0];
      expect(callArgs[0]).toHaveLength(2); // both rules matched
      expect(callArgs[1]).toEqual({ description: TX_DATA.description, amount: TX_DATA.amount });
      expect(callArgs[2]).toBe(COMPANY_ID);
      expect(callArgs[3]).toEqual(LEGACY_CTX.rolePriorities);
      expect(callArgs[4]).toEqual(LEGACY_CTX.entityContexts);
    });

    it('returns ApplyAllRuleResolution with winner data', async () => {
      mockTransactionMatchesRule.fn.mockReturnValue(true);
      mockEvaluateWinningRule.fn.mockReturnValue({
        id: 'rule-1',
        name: 'Test Rule',
        priority: 1,
        glAccountId: 'gl-001',
        debitGlAccountId: null,
        creditGlAccountId: null,
      });

      const result = await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      expect(result.matchedRuleId).toBe('rule-1');
      expect(result.resolvedRule).toEqual({
        id: 'rule-1',
        name: 'Test Rule',
        priority: 1,
        glAccountId: 'gl-001',
        debitGlAccountId: null,
        creditGlAccountId: null,
      });
    });

    it('returns resolvedRule: null when no rules match', async () => {
      mockTransactionMatchesRule.fn.mockReturnValue(false);

      const result = await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      expect(result.matchedRuleId).toBeNull();
      expect(result.resolvedRule).toBeNull();
    });

    it('does NOT call adapter path functions', async () => {
      mockTransactionMatchesRule.fn.mockReturnValue(false);

      await resolveApplyAllRule(TX_DATA, RULES, COMPANY_ID, LEGACY_CTX);

      expect(mockEvaluate.fn).not.toHaveBeenCalled();
      expect(mockApplyAllAdapter.fn).not.toHaveBeenCalled();
    });
  });
});
