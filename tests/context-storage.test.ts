import { describe, it, expect } from 'vitest';
import {
  requestContext,
  getRequestContext,
  requireCompanyContext,
  requireCurrentUserId,
} from '@/lib/context-storage';
import { AppError } from '@/lib/api-error';

describe('getRequestContext', () => {
  it('returns undefined outside of a context', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('returns the context inside requestContext.run()', () => {
    const ctx = { userId: 'user-1', companyId: 'company-1' };
    requestContext.run(ctx, () => {
      expect(getRequestContext()).toEqual(ctx);
    });
  });
});

describe('requireCompanyContext', () => {
  it('throws AppError with 403 outside of a context', () => {
    expect(() => requireCompanyContext()).toThrow(AppError);
    try {
      requireCompanyContext();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(403);
      expect((e as AppError).code).toBe('COMPANY_CONTEXT_REQUIRED');
    }
  });

  it('throws AppError with 403 when companyId is missing inside context', () => {
    requestContext.run({ userId: 'user-1', companyId: '' }, () => {
      expect(() => requireCompanyContext()).toThrow(AppError);
      try {
        requireCompanyContext();
      } catch (e) {
        expect((e as AppError).statusCode).toBe(403);
      }
    });
  });

  it('returns context when companyId is present', () => {
    requestContext.run({ userId: 'user-1', companyId: 'company-1' }, () => {
      const ctx = requireCompanyContext();
      expect(ctx.companyId).toBe('company-1');
      expect(ctx.userId).toBe('user-1');
    });
  });
});

describe('requireCurrentUserId', () => {
  it('throws AppError with 401 outside of a context', () => {
    expect(() => requireCurrentUserId()).toThrow(AppError);
    try {
      requireCurrentUserId();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(401);
      expect((e as AppError).code).toBe('AUTH_REQUIRED');
    }
  });

  it('throws AppError with 401 when userId is missing inside context', () => {
    requestContext.run({ userId: '', companyId: 'company-1' }, () => {
      expect(() => requireCurrentUserId()).toThrow(AppError);
      try {
        requireCurrentUserId();
      } catch (e) {
        expect((e as AppError).statusCode).toBe(401);
      }
    });
  });

  it('returns userId when present', () => {
    requestContext.run({ userId: 'user-1', companyId: 'company-1' }, () => {
      const uid = requireCurrentUserId();
      expect(uid).toBe('user-1');
    });
  });
});

describe('nested contexts', () => {
  it('supports nested requestContext.run with different values', () => {
    requestContext.run({ userId: 'outer', companyId: 'outer-c' }, () => {
      expect(requireCurrentUserId()).toBe('outer');
      expect(requireCompanyContext().companyId).toBe('outer-c');

      requestContext.run({ userId: 'inner', companyId: 'inner-c' }, () => {
        expect(requireCurrentUserId()).toBe('inner');
        expect(requireCompanyContext().companyId).toBe('inner-c');
      });

      // After inner completes, outer should restore
      expect(requireCurrentUserId()).toBe('outer');
    });
  });
});
