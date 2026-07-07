export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, 'VALIDATION_ERROR', details);
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(403, message, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(404, message, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

export class BankAccountRequiredError extends AppError {
  constructor(metadata: {
    bankName: string;
    accountNo: string | null;
    openingBalance: number;
    currency: string;
  }) {
    super(400, 'Se requiere crear la cuenta bancaria.', 'BANK_CREATION_REQUIRED', metadata);
  }
}

export class MathMismatchError extends AppError {
  constructor(
    message: string,
    metadata: {
      transactions: Record<string, unknown>[];
      mismatch: number;
    },
  ) {
    super(400, message, 'MATH_MISMATCH', metadata);
  }
}
