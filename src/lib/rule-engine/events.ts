export interface V2EngineResult {
  outcome: 'matched' | 'pending'
  matchedRuleId?: string
  errorCode?: string
}

export interface PrecedenceEngineResult {
  reason: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS'
  winnerRuleId: string | null
  ambiguous: boolean
}

export type DivergenceType =
  | 'DIFFERENT_WINNER'
  | 'V2_MATCH_PRECEDENCE_NO_MATCH'
  | 'V2_NO_MATCH_PRECEDENCE_MATCH'
  | 'V2_PENDING_PRECEDENCE_MATCH'
  | 'V2_ERROR'
  | 'SAME'

export interface RuleEngineDivergenceEvent {
  transactionId: string
  companyId: string
  timestamp: Date
  v2Result: V2EngineResult
  precedenceResult: PrecedenceEngineResult
  divergenceType: DivergenceType
}

export function classifyDivergence(
  v2Result: V2EngineResult,
  precedenceResult: PrecedenceEngineResult,
): DivergenceType {
  if (v2Result.outcome === 'matched' && precedenceResult.reason === 'NO_MATCH') {
    return 'V2_MATCH_PRECEDENCE_NO_MATCH'
  }
  if (v2Result.outcome === 'pending' && v2Result.errorCode) {
    return 'V2_ERROR'
  }
  if (v2Result.outcome === 'pending' && precedenceResult.reason === 'WINNER') {
    return 'V2_NO_MATCH_PRECEDENCE_MATCH'
  }
  if (v2Result.outcome === 'matched' && precedenceResult.reason === 'AMBIGUOUS') {
    return 'V2_MATCH_PRECEDENCE_NO_MATCH'
  }
  if (v2Result.outcome === 'matched' && precedenceResult.reason === 'WINNER') {
    if (v2Result.matchedRuleId !== precedenceResult.winnerRuleId) {
      return 'DIFFERENT_WINNER'
    }
    return 'SAME'
  }
  return 'SAME'
}

export function buildDivergenceEvent(
  transactionId: string,
  companyId: string,
  v2Result: V2EngineResult,
  precedenceResult: PrecedenceEngineResult,
): RuleEngineDivergenceEvent | null {
  const divergenceType = classifyDivergence(v2Result, precedenceResult)
  if (divergenceType === 'SAME') return null

  return {
    transactionId,
    companyId,
    timestamp: new Date(),
    v2Result,
    precedenceResult,
    divergenceType,
  }
}
