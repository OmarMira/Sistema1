import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  middleware: vi.fn(),
  entry: vi.fn(),
  user: vi.fn(),
  transaction: vi.fn(),
  correction: vi.fn(),
  audit: vi.fn(),
  fiscal: vi.fn(),
}));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: (...args: any[]) => unknown) => (...args: any[]) => {
    mocks.middleware();
    return handler(...args);
  },
}));
vi.mock('@/lib/db', () => ({
  db: {
    journalEntry: { findUnique: mocks.entry },
    user: { findUnique: mocks.user },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/context-storage', () => ({ requireCurrentUserId: () => 'test-user' }));
vi.mock('@/lib/module-entitlement-guard', () => ({ assertCompanyModuleEntitlement: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ requireActiveTenantAccess: vi.fn(), requireCompanyRole: vi.fn() }));
vi.mock('@/lib/fiscal-period-guard', () => ({ assertActiveFiscalPeriod: mocks.fiscal }));
vi.mock('@/lib/services/journal-correction.service', () => ({
  JournalCorrectionService: { applyCorrection: mocks.correction },
}));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: mocks.audit }));

import { POST } from '@/app/api/journal/[id]/corregir/route';

describe('journal correction public hold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entry.mockResolvedValue({ id: 'original', companyId: 'test-company', status: 'posted', lines: [] });
    mocks.user.mockResolvedValue({ platformRole: 'user' });
    mocks.transaction.mockImplementation((callback) => callback({}));
    mocks.correction.mockResolvedValue({
      counterEntry: { id: 'counter' }, replacementEntry: { id: 'replacement' }, correctionId: 'correction',
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['production', 'development', 'test'])('blocks POST before any database work in %s', async (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    const request = new NextRequest('http://localhost/api/journal/original/corregir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        correctionDate: '2026-10-25', reason: 'Correct amount',
        correctedLines: [
          { glAccountId: 'expense', debit: 800, credit: 0 },
          { glAccountId: 'cash', debit: 0, credit: 800 },
        ],
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'original' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      blocked: true,
      message: 'Correction unavailable until isolated accounting integrity tests are approved.',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    for (const spy of Object.values(mocks)) expect(spy).not.toHaveBeenCalled();
  });
});
