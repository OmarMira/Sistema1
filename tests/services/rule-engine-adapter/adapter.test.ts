import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EngineDecision, EntityResolution } from '@/lib/rule-engine/types'

const mockEvaluateRules = vi.fn()

vi.mock('@/lib/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
}))

import { runRuleEngineV2 } from '@/lib/services/rule-engine-adapter'
import type { ParsedTransaction, PrismaBankRule, MatchResult } from '@/lib/services/rule-engine-adapter'

function makeTxn(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    id: 'txn-1',
    date: new Date('2026-07-14'),
    description: 'Test transaction',
    amount: -500,
    bankAccountId: 'acct-001',
    ...overrides,
  }
}

function makeRule(overrides: Partial<PrismaBankRule> = {}): PrismaBankRule {
  return {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditions: [{ field: 'description', operator: 'contains', value: 'test' }],
    glAccountId: 'gl-001',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    ...overrides,
  }
}

const defaultEntityResolution: EntityResolution = { status: 'not_run' }

function makeEngineDecision(overrides: Partial<EngineDecision> = {}): EngineDecision {
  return {
    type: 'rule',
    result: 'winner',
    ruleId: 'rule-1',
    candidateList: [],
    classification: { glAccountId: 'gl-001' },
    explanation: 'matched by rule-1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runRuleEngineV2', () => {
  describe('outcome: matched', () => {
    it('returns matched when engine returns winner with glAccountId', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision(),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

      expect(result.outcome).toBe('matched')
      if (result.outcome === 'matched') {
        expect(result.classification.glAccountId).toBe('gl-001')
        expect(result.matchedRuleId).toBe('rule-1')
      }
    })

    it('includes entityId and category from classification', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision({
            classification: { glAccountId: 'gl-001', entityId: 'ent-1', category: 'income' },
          }),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('matched')
      if (result.outcome === 'matched') {
        expect(result.classification.entityId).toBe('ent-1')
        expect(result.classification.category).toBe('income')
      }
    })
  })

  describe('outcome: pending', () => {
    it('returns pending when engine returns winner without glAccountId', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision({ classification: {} }),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
    })

    it('returns pending when engine returns ambiguous', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision({ result: 'ambiguous', ruleId: undefined, classification: undefined }),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
    })

    it('returns pending when engine returns no_match', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision({ result: 'no_match', ruleId: undefined, classification: undefined }),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
    })

    it('returns pending when engine output has no decision', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: undefined },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
    })

    it('returns pending with engine_execution_error when engine throws', async () => {
      mockEvaluateRules.mockImplementationOnce(() => { throw new Error('engine failure') })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
      if (result.outcome === 'pending') {
        expect(result.errorCode).toBe('engine_execution_error')
      }
    })

    it('returns pending with conditions_normalization_failed when rule has corrupt conditions', async () => {
      const corruptRule = makeRule({ conditions: 'not-an-array' })

      const result = await runRuleEngineV2(makeTxn(), [corruptRule], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
      if (result.outcome === 'pending') {
        expect(result.errorCode).toBe('conditions_normalization_failed')
      }
    })

    it('returns pending when winner has glAccountId but no ruleId', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision({ ruleId: undefined, classification: { glAccountId: 'gl-001' } }),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
    })

    it('preserves classification on pending when winner has no glAccountId', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: {
          candidates: [],
          decision: makeEngineDecision({
            classification: { entityId: 'ent-1', category: 'expense' },
          }),
        },
      })

      const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(result.outcome).toBe('pending')
      if (result.outcome === 'pending') {
        expect(result.classification?.entityId).toBe('ent-1')
        expect(result.classification?.category).toBe('expense')
      }
    })
  })

  describe('identifier mapping', () => {
    it('maps transaction id to engine input', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn({ id: 'txn-real-1' }), [makeRule()], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { transaction: { id: string; bankAccountId: string; companyId: string } }
      expect(callArg.transaction.id).toBe('txn-real-1')
    })

    it('maps bankAccountId to engine input', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn({ bankAccountId: 'acct-real-1' }), [makeRule()], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { transaction: { bankAccountId: string } }
      expect(callArg.transaction.bankAccountId).toBe('acct-real-1')
    })

    it('maps companyId to each engine rule', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule({ id: 'r1', companyId: 'c1' }), makeRule({ id: 'r2', companyId: 'c2' })], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ id: string; companyId: string }> } }
      expect(callArg.context.availableRules[0].companyId).toBe('c1')
      expect(callArg.context.availableRules[1].companyId).toBe('c2')
    })

    it('maps companyId to engine transaction', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'my-company')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { transaction: { companyId: string } }
      expect(callArg.transaction.companyId).toBe('my-company')
    })
  })

  describe('adapter purity', () => {
    it('calls evaluateRules exactly once per invocation', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision() },
      })

      await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')
      expect(mockEvaluateRules).toHaveBeenCalledTimes(1)
    })

    it('filters out inactive rules', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      const activeRule = makeRule({ id: 'active-1', isActive: true })
      const inactiveRule = makeRule({ id: 'inactive-1', isActive: false, glAccountId: null })

      const result = await runRuleEngineV2(makeTxn(), [activeRule, inactiveRule], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ id: string }> } }
      const ruleIds = callArg.context.availableRules.map((r: { id: string }) => r.id)
      expect(ruleIds).toContain('active-1')
      expect(ruleIds).not.toContain('inactive-1')
    })

    it('maps rule glAccountId to engine action', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule({ glAccountId: 'gl-099' })], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ action: { glAccountId: string } }> } }
      expect(callArg.context.availableRules[0].action.glAccountId).toBe('gl-099')
    })

    it('falls back to debitGlAccountId when glAccountId is null', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule({ glAccountId: null, debitGlAccountId: 'debit-1' })], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ action: { glAccountId: string } }> } }
      expect(callArg.context.availableRules[0].action.glAccountId).toBe('debit-1')
    })

    it('falls back to creditGlAccountId when both glAccountId and debitGlAccountId are null', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule({ glAccountId: null, debitGlAccountId: null, creditGlAccountId: 'credit-1' })], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ action: { glAccountId: string } }> } }
      expect(callArg.context.availableRules[0].action.glAccountId).toBe('credit-1')
    })

    it('prioritizes glAccountId over debitGlAccountId and creditGlAccountId', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule({ glAccountId: 'gl-1', debitGlAccountId: 'debit-1', creditGlAccountId: 'credit-1' })], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ action: { glAccountId: string } }> } }
      expect(callArg.context.availableRules[0].action.glAccountId).toBe('gl-1')
    })

    it('sets glAccountId to undefined when all gl account fields are null', async () => {
      mockEvaluateRules.mockReturnValueOnce({
        output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
      })

      await runRuleEngineV2(makeTxn(), [makeRule({ glAccountId: null, debitGlAccountId: null, creditGlAccountId: null })], defaultEntityResolution, 'company-1')

      const callArg = mockEvaluateRules.mock.calls[0][0] as { context: { availableRules: Array<{ action: { glAccountId: string | undefined } }> } }
      expect(callArg.context.availableRules[0].action.glAccountId).toBeUndefined()
    })
  })
})
