import { describe, it, expect } from 'vitest';
import { makeTransaction, makeCondition } from '../fixtures';
import { evaluateEntityEq } from '../../conditions/entity';
import { MissingEntityIdError } from '../../errors';

describe('entity_eq', () => {
  it('resolved status and matching entityId returns match', () => {
    const tx = makeTransaction();
    const context = { entityResolution: { status: 'resolved' as const, entityId: 'ent-123' } };
    const result = evaluateEntityEq(makeCondition('entity_eq', 'ent-123'), tx, context);
    expect(result.match).toBe(true);
    expect(result.score).toBe(1);
  });

  it('resolved status and non-matching entityId returns no match', () => {
    const tx = makeTransaction();
    const context = { entityResolution: { status: 'resolved' as const, entityId: 'ent-123' } };
    const result = evaluateEntityEq(makeCondition('entity_eq', 'ent-456'), tx, context);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('not_found status returns no match', () => {
    const tx = makeTransaction();
    const context = { entityResolution: { status: 'not_found' as const } };
    const result = evaluateEntityEq(makeCondition('entity_eq', 'ent-123'), tx, context);
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });

  it('not_run status throws MissingEntityIdError', () => {
    const tx = makeTransaction();
    const context = { entityResolution: { status: 'not_run' as const } };
    expect(() => evaluateEntityEq(makeCondition('entity_eq', 'ent-123'), tx, context)).toThrow(MissingEntityIdError);
  });

  it('includes conditionType in error', () => {
    const tx = makeTransaction();
    const context = { entityResolution: { status: 'not_run' as const } };
    try {
      evaluateEntityEq(makeCondition('entity_eq', 'ent-123'), tx, context);
    } catch (e) {
      if (e instanceof MissingEntityIdError) {
        expect(e.conditionType).toBe('entity_eq');
      }
    }
  });

  it('does not expose transaction data in error details', () => {
    const tx = makeTransaction({ amount: 999999, companyId: 'secret-company' });
    const context = { entityResolution: { status: 'not_run' as const } };
    try {
      evaluateEntityEq(makeCondition('entity_eq', 'some-entity'), tx, context);
    } catch (e) {
      if (e instanceof MissingEntityIdError) {
        const serialized = JSON.stringify(e.details);
        expect(serialized).not.toContain('999999');
        expect(serialized).not.toContain('secret-company');
      }
    }
  });
});
