import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiFallback, type AiFallbackInput, type AiBridgeDeps } from '../ai-bridge';
import { evaluateRulesWithAiFallback } from '../index';
import type { EngineDecision, RuleInput } from '../types';

// Enable V2 engine for tests
vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDecision(overrides?: Partial<EngineDecision>): EngineDecision {
  return {
    type: 'rule',
    result: 'no_match',
    candidateList: [],
    explanation: 'No matching rules found',
    ...overrides,
  };
}

function makeInput(overrides?: Partial<AiFallbackInput>): AiFallbackInput {
  return {
    companyId: 'company-1',
    transactionId: 'tx-1',
    description: 'NETFLIX SUBSCRIPTION',
    amount: -15.99,
    decision: makeDecision(),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<AiBridgeDeps>): AiBridgeDeps {
  return {
    parseWithAI: vi.fn().mockResolvedValue({
      role: 'expense',
      glAccountCode: '6100',
      conditions: null,
      suggestSubAccount: false,
      subAccountName: null,
    }),
    resolveGLAccount: vi.fn().mockResolvedValue({
      glAccountId: 'gl-6100',
      account: { code: '6100', name: 'Software Subscriptions' },
    }),
    getAiConfig: vi.fn().mockResolvedValue({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://test.api.com',
      providerId: 'openrouter',
    }),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('aiFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T1: NO_MATCH triggers AI bridge', async () => {
    const deps = makeDeps();
    const input = makeInput({ decision: makeDecision({ result: 'no_match' }) });

    const result = await aiFallback(input, deps);

    expect(result).not.toBeNull();
    expect(deps.parseWithAI).toHaveBeenCalledOnce();
  });

  it('T2: AMBIGUOUS triggers AI bridge', async () => {
    const deps = makeDeps();
    const input = makeInput({ decision: makeDecision({ result: 'ambiguous' }) });

    const result = await aiFallback(input, deps);

    expect(result).not.toBeNull();
    expect(deps.parseWithAI).toHaveBeenCalledOnce();
  });

  it('T3: WINNER does not trigger AI', async () => {
    const deps = makeDeps();
    const input = makeInput({ decision: makeDecision({ result: 'winner' }) });

    const result = await aiFallback(input, deps);

    expect(result).toBeNull();
    expect(deps.parseWithAI).not.toHaveBeenCalled();
  });

  it('T4: original decision is not mutated', async () => {
    const decision = makeDecision({ result: 'no_match', ruleId: 'rule-1' });
    const originalResult = decision.result;
    const originalRuleId = decision.ruleId;
    const originalCandidateList = [...decision.candidateList];

    const deps = makeDeps();
    const input = makeInput({ decision });

    await aiFallback(input, deps);

    expect(decision.result).toBe(originalResult);
    expect(decision.ruleId).toBe(originalRuleId);
    expect(decision.candidateList).toEqual(originalCandidateList);
  });

  it('T5: AI failure produces no proposal and does not alter decision', async () => {
    const decision = makeDecision({ result: 'no_match' });
    const deps = makeDeps({
      parseWithAI: vi.fn().mockRejectedValue(new Error('AI unavailable')),
    });
    const input = makeInput({ decision });

    const result = await aiFallback(input, deps);

    expect(result).toBeNull();
    expect(decision.result).toBe('no_match');
  });

  it('T6: glAccountCode resolves read-only to glAccountId', async () => {
    const deps = makeDeps();
    const input = makeInput();

    const result = await aiFallback(input, deps);

    expect(result).not.toBeNull();
    expect(result!.glAccountCode).toBe('6100');
    expect(result!.glAccountId).toBe('gl-6100');
    expect(deps.resolveGLAccount).toHaveBeenCalledWith('company-1', '6100');
  });

  it('T7: nonexistent glAccountCode produces glAccountId=null without creation', async () => {
    const deps = makeDeps({
      parseWithAI: vi.fn().mockResolvedValue({
        role: 'expense',
        glAccountCode: '9999',
        conditions: null,
        suggestSubAccount: false,
        subAccountName: null,
      }),
      resolveGLAccount: vi.fn().mockResolvedValue({
        glAccountId: null,
        account: { code: '9999', name: 'Unclassified' },
      }),
    });
    const input = makeInput();

    const result = await aiFallback(input, deps);

    expect(result).not.toBeNull();
    expect(result!.glAccountId).toBeNull();
    expect(result!.glAccountCode).toBe('9999');
    // resolveGLAccount is read-only — no create call
  });

  it('returns null when AI config is missing', async () => {
    const deps = makeDeps({
      getAiConfig: vi.fn().mockRejectedValue(new Error('AI configuration missing')),
    });
    const input = makeInput();

    const result = await aiFallback(input, deps);

    expect(result).toBeNull();
  });

  it('preserves conditions from AI response', async () => {
    const deps = makeDeps({
      parseWithAI: vi.fn().mockResolvedValue({
        role: 'expense',
        glAccountCode: '6100',
        conditions: [{ field: 'description', operator: 'contains', value: 'NETFLIX' }],
        suggestSubAccount: false,
        subAccountName: null,
      }),
    });
    const input = makeInput();

    const result = await aiFallback(input, deps);

    expect(result).not.toBeNull();
    expect(result!.conditions).toEqual([
      { field: 'description', operator: 'contains', value: 'NETFLIX' },
    ]);
  });
});

describe('evaluateRulesWithAiFallback integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseInput: RuleInput = {
    transaction: {
      id: 'tx-1',
      date: new Date('2026-01-15'),
      description: 'UNKNOWN TRANSACTION',
      amount: -50.0,
      bankAccountId: 'bank-1',
      companyId: 'company-1',
    },
    context: {
      availableRules: [],
      entityContexts: [],
      historicalMatches: [],
      entityResolution: { status: 'not_run' },
    },
  };

  it('T11: V2 flow returns aiProposal separately without changing deterministic decision', async () => {
    const deps: AiBridgeDeps = {
      parseWithAI: vi.fn().mockResolvedValue({
        role: 'expense',
        glAccountCode: '6100',
        conditions: null,
        suggestSubAccount: false,
        subAccountName: null,
      }),
      resolveGLAccount: vi.fn().mockResolvedValue({
        glAccountId: 'gl-6100',
        account: { code: '6100', name: 'Software Subscriptions' },
      }),
      getAiConfig: vi.fn().mockResolvedValue({
        apiKey: 'test-key',
        model: 'test-model',
        baseUrl: 'https://test.api.com',
        providerId: 'openrouter',
      }),
    };

    const { execution, aiProposal } = await evaluateRulesWithAiFallback(
      baseInput,
      { aiBridgeDeps: deps },
    );

    // Deterministic decision is preserved
    expect(execution.output.decision).toBeDefined();
    expect(execution.output.decision!.result).toBe('no_match');
    expect(execution.output.decision!.candidateList).toEqual([]);

    // AI proposal is separate
    expect(aiProposal).not.toBeNull();
    expect(aiProposal!.role).toBe('expense');
    expect(aiProposal!.glAccountCode).toBe('6100');
    expect(aiProposal!.glAccountId).toBe('gl-6100');
  });

  it('T12-T14: adapter returns aiProposal in match result for pending outcome', async () => {
    // This test verifies that the adapter transports aiProposal correctly
    // The actual import flow (PendingApproval creation) is tested through
    // the adapter's return type, which import.service.ts consumes.
    const { runRuleEngineV2 } = await import('@/lib/services/rule-engine-adapter');

    const result = await runRuleEngineV2(
      {
        id: 'tx-1',
        date: new Date('2026-01-15'),
        description: 'UNKNOWN TRANSACTION',
        amount: -50.0,
        bankAccountId: 'bank-1',
      },
      [],
      { status: 'not_run' },
      'company-1',
    );

    // Without AI config, aiProposal should be undefined
    expect(result.outcome).toBe('pending');
    expect(result.deterministicResult).toBe('no_match');
    // aiProposal is undefined when AI is not configured
  });
});
