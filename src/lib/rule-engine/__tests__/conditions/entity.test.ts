import { describe, it, expect } from 'vitest';
import { makeTransaction, makeCondition } from '../fixtures';
import { evaluateEntityEq } from '../../conditions/entity';
import { UnsupportedConditionError } from '../../errors';

describe('entity_eq', () => {
  it('throws UnsupportedConditionError', () => {
    const tx = makeTransaction();
    expect(() => evaluateEntityEq(makeCondition('entity_eq', 'entity-1'), tx)).toThrow(UnsupportedConditionError);
  });

  it('includes conditionType in error', () => {
    const tx = makeTransaction();
    try {
      evaluateEntityEq(makeCondition('entity_eq', 'entity-1'), tx);
    } catch (e) {
      if (e instanceof UnsupportedConditionError) {
        expect(e.conditionType).toBe('entity_eq');
      }
    }
  });

  it('does not expose transaction data in error details', () => {
    const tx = makeTransaction({ amount: 999999, companyId: 'secret-company' });
    try {
      evaluateEntityEq(makeCondition('entity_eq', 'some-entity'), tx);
    } catch (e) {
      if (e instanceof UnsupportedConditionError) {
        const serialized = JSON.stringify(e.details);
        expect(serialized).not.toContain('999999');
        expect(serialized).not.toContain('secret-company');
      }
    }
  });
});
