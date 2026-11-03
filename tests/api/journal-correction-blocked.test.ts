import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * S24 — ADAPTED CONTRACT (was: "public hold").
 *
 * The previous version of this suite pinned the unconditional 503 hold
 * ("Correction unavailable until isolated accounting integrity tests are
 * approved"). S24 removed that hold: the JournalCorrection flow is enabled
 * behind company_admin once its blockers were resolved (schema model present,
 * service typed, guards + integration coverage added in
 * tests/api/journal-correction-enabled.test.ts).
 *
 * This suite now pins the inverted invariant it was created to protect: NO
 * environment variable, NODE_ENV or request body can bring the hold back —
 * an authorized company_admin request always reaches the real handler.
 */

const mocks = vi.hoisted(() => ({
  middleware: vi.fn(),
  entry: vi.fn(),
  user: vi.fn(),
  transaction: vi.fn(),
  correction: vi.fn(),
  audit: vi.fn(),
  fiscal: vi.fn(),
  linkedBankTx: vi.fn(),
  glAccounts: vi.fn(),
  role: vi.fn(),
  tenant: vi.fn(),
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
    bankTransaction: { findFirst: mocks.linkedBankTx },
    glAccount: { findMany: mocks.glAccounts },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/context-storage', () => ({ requireCurrentUserId: () => 'test-user' }));
vi.mock('@/lib/module-entitlement-guard', () => ({ assertCompanyModuleEntitlement: vi.fn() }));
vi.mock('@/lib/rbac', () => ({
  requireActiveTenantAccess: mocks.tenant,
  requireCompanyRole: mocks.role,
}));
vi.mock('@/lib/fiscal-period-guard', () => ({ assertActiveFiscalPeriod: mocks.fiscal }));
vi.mock('@/lib/services/journal-correction.service', () => ({
  JournalCorrectionService: { applyCorrection: mocks.correction },
}));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: mocks.audit }));

import { POST } from '@/app/api/journal/[id]/corregir/route';

describe('journal correction — the 503 hold is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entry.mockResolvedValue({
      id: 'original',
      companyId: 'test-company',
      status: 'posted',
      lines: [
        { glAccountId: 'expense', debit: 1000, credit: 0 },
        { glAccountId: 'cash', debit: 0, credit: 1000 },
      ],
    });
    mocks.user.mockResolvedValue({ platformRole: 'user' });
    mocks.linkedBankTx.mockResolvedValue(null);
    mocks.glAccounts.mockResolvedValue([{ id: 'expense' }, { id: 'cash' }]);
    mocks.transaction.mockImplementation((callback) => callback({}));
    mocks.correction.mockResolvedValue({
      counterEntry: { id: 'counter' },
      replacementEntry: { id: 'replacement' },
      correctionId: 'correction',
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['production', 'development', 'test'])(
    'authorized correction runs end-to-end in %s (never 503)',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const request = new NextRequest('http://localhost/api/journal/original/corregir?companyId=test-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correctionDate: '2026-10-25',
          reason: 'Correct amount',
          correctedLines: [
            { glAccountId: 'expense', debit: 800, credit: 0 },
            { glAccountId: 'cash', debit: 0, credit: 800 },
          ],
        }),
      });
      const response = await POST(request, { params: Promise.resolve({ id: 'original' }) });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.blocked).toBeUndefined();
      expect(body).toEqual({
        originalEntryId: 'original',
        counterEntryId: 'counter',
        replacementEntryId: 'replacement',
        correctionId: 'correction',
        message: 'Correction applied successfully',
      });

      // The handler performs the full accounting-critical sequence.
      expect(mocks.middleware).toHaveBeenCalledTimes(1);
      expect(mocks.tenant).toHaveBeenCalledTimes(1);
      expect(mocks.role).toHaveBeenCalledTimes(1);
      expect(mocks.fiscal).toHaveBeenCalled();
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.correction).toHaveBeenCalledTimes(1);
      expect(mocks.audit).toHaveBeenCalledTimes(1);
    },
  );
});
