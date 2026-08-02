import { describe, it, expect } from 'vitest';
import { createLearningRuleSchema } from '@/lib/validations/learning-rule';

describe('BRE-011 Decision #1 — shared write/import validation barrier', () => {
  const base = { pattern: 'netflix' };

  it('accepts a rule without conditions', () => {
    expect(createLearningRuleSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a rule with normal conditions', () => {
    const r = createLearningRuleSchema.safeParse({
      ...base,
      conditions: [{ field: 'description', operator: 'contains', value: 'netflix' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects "*" on amount operators at rule write/import', () => {
    const r = createLearningRuleSchema.safeParse({
      ...base,
      conditions: [{ field: 'amount', operator: 'amount_greater', value: '*' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues[0];
      expect(issue.message).toMatch(/not allowed/);
      expect(issue.path).toContain('conditions');
    }
  });

  it('allows "*" on on-surface description operators (wildcard is legal there)', () => {
    const r = createLearningRuleSchema.safeParse({
      ...base,
      conditions: [{ field: 'description', operator: 'equals', value: '*' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects when any condition in the array carries "*" on an excluded operator', () => {
    const r = createLearningRuleSchema.safeParse({
      ...base,
      conditions: [
        { field: 'description', operator: 'contains', value: 'netflix' },
        { field: 'amount', operator: 'less_than', value: '*' },
      ],
    });
    expect(r.success).toBe(false);
  });
});
