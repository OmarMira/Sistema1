export type RuleConditionType =
  | 'amount_gt'
  | 'amount_gte'
  | 'amount_lt'
  | 'amount_lte'
  | 'description_eq'
  | 'description_contains'
  | 'description_starts_with'
  | 'description_ends_with'
  | 'description_matches'
  | 'entity_eq'
  | 'amount_eq'
  | 'amount_range'
  | 'date_before'
  | 'date_after';

export interface RuleCondition {
  type: RuleConditionType;
  value: string | number;
  range?: [number, number];
}

export interface BankRule {
  id: string;
  companyId: string;
  priority: number;
  conditions: RuleCondition[];
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
  isActive: boolean;
  lifecycleStatus: RuleLifecycleStatus;
}

export type RuleLifecycleStatus = 'draft' | 'testing' | 'active' | 'deprecated' | 'archived';

export interface Transaction {
  id: string;
  date: Date;
  description: string;
  amount: number;
  bankAccountId: string;
  companyId: string;
}

export interface EvaluatedCondition {
  type: RuleConditionType;
  score: number;
  match: boolean;
  detail: string;
}

export interface Candidate {
  ruleId: string;
  /** @deprecated Use SpecificityScore internally — this is a derived compatibility field (weightWithinTier). NOT used for ranking. */
  specificity: number;
  matchQuality: number;
  confidence: number;
  conditionScores: number[];
  priority: number;
}

export type DecisionType = 'rule' | 'history' | 'entity' | 'ai' | 'manual';
export type DecisionResult = 'winner' | 'ambiguous' | 'no_match';
export type EntityResolutionStatus = 'not_run' | 'resolved' | 'not_found';

export interface EntityResolution {
  status: EntityResolutionStatus;
  entityId?: string;
}

export interface RawCandidate {
  ruleId: string;
  conditionScores: number[];
  priority: number;
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
}

export interface SpecificityScore {
  highestTier: number;
  weightWithinTier: number;
}

export interface ScoredCandidate {
  ruleId: string;
  specificityScore: SpecificityScore;
  matchQuality: number;
  priority: number;
  conditionScores: number[];
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
}

export interface PipelineArtifacts {
  rawCandidates: RawCandidate[];
  evaluations: Map<string, EvaluatedCondition[]>;
}

export interface EngineDecision {
  type: DecisionType;
  result: DecisionResult;
  ruleId?: string;
  candidateList: Candidate[];
  classification?: {
    entityId?: string;
    category?: string;
    glAccountId?: string;
  };
  explanation: string;
}

export type DecisionReason =
  | 'no_candidates'
  | 'single_candidate'
  | 'higher_specificity_tier'
  | 'higher_specificity_weight'
  | 'delta_above_threshold'
  | 'delta_below_threshold';

export type TraceEvent =
  | { stage: 'pipeline'; event: 'candidates_collected'; count: number }
  | { stage: 'pipeline'; event: 'condition_evaluated'; ruleId: string; conditionType: RuleConditionType; score: number; matched: boolean }
  | { stage: 'pipeline'; event: 'candidate_valid'; ruleId: string; conditionCount: number }
  | { stage: 'pipeline'; event: 'candidate_discarded'; ruleId: string }
  | { stage: 'scoring'; event: 'candidate_scored'; ruleId: string; highestTier: number; weightWithinTier: number; matchQuality: number }
  | { stage: 'ranking'; event: 'final_order'; rankedRuleIds: string[] }
  | { stage: 'decision'; event: 'outcome'; result: DecisionResult; reason: DecisionReason; winnerRuleId?: string; delta?: number; threshold: number }
  | { stage: 'execution'; event: 'complete' }
  | { stage: 'execution'; event: 'error'; errorCode?: string };

export interface DecisionTrace {
  events: TraceEvent[];
  engineVersion: string;
  truncated: boolean;
  totalEvents: number;
  emittedEvents: number;
}

export interface AuditRecord {
  engineVersion: string;
  transactionId: string;
  companyId: string;
  result: DecisionResult;
  winnerRuleId?: string;
  candidateCount: number;
  trace: DecisionTrace;
}

export interface RuleEngineExecution {
  output: RuleOutput;
  trace?: DecisionTrace;
  audit?: AuditRecord;
}

export interface RuleInput {
  transaction: Transaction;
  context: {
    availableRules: BankRule[];
    entityContexts: unknown[];
    historicalMatches: unknown[];
    entityResolution: EntityResolution;
  };
}

export interface RuleOutput {
  candidates: Candidate[];
  decision?: EngineDecision;
}
