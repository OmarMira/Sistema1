import type { BankRule, Transaction, RuleCondition, RuleInput, EvaluatedCondition, RuleConditionType, RuleLifecycleStatus, RawCandidate, ScoredCandidate, SpecificityScore, PipelineArtifacts, EngineDecision, EntityResolution, EntityResolutionStatus } from '../types';

let ruleIdCounter = 0;
let txIdCounter = 0;

export function makeRule(overrides?: Partial<BankRule>): BankRule {
  ruleIdCounter++;
  return {
    id: `rule-${ruleIdCounter}`,
    companyId: 'company-1',
    priority: 10,
    conditions: [],
    action: {},
    isActive: true,
    lifecycleStatus: 'active' as RuleLifecycleStatus,
    ...overrides,
  };
}

export function makeTransaction(overrides?: Partial<Transaction>): Transaction {
  txIdCounter++;
  const now = new Date();
  return {
    id: `tx-${txIdCounter}`,
    date: now,
    description: 'Test transaction',
    amount: 1000,
    bankAccountId: 'acc-1',
    companyId: 'company-1',
    ...overrides,
  };
}

export function makeCondition(type: RuleConditionType, value: string | number, range?: [number, number]): RuleCondition {
  const c: RuleCondition = { type, value };
  if (range !== undefined) c.range = range;
  return c;
}

export function makeRuleInput(overrides?: Partial<RuleInput>): RuleInput {
  const defaults = {
    transaction: makeTransaction(),
    context: { availableRules: [] as BankRule[], entityContexts: [] as unknown[], historicalMatches: [] as unknown[], entityResolution: { status: 'not_run' as const } },
  };
  if (overrides?.context) {
    return {
      ...defaults,
      ...overrides,
      context: { ...defaults.context, ...overrides.context },
    };
  }
  return { ...defaults, ...overrides };
}

export function makeEvaluatedCondition(overrides?: Partial<EvaluatedCondition>): EvaluatedCondition {
  return {
    type: 'amount_gt' as RuleConditionType,
    score: 1,
    match: true,
    detail: '',
    ...overrides,
  };
}

export function makeSpecificityScore(overrides?: Partial<SpecificityScore>): SpecificityScore {
  return {
    highestTier: 5,
    weightWithinTier: 500,
    ...overrides,
  };
}

export function makeRawCandidate(overrides?: Partial<RawCandidate>): RawCandidate {
  return {
    ruleId: 'raw-rule-1',
    conditionScores: [1, 0.5],
    priority: 10,
    action: {},
    ...overrides,
  };
}

export function makeScoredCandidate(overrides?: Partial<ScoredCandidate>): ScoredCandidate {
  return {
    ruleId: 'scored-rule-1',
    specificityScore: { highestTier: 5, weightWithinTier: 500 },
    matchQuality: 0.8,
    priority: 10,
    conditionScores: [1, 0.5],
    action: {},
    ...overrides,
  };
}

export function makePipelineArtifacts(overrides?: Partial<PipelineArtifacts>): PipelineArtifacts {
  return {
    rawCandidates: [],
    evaluations: new Map(),
    ...overrides,
  };
}

export function makeEngineDecision(overrides?: Partial<EngineDecision>): EngineDecision {
  return {
    type: 'rule' as const,
    result: 'no_match' as const,
    candidateList: [],
    classification: {},
    explanation: '',
    ...overrides,
  };
}

export function makeEntityResolution(overrides?: Partial<EntityResolution>): EntityResolution {
  return {
    status: 'not_run' as EntityResolutionStatus,
    ...overrides,
  };
}

export const presets = {
  get oneActiveRule() { return makeRule(); },
  get threeActiveRules() { return [makeRule(), makeRule(), makeRule()]; },
  get mixedLifecycleRules() {
    return [
      makeRule({ lifecycleStatus: 'active' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'draft' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'testing' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'archived' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'deprecated' as RuleLifecycleStatus }),
    ];
  },
  get validTransaction() { return makeTransaction(); },
  get validRuleInput() { return makeRuleInput(); },
  get emptyRuleInput() { return makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' } } }); },
  get invoiceScenarioRule() {
    return makeRule({
      conditions: [
        makeCondition('amount_gt', 500),
        makeCondition('description_contains', 'INVOICE'),
      ],
    });
  },

  // Sprint 2 — Entity Resolution
  get ruleWithEntityCondition() {
    return makeRule({
      conditions: [makeCondition('entity_eq', 'ent-123')],
      action: { entityId: 'ent-123' },
    });
  },
  get entityResolved() {
    return makeEntityResolution({ status: 'resolved', entityId: 'ent-123' });
  },
  get entityNotFound() {
    return makeEntityResolution({ status: 'not_found' });
  },
  get entityNotRun() {
    return makeEntityResolution({ status: 'not_run' });
  },

  // Sprint 2 — Specificity & Ranking presets
  get twoIdenticalSpecCandidates() {
    return [
      makeScoredCandidate({
        ruleId: 'rule-alpha',
        specificityScore: { highestTier: 3, weightWithinTier: 300 },
        matchQuality: 0.72,
        priority: 10,
      }),
      makeScoredCandidate({
        ruleId: 'rule-beta',
        specificityScore: { highestTier: 3, weightWithinTier: 300 },
        matchQuality: 0.68,
        priority: 5,
      }),
    ];
  },
  get highLowTierCandidates() {
    return [
      makeScoredCandidate({
        ruleId: 'rule-high',
        specificityScore: { highestTier: 5, weightWithinTier: 500 },
        matchQuality: 0.8,
        priority: 10,
      }),
      makeScoredCandidate({
        ruleId: 'rule-low',
        specificityScore: { highestTier: 1, weightWithinTier: 100 },
        matchQuality: 0.9,
        priority: 1,
      }),
    ];
  },

  // Sprint 2 — Decision presets
  get winnerScenarioInput() {
    return makeRuleInput({
      context: {
        availableRules: [
          makeRule({
            conditions: [makeCondition('amount_gt', 500)],
            action: { category: 'EXPENSE', glAccountId: '6000' },
          }),
        ],
        entityContexts: [],
        historicalMatches: [],
        entityResolution: { status: 'not_run' },
      },
    });
  },
  get ambiguousScenarioInput() {
    return makeRuleInput({
      context: {
        availableRules: [
          makeRule({
            conditions: [makeCondition('amount_gt', 500)],
            action: { category: 'EXPENSE' },
          }),
          makeRule({
            conditions: [makeCondition('amount_gt', 500)],
            action: { category: 'REVENUE' },
          }),
        ],
        entityContexts: [],
        historicalMatches: [],
        entityResolution: { status: 'not_run' },
      },
    });
  },
};
