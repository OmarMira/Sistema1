import type { RuleConditionType } from './types';

export class RuleEngineError extends Error {
  public readonly code: string;
  public readonly details: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidInputError extends RuleEngineError {
  constructor(message: string, code: string, details?: unknown) {
    super(message, code, details);
  }
}

export class MissingTransaction extends InvalidInputError {
  constructor(details?: unknown) {
    super('Transaction is missing or null', 'ERR_MISSING_TRANSACTION', details);
  }
}

export class MissingContext extends InvalidInputError {
  constructor(details?: unknown) {
    super('Context is missing, null, or missing availableRules', 'ERR_MISSING_CONTEXT', details);
  }
}

export class InvalidTransaction extends InvalidInputError {
  constructor(details?: unknown) {
    super('Transaction validation failed', 'ERR_INVALID_TRANSACTION', details);
  }
}

export class ConditionEvalError extends RuleEngineError {
  public readonly conditionType: RuleConditionType;

  constructor(message: string, code: string, conditionType: RuleConditionType, details?: unknown) {
    super(message, code, details);
    this.conditionType = conditionType;
  }
}

export class InvalidRegex extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown) {
    super(`Invalid regex pattern for ${conditionType}`, 'ERR_INVALID_REGEX', conditionType, details);
  }
}

export class InvalidNumericValue extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown) {
    super(`Invalid numeric value for ${conditionType}`, 'ERR_INVALID_NUMERIC', conditionType, details);
  }
}

export class InvalidDateValue extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown) {
    super(`Invalid date value for ${conditionType}`, 'ERR_INVALID_DATE', conditionType, details);
  }
}

export class UnsupportedConditionError extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown) {
    super(`Condition ${conditionType} is not implemented in this version`, 'ERR_UNSUPPORTED_CONDITION', conditionType, details);
  }
}

export class UnknownConditionTypeError extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown) {
    super(`Unknown condition type: ${conditionType}`, 'ERR_UNKNOWN_CONDITION_TYPE', conditionType, details);
  }
}
