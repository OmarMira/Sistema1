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

export interface ParsedTransaction {
  id: string
  date: Date
  description: string
  amount: number
  bankAccountId: string
  reference?: string
}

export interface PrismaBankRule {
  id: string
  companyId: string
  priority: number
  conditions: unknown
  conditionType?: string | null
  conditionValue?: string | number | null
  transactionDirection?: string | null
  glAccountId: string | null
  debitGlAccountId: string | null
  creditGlAccountId: string | null
  isActive: boolean
}

export type DeterministicResult = 'winner' | 'no_match' | 'ambiguous'

export type AiProposalData = {
  role: string
  glAccountCode: string
  glAccountId: string | null
  conditions?: { field: string; operator: string; value: string | number }[]
  suggestSubAccount: boolean
  subAccountName: string | null
}

export type MatchResult =
  | { outcome: 'matched'; classification: { glAccountId: string; entityId?: string; category?: string }; matchedRuleId: string; deterministicResult: DeterministicResult; aiProposal?: never }
  | { outcome: 'pending'; classification?: { glAccountId?: string; entityId?: string; category?: string }; matchedRuleId?: never; skipReason?: never; errorCode?: RuleEngineErrorCode; deterministicResult?: DeterministicResult; aiProposal?: AiProposalData }
  | { outcome: 'skipped'; matchedRuleId?: never; skipReason: SkipReason; deterministicResult?: never; aiProposal?: never }
