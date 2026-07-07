import { AsyncLocalStorage } from 'async_hooks';
import { AppError } from './api-error';

interface RequestContext {
  userId: string;
  companyId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function requireCompanyContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx?.companyId) {
    throw new AppError(
      403,
      'Company context required. Select a company first.',
      'COMPANY_CONTEXT_REQUIRED',
    );
  }
  return ctx;
}

export function requireCurrentUserId(): string {
  const ctx = requestContext.getStore();
  if (!ctx?.userId) {
    throw new AppError(401, 'Authentication required', 'AUTH_REQUIRED');
  }
  return ctx.userId;
}
