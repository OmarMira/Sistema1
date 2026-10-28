import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ImportAiError } from '@/lib/ai-import-error';
import { POST as validate } from '@/app/api/import/validate/route';
import { POST as importFile } from '@/app/api/import/route';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(), writes: vi.fn(), holder: vi.fn(),
  company: vi.fn(async () => ({ legalName: 'Synthetic Company' })),
}));
vi.mock('@/lib/pdf-processor', () => ({ parsePDFAsync: mocks.parse }));
vi.mock('@/lib/db', () => ({ db: {
  user: { findUnique: vi.fn(async () => ({ platformRole: 'super_admin' })) },
  company: { findUnique: mocks.company },
  bankAccount: { create: mocks.writes, findFirst: mocks.writes },
  bankStatement: { create: mocks.writes }, bankTransaction: { createMany: mocks.writes },
  $transaction: mocks.writes,
} }));
vi.mock('@/lib/sessions', () => ({ getSessionUserId: vi.fn(async () => 'synthetic-user') }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: 'synthetic-user', companyId: 'synthetic-company' }),
  requestContext: { run: (_ctx: unknown, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/rbac', () => ({ requireActiveTenantAccess: vi.fn(), requireCompanyRole: vi.fn() }));
vi.mock('@/lib/module-entitlement-guard', () => ({ requireModuleEntitlement: vi.fn() }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: () => ({ allowed: true, limit: 100, remaining: 99, resetAt: 10 }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/metrics', () => ({ trackAPIResponseTime: vi.fn(), trackPDFParseDuration: vi.fn() }));
vi.mock('@/lib/validation/account-holder-validator', () => ({ validateAccountHolder: mocks.holder, isStrictModeEnabled: () => false }));
vi.mock('@/lib/services/journal-entry.service', () => ({ JournalEntryService: {} }));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: vi.fn() }));
vi.mock('@/lib/fiscal-period-guard', () => ({ assertActiveFiscalPeriod: vi.fn() }));

function request(endpoint: string, plural = false, extension = 'pdf') {
  const body = new FormData();
  body.append('companyId', 'synthetic-company');
  body.append(plural ? 'files' : 'file', new File([extension === 'pdf' ? '%PDF-1.7 synthetic' : 'date,description,amount'], `synthetic.${extension}`, { type: extension === 'pdf' ? 'application/pdf' : 'text/csv' }));
  return new NextRequest(`http://localhost/api/import${endpoint}`, { method: 'POST', body });
}
const context = { params: Promise.resolve({}) };

beforeEach(() => { vi.clearAllMocks(); });

describe('AI failures survive the public import endpoints without financial writes', () => {
  it.each(['AI_CONFIG_MISSING', 'AI_PROVIDER_UNAVAILABLE'] as const)('returns safe typed %s from PDF holder validation', async (code) => {
    const failure = new ImportAiError(code);
    mocks.parse.mockRejectedValue(failure);
    const response = await validate(request('/validate', true), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: failure.message, code });
    expect(mocks.holder).not.toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('returns missing configuration from import instead of wrapping it as invalid PDF', async () => {
    const failure = new ImportAiError('AI_CONFIG_MISSING');
    mocks.parse.mockRejectedValue(failure);
    const response = await importFile(request(''), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: failure.message, code: 'AI_CONFIG_MISSING' });
    expect(mocks.company).not.toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('preserves the existing non-PDF holder-validation result without AI', async () => {
    const response = await validate(request('/validate', true, 'csv'), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{
      fileName: 'synthetic.csv', extension: 'csv', extractedHolder: 'N/A', companyName: 'Synthetic Company',
      score: 1, matches: true, requiresApproval: false,
    }], strictMode: false });
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });
});
