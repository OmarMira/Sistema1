import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BankAccountRequiredError,
  MathMismatchError,
} from '@/lib/api-error';

describe('AppError (base)', () => {
  it('creates an error with statusCode, message, code, and details', () => {
    const err = new AppError(418, 'Custom error', 'TEAPOT', { extra: 'info' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe('Custom error');
    expect(err.code).toBe('TEAPOT');
    expect(err.details).toEqual({ extra: 'info' });
    expect(err.name).toBe('AppError');
  });

  it('allows optional code and details', () => {
    const err = new AppError(500, 'Server error');
    expect(err.code).toBeUndefined();
    expect(err.details).toBeUndefined();
  });

  it('captures stack trace', () => {
    const err = new AppError(400, 'Test');
    expect(err.stack).toBeDefined();
  });

  it('serializes to JSON via spread includes enumerable fields', () => {
    const err = new AppError(400, 'bad request', 'BAD_REQUEST', { field: 'name' });
    const { message, ...rest } = err;
    // `message` is own-property via Error.captureStackTrace but non-enumerable in some engines
    expect(err.message).toBe('bad request');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.details).toEqual({ field: 'name' });
    // JSON.stringify on Error only captures enumerable own properties
    const json = JSON.parse(JSON.stringify(err));
    expect(json.statusCode).toBe(400);
    expect(json.code).toBe('BAD_REQUEST');
    expect(json.details).toEqual({ field: 'name' });
  });
});

describe('ValidationError', () => {
  it('has 400 statusCode and VALIDATION_ERROR code', () => {
    const err = new ValidationError('Invalid input');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid input');
    expect(err.name).toBe('ValidationError');
  });

  it('accepts optional details', () => {
    const err = new ValidationError('Invalid', { fields: ['email'] });
    expect(err.details).toEqual({ fields: ['email'] });
  });
});

describe('AuthError', () => {
  it('has 401 statusCode and UNAUTHORIZED code', () => {
    const err = new AuthError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Unauthorized');
    expect(err.name).toBe('AuthError');
  });

  it('accepts custom message', () => {
    const err = new AuthError('Token expired');
    expect(err.message).toBe('Token expired');
  });
});

describe('ForbiddenError', () => {
  it('has 403 statusCode and FORBIDDEN code', () => {
    const err = new ForbiddenError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('Access denied');
    expect(err.name).toBe('ForbiddenError');
  });
});

describe('NotFoundError', () => {
  it('has 404 statusCode and NOT_FOUND code', () => {
    const err = new NotFoundError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Resource not found');
    expect(err.name).toBe('NotFoundError');
  });
});

describe('ConflictError', () => {
  it('has 409 statusCode and CONFLICT code', () => {
    const err = new ConflictError('Duplicate entry');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('Duplicate entry');
    expect(err.name).toBe('ConflictError');
  });
});

describe('BankAccountRequiredError', () => {
  const metadata = {
    bankName: 'Test Bank',
    accountNo: '12345',
    openingBalance: 1000,
    currency: 'USD',
  };

  it('has 400 statusCode and BANK_CREATION_REQUIRED code', () => {
    const err = new BankAccountRequiredError(metadata);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(BankAccountRequiredError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BANK_CREATION_REQUIRED');
    expect(err.message).toBe('Se requiere crear la cuenta bancaria.');
    expect(err.name).toBe('BankAccountRequiredError');
  });

  it('stores metadata in details', () => {
    const err = new BankAccountRequiredError(metadata);
    expect(err.details).toEqual(metadata);
  });

  it('accepts null accountNo', () => {
    const err = new BankAccountRequiredError({ ...metadata, accountNo: null });
    expect(err.details).toHaveProperty('accountNo', null);
  });
});

describe('MathMismatchError', () => {
  const metadata = {
    transactions: [{ id: 'tx1', amount: 100 }],
    mismatch: 50,
  };

  it('has 400 statusCode and MATH_MISMATCH code', () => {
    const err = new MathMismatchError('Math check failed', metadata);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(MathMismatchError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('MATH_MISMATCH');
    expect(err.message).toBe('Math check failed');
    expect(err.name).toBe('MathMismatchError');
  });

  it('stores transactions and mismatch in details', () => {
    const err = new MathMismatchError('Fail', metadata);
    expect(err.details).toEqual(metadata);
  });
});
