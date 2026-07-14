export type RuleEngineOutcome = 'matched' | 'pending' | 'skipped'

export type SkipReason =
  | 'reconciled'
  | 'journal_linked'
  | 'classified'
  | 'ignored'
  | 'manually_edited'

export type RuleEngineErrorCode =
  | 'conditions_normalization_failed'
  | 'engine_execution_error'

export type MatchResult =
  | { outcome: 'matched'; classification: { glAccountId: string; entityId?: string; category?: string }; matchedRuleId: string }
  | { outcome: 'pending'; classification?: { glAccountId?: string; entityId?: string; category?: string }; matchedRuleId?: never; skipReason?: never; errorCode?: RuleEngineErrorCode }
  | { outcome: 'skipped'; matchedRuleId?: never; skipReason: SkipReason }
