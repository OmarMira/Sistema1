import { describe, it, expect } from 'vitest'
import { detectFormat, normalize } from '@/lib/services/rule-engine-adapter/conditions-normalizer'

describe('detectFormat', () => {
  it('returns "v1" for array with field/operator/value objects', () => {
    const conditions = [
      { field: 'description', operator: 'contains', value: 'test' },
    ]
    expect(detectFormat(conditions)).toBe('v1')
  })

  it('returns "v2" for array with type/value objects', () => {
    const conditions = [
      { type: 'description_contains', value: 'test' },
    ]
    expect(detectFormat(conditions)).toBe('v2')
  })

  it('returns "corrupt" for null', () => {
    expect(detectFormat(null)).toBe('corrupt')
  })

  it('returns "corrupt" for undefined', () => {
    expect(detectFormat(undefined)).toBe('corrupt')
  })

  it('returns "corrupt" for non-array input', () => {
    expect(detectFormat('not-an-array')).toBe('corrupt')
    expect(detectFormat(42)).toBe('corrupt')
    expect(detectFormat({})).toBe('corrupt')
  })

  it('returns "corrupt" for empty array', () => {
    expect(detectFormat([])).toBe('corrupt')
  })

  it('returns "corrupt" for array with unrecognized object shape', () => {
    const conditions = [{ foo: 'bar', baz: 1 }]
    expect(detectFormat(conditions)).toBe('corrupt')
  })

  it('returns "corrupt" for array with mixed v1/v2 objects', () => {
    const conditions = [
      { field: 'description', operator: 'contains', value: 'test' },
      { type: 'amount_gt', value: 100 },
    ]
    expect(detectFormat(conditions)).toBe('corrupt')
  })
})

describe('normalize', () => {
  describe('v1 description conditions', () => {
    it('maps description_contains to description_contains', () => {
      const input = [{ field: 'description', operator: 'contains', value: 'test' }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'description_contains', value: 'test' }])
    })

    it('maps description_starts_with to description_starts_with', () => {
      const input = [{ field: 'description', operator: 'starts_with', value: 'interest' }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'description_starts_with', value: 'interest' }])
    })

    it('maps description_ends_with to description_ends_with', () => {
      const input = [{ field: 'description', operator: 'ends_with', value: 'fee' }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'description_ends_with', value: 'fee' }])
    })

    it('maps description_equals to description_eq', () => {
      const input = [{ field: 'description', operator: 'equals', value: 'EXACT MATCH' }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'description_eq', value: 'EXACT MATCH' }])
    })

    it('preserves numeric value as string', () => {
      const input = [{ field: 'description', operator: 'contains', value: '1234' }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'description_contains', value: '1234' }])
    })
  })

  describe('v1 amount conditions', () => {
    it('maps amount_greater to amount_gt', () => {
      const input = [{ field: 'amount', operator: 'amount_greater', value: 1000 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_gt', value: 1000 }])
    })

    it('maps amount_less to amount_lt', () => {
      const input = [{ field: 'amount', operator: 'amount_less', value: 500 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_lt', value: 500 }])
    })

    it('maps legacy greater_than to amount_gt', () => {
      const input = [{ field: 'amount', operator: 'greater_than', value: 100 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_gt', value: 100 }])
    })

    it('maps legacy greaterThan to amount_gt', () => {
      const input = [{ field: 'amount', operator: 'greaterThan', value: 100 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_gt', value: 100 }])
    })

    it('maps legacy less_than to amount_lt', () => {
      const input = [{ field: 'amount', operator: 'less_than', value: 200 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_lt', value: 200 }])
    })

    it('maps legacy lessThan to amount_lt', () => {
      const input = [{ field: 'amount', operator: 'lessThan', value: 200 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_lt', value: 200 }])
    })

    it('maps amount_equals to amount_eq', () => {
      const input = [{ field: 'amount', operator: 'equals', value: 150 }]
      const result = normalize(input)
      expect(result).toEqual([{ type: 'amount_eq', value: 150 }])
    })
  })

  describe('multiple conditions', () => {
    it('normalizes multiple v1 conditions', () => {
      const input = [
        { field: 'description', operator: 'contains', value: 'wire' },
        { field: 'amount', operator: 'amount_greater', value: 10000 },
      ]
      const result = normalize(input)
      expect(result).toEqual([
        { type: 'description_contains', value: 'wire' },
        { type: 'amount_gt', value: 10000 },
      ])
    })
  })

  describe('error handling', () => {
    it('throws on corrupt format', () => {
      expect(() => normalize(null)).toThrow('conditions_normalization_failed')
    })

    it('throws on unknown v1 operator', () => {
      const input = [{ field: 'description', operator: 'unknown_op', value: 'x' }]
      expect(() => normalize(input)).toThrow('conditions_normalization_failed')
    })

    it('throws on unknown v1 field', () => {
      const input = [{ field: 'date', operator: 'contains', value: '2024' }]
      expect(() => normalize(input)).toThrow('conditions_normalization_failed')
    })

    it('throws on invalid amount operator without amount field', () => {
      const input = [{ field: 'description', operator: 'amount_greater', value: 100 }]
      expect(() => normalize(input)).toThrow('conditions_normalization_failed')
    })
  })

  describe('v2 passthrough', () => {
    it('passes through v2 format unchanged', () => {
      const input = [
        { type: 'description_contains', value: 'test' },
        { type: 'amount_gt', value: 100 },
      ]
      const result = normalize(input)
      expect(result).toEqual(input)
    })

    it('passes through v2 with range', () => {
      const input = [{ type: 'amount_range', value: 0, range: [100, 1000] }]
      const result = normalize(input)
      expect(result).toEqual(input)
    })
  })
})
