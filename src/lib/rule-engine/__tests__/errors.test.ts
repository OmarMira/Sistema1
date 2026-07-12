import { describe, it, expect } from 'vitest';
import {
  RuleEngineError,
  InvalidInputError,
  MissingTransaction,
  MissingContext,
  InvalidTransaction,
  ConditionEvalError,
  InvalidRegex,
  InvalidNumericValue,
  InvalidDateValue,
  UnsupportedConditionError,
  UnknownConditionTypeError,
} from '../errors';

describe('RuleEngineError', () => {
  it('is an Error subclass', () => {
    const err = new RuleEngineError('msg', 'ERR');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RuleEngineError);
  });

  it('has code and details properties', () => {
    const err = new RuleEngineError('msg', 'ERR_TEST', { foo: 'bar' });
    expect(err.code).toBe('ERR_TEST');
    expect(err.details).toEqual({ foo: 'bar' });
  });
});

describe('InvalidInputError hierarchy', () => {
  it('MissingTransaction has correct code', () => {
    const err = new MissingTransaction();
    expect(err.code).toBe('ERR_MISSING_TRANSACTION');
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err).toBeInstanceOf(RuleEngineError);
  });

  it('MissingContext has correct code', () => {
    const err = new MissingContext();
    expect(err.code).toBe('ERR_MISSING_CONTEXT');
  });

  it('InvalidTransaction has correct code', () => {
    const err = new InvalidTransaction();
    expect(err.code).toBe('ERR_INVALID_TRANSACTION');
  });
});

describe('ConditionEvalError hierarchy', () => {
  it('InvalidRegex has correct code and conditionType', () => {
    const err = new InvalidRegex('description_matches', { pattern: '[invalid' });
    expect(err.code).toBe('ERR_INVALID_REGEX');
    expect(err.conditionType).toBe('description_matches');
    expect(err).toBeInstanceOf(ConditionEvalError);
    expect(err).toBeInstanceOf(RuleEngineError);
  });

  it('InvalidNumericValue has correct code and conditionType', () => {
    const err = new InvalidNumericValue('amount_gt', { value: 'abc' });
    expect(err.code).toBe('ERR_INVALID_NUMERIC');
    expect(err.conditionType).toBe('amount_gt');
  });

  it('InvalidDateValue has correct code and conditionType', () => {
    const err = new InvalidDateValue('date_before');
    expect(err.code).toBe('ERR_INVALID_DATE');
    expect(err.conditionType).toBe('date_before');
  });

  it('UnsupportedConditionError has correct code and conditionType', () => {
    const err = new UnsupportedConditionError('entity_eq');
    expect(err.code).toBe('ERR_UNSUPPORTED_CONDITION');
    expect(err.conditionType).toBe('entity_eq');
  });

  it('UnknownConditionTypeError has correct code and conditionType', () => {
    const err = new UnknownConditionTypeError('foo_bar' as any);
    expect(err.code).toBe('ERR_UNKNOWN_CONDITION_TYPE');
    expect(err.conditionType).toBe('foo_bar');
  });
});
