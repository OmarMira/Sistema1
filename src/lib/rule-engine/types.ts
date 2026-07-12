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
  specificity: number;
  matchQuality: number;
  confidence: number;
  conditionScores: number[];
  priority: number;
}

export type DecisionType = 'rule' | 'history' | 'entity' | 'ai' | 'manual';
export type DecisionResult = 'winner' | 'ambiguous' | 'no_match';

export interface EngineDecision {
  type: DecisionType;
  result: DecisionResult;
  ruleId?: string;
  candidateList: Candidate[];
  classification: {
    entityId?: string;
    category?: string;
    glAccountId?: string;
  };
  explanation: string;
}

export interface AuditLogEntry {
  engineVersion: string;
  decision: DecisionType;
  result: DecisionResult;
  winner: Candidate | null;
  candidates: Candidate[];
  delta: number;
  threshold: number;
  explanation: string;
  timestamp: string;
}

export interface RuleInput {
  transaction: Transaction;
  context: {
    availableRules: BankRule[];
    entityContexts: unknown[];
    historicalMatches: unknown[];
  };
}

export interface RuleOutput {
  candidates: Candidate[];
  decision?: EngineDecision;
}
