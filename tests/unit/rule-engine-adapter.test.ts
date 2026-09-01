import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EngineDecision, EntityResolution } from '@/lib/rule-engine/types'

const mockEvaluateRules = vi.fn()
const mockEvaluateRulesPure = vi.fn()
const mockEvaluateRulesWithAiFallback = vi.fn()

vi.mock('@/lib/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
  evaluateRulesPure: (...args: unknown[]) => mockEvaluateRulesPure(...args),
  evaluateRulesWithAiFallback: (...args: unknown[]) => mockEvaluateRulesWithAiFallback(...args),
}))

import { runRuleEngineV2, runRuleEngineV2Shadow } from '@/lib/services/rule-engine-adapter'
import type { ParsedTransaction, PrismaBankRule } from '@/lib/services/rule-engine-adapter'

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

describe('runRuleEngineV2 — edge cases', () => {
  it('handles null conditions (Prisma nullable Json)', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
    })
    const rule = makeRule({ conditions: null as unknown as PrismaBankRule['conditions'] })
    const result = await runRuleEngineV2(makeTxn(), [rule], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
    if (result.outcome === 'pending') {
      expect(result.errorCode).toBe('conditions_normalization_failed')
    }
  })

  it('handles empty conditions array', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
    })
    const rule = makeRule({ conditions: [] })
    const result = await runRuleEngineV2(makeTxn(), [rule], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
    if (result.outcome === 'pending') {
      expect(result.errorCode).toBe('conditions_normalization_failed')
    }
  })

  it('handles zero rules gracefully', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
    })
    const result = await runRuleEngineV2(makeTxn(), [], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })

  it('excludes inactive rules before normalization', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
    })
    const inactive = makeRule({
      id: 'inactive',
      isActive: false,
      conditions: null as unknown as PrismaBankRule['conditions'],
    })
    const result = await runRuleEngineV2(makeTxn(), [inactive], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })

  it('excludes inactive rules even when active rules have corrupt conditions', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
    })
    const active = makeRule({ conditions: null as unknown as PrismaBankRule['conditions'] })
    const inactive = makeRule({ id: 'inactive-1', isActive: false })
    const result = await runRuleEngineV2(makeTxn(), [active, inactive], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
    if (result.outcome === 'pending') {
      expect(result.errorCode).toBe('conditions_normalization_failed')
    }
  })

  it('passes entityResolution status to engine context', async () => {
    mockEvaluateRulesWithAiFallback.mockResolvedValueOnce({
      execution: { output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) } },
      aiProposal: null,
    })
    const er: EntityResolution = { status: 'resolved', entityId: 'ent-1' }
    await runRuleEngineV2(makeTxn(), [makeRule()], er, 'company-1')

    const callArg = mockEvaluateRulesWithAiFallback.mock.calls[0][0] as {
      context: { entityResolution: EntityResolution }
    }
    expect(callArg.context.entityResolution).toEqual(er)
  })

  it('passes entityResolution with not_found status', async () => {
    mockEvaluateRulesWithAiFallback.mockResolvedValueOnce({
      execution: { output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) } },
      aiProposal: null,
    })
    await runRuleEngineV2(makeTxn(), [makeRule()], { status: 'not_found' }, 'company-1')

    const callArg = mockEvaluateRulesWithAiFallback.mock.calls[0][0] as {
      context: { entityResolution: EntityResolution }
    }
    expect(callArg.context.entityResolution).toEqual({ status: 'not_found' })
  })

  it('returns pending when engine decision has undefined classification', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: {
        candidates: [],
        decision: makeEngineDecision({
          result: 'winner',
          ruleId: 'rule-1',
          classification: undefined,
        }),
      },
    })
    const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })

  it('handles engine returning engineError structure without throwing', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: {
        candidates: [],
        decision: undefined,
        engineError: 'something went wrong',
      },
    })
    const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })

  it('returns pending when winner has no GL account and no ruleId', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: {
        candidates: [],
        decision: makeEngineDecision({
          result: 'winner',
          ruleId: undefined,
          classification: undefined,
        }),
      },
    })
    const result = await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })

  it('handles engine ambiguous result', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: {
        candidates: [],
        decision: makeEngineDecision({
          result: 'ambiguous',
          ruleId: undefined,
          classification: undefined,
        }),
      },
    })
    const result = await runRuleEngineV2(makeTxn(), [makeRule(), makeRule({ id: 'r2' })], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })

  it('returns pending when winner is missing glAccountId in classification', async () => {
    mockEvaluateRules.mockReturnValueOnce({
      output: {
        candidates: [],
        decision: makeEngineDecision({ classification: {} }),
      },
    })
    const rule = makeRule({ glAccountId: null, debitGlAccountId: null, creditGlAccountId: null })
    const result = await runRuleEngineV2(makeTxn(), [rule], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
  })
})

describe('runRuleEngineV2 — options forwarding', () => {
  it('forwards persistAudit:false to evaluateRulesWithAiFallback', async () => {
    mockEvaluateRulesWithAiFallback.mockResolvedValueOnce({
      execution: { output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) } },
      aiProposal: null,
    })

    await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1', {
      persistAudit: false,
    })

    expect(mockEvaluateRulesWithAiFallback).toHaveBeenCalledTimes(1)
    expect(mockEvaluateRulesWithAiFallback).toHaveBeenCalledWith(expect.anything(), { persistAudit: false })
  })

  it('forwards undefined opts when no options are provided', async () => {
    mockEvaluateRulesWithAiFallback.mockResolvedValueOnce({
      execution: { output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) } },
      aiProposal: null,
    })

    await runRuleEngineV2(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(mockEvaluateRulesWithAiFallback).toHaveBeenCalledWith(expect.anything(), undefined)
  })
})

describe('runRuleEngineV2Shadow — pure shadow evaluation', () => {
  it('evaluates via evaluateRulesPure and never via evaluateRules', async () => {
    mockEvaluateRulesPure.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision() },
    })

    const result = runRuleEngineV2Shadow(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(mockEvaluateRulesPure).toHaveBeenCalledTimes(1)
    expect(mockEvaluateRules).not.toHaveBeenCalled()
    expect(result.outcome).toBe('matched')
    if (result.outcome === 'matched') {
      expect(result.matchedRuleId).toBe('rule-1')
      expect(result.classification.glAccountId).toBe('gl-001')
    }
  })

  it('maps no_match to pending without errorCode', () => {
    mockEvaluateRulesPure.mockReturnValueOnce({
      output: { candidates: [], decision: makeEngineDecision({ result: 'no_match' }) },
    })

    const result = runRuleEngineV2Shadow(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
    if (result.outcome === 'pending') {
      expect(result.errorCode).toBeUndefined()
    }
  })

  it('catches null conditions normalization errors', () => {
    const rule = makeRule({ conditions: null as unknown as PrismaBankRule['conditions'] })
    const result = runRuleEngineV2Shadow(makeTxn(), [rule], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
    if (result.outcome === 'pending') {
      expect(result.errorCode).toBe('conditions_normalization_failed')
    }
  })

  it('returns pending with errorCode when pure evaluation throws', () => {
    mockEvaluateRulesPure.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    const result = runRuleEngineV2Shadow(makeTxn(), [makeRule()], defaultEntityResolution, 'company-1')

    expect(result.outcome).toBe('pending')
    if (result.outcome === 'pending') {
      expect(result.errorCode).toBe('engine_execution_error')
    }
  })
})
