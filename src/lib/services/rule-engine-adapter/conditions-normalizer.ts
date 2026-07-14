import type { RuleCondition } from '@/lib/rule-engine/types'

type V1Condition = {
  field: string
  operator: string
  value: string | number
}

type V2Condition = {
  type: string
  value: string | number
  range?: [number, number]
}

type ConditionFormat = 'v1' | 'v2' | 'corrupt'

const FIELD_OPERATOR_MAP: Record<string, Record<string, string>> = {
  description: {
    contains: 'description_contains',
    starts_with: 'description_starts_with',
    ends_with: 'description_ends_with',
    equals: 'description_eq',
  },
  amount: {
    equals: 'amount_eq',
    amount_greater: 'amount_gt',
    amount_less: 'amount_lt',
    greater_than: 'amount_gt',
    greaterThan: 'amount_gt',
    less_than: 'amount_lt',
    lessThan: 'amount_lt',
  },
}

function isV1Condition(obj: unknown): obj is V1Condition {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  return (
    typeof candidate.field === 'string' &&
    typeof candidate.operator === 'string' &&
    (typeof candidate.value === 'string' || typeof candidate.value === 'number')
  )
}

function isV2Condition(obj: unknown): obj is V2Condition {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  if (typeof candidate.type !== 'string') return false
  if (typeof candidate.value !== 'string' && typeof candidate.value !== 'number') return false
  return true
}

function detectArrayFormat(arr: unknown[]): ConditionFormat {
  if (arr.length === 0) return 'corrupt'

  const hasV1 = arr.every(isV1Condition)
  const hasV2 = arr.every(isV2Condition)

  if (hasV1) return 'v1'
  if (hasV2) return 'v2'
  return 'corrupt'
}

export function detectFormat(conditions: unknown): ConditionFormat {
  if (!Array.isArray(conditions)) return 'corrupt'
  return detectArrayFormat(conditions)
}

function normalizeV1Condition(cond: V1Condition): RuleCondition {
  const fieldMap = FIELD_OPERATOR_MAP[cond.field]
  if (!fieldMap) {
    throw new NormalizationError(`Unrecognized field: ${cond.field}`)
  }

  const mappedType = fieldMap[cond.operator]
  if (!mappedType) {
    throw new NormalizationError(`Unrecognized operator "${cond.operator}" for field "${cond.field}"`)
  }

  return { type: mappedType as RuleCondition['type'], value: cond.value }
}

export class NormalizationError extends Error {
  constructor(message: string) {
    super(`conditions_normalization_failed: ${message}`)
    this.name = 'NormalizationError'
  }
}

export function normalize(conditions: unknown): RuleCondition[] {
  const format = detectFormat(conditions)

  if (format === 'v2') {
    return conditions as RuleCondition[]
  }

  if (format === 'v1') {
    return (conditions as V1Condition[]).map(normalizeV1Condition)
  }

  throw new NormalizationError('Unrecognized conditions format')
}
