// TX-REVIEW-UI-001 — UI tests (T8–T18)
// UncategorizedReviewDialog: queue display, GL selection via existing
// AccountSelector, PATCH wiring, server-authoritative refresh, error handling.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UncategorizedReviewDialog } from '../../src/components/import/UncategorizedReviewDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const tFn = vi.fn((key: string) => key);
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn }),
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector({ activeCompany: { id: 'company-1' } }),
}));

// AccountSelector uses a Popover/Command pattern — mock to a native select.
vi.mock('@/components/spa/journal/AccountSelector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/spa/journal/AccountSelector')>();
  type Option = { id: string; code: string; name: string; accountType: string; normalBalance: string };
  return {
    ...actual,
    AccountSelector: ({
      accounts,
      value,
      onChange,
    }: {
      accounts: Option[];
      value: string | null;
      onChange: (id: string | null) => void;
    }) => (
      <select data-testid="gl-account-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">--</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name}
          </option>
        ))}
      </select>
    ),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const fetchMock = vi.fn();

const TX_A = {
  id: 'tx-a',
  date: '2026-01-15T00:00:00.000Z',
  description: 'ABC 777 ENTITY-1',
  amount: -500,
  direction: 'debit',
  glAccountId: null,
  bankAccountId: 'bank-1',
  bankAccountName: 'Bank One',
};

function mockQueueResponse(transactions: typeof TX_A[]) {
  return { ok: true, json: async () => ({ transactions }) };
}

function mockAccountsResponse() {
  return {
    ok: true,
    json: async () => ({
      accounts: [
        { id: 'gl-a', code: '1.1.1', name: 'Cash', accountType: 'asset', normalBalance: 'debit' },
        { id: 'gl-b', code: '5.1.1', name: 'Office Expense', accountType: 'expense', normalBalance: 'debit' },
      ],
    }),
  };
}

function mockPatchOk() {
  return { ok: true, status: 200, json: async () => ({ transaction: { id: 'tx-a' } }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([]);
    if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
});

function renderDialog() {
  return render(<UncategorizedReviewDialog open={true} onOpenChange={vi.fn()} />);
}

describe('TX-REVIEW-UI-001 — UncategorizedReviewDialog (T8–T18)', () => {
  it('T8: the review queue is displayed', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
  });

  it('T9: empty queue shows the empty state', async () => {
    renderDialog();
    await waitFor(() => {
      expect(tFn).toHaveBeenCalledWith('importReview.empty');
    });
  });

  it('T10: a transaction is selectable', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await waitFor(() => {
      expect(screen.getByTestId('gl-account-select')).toBeInTheDocument();
    });
  });

  it('T11+T12: GL accounts come from the existing source and can be selected', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await waitFor(() => {
      expect(screen.getByTestId('gl-account-select')).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    expect((screen.getByTestId('gl-account-select') as HTMLSelectElement).value).toBe('gl-a');
  });

  it('T13+T14: confirmation calls the REAL PATCH /api/transactions/[id] with its contract payload', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url === '/api/transactions/tx-a' && init?.method === 'PATCH') return mockPatchOk();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await waitFor(() => {
      expect(screen.getByTestId('gl-account-select')).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    await user.click(screen.getByTestId('confirm-classify-btn'));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/transactions/tx-a' && c[1]?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body as string);
      // Contract: ONLY { glAccountId } — no companyId/userId/learning fields.
      expect(Object.keys(body)).toEqual(['glAccountId']);
      expect(body.glAccountId).toBe('gl-a');
    });
  });

  it('T15: success removes the transaction from the queue (server-authoritative)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url === '/api/transactions/tx-a' && init?.method === 'PATCH') return mockPatchOk();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    await user.click(screen.getByTestId('confirm-classify-btn'));
    await waitFor(() => {
      expect(screen.queryByText('ABC 777 ENTITY-1')).not.toBeInTheDocument();
    });
  });

  it('T16: PATCH error keeps the transaction visible and does not appear as success', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url === '/api/transactions/tx-a' && init?.method === 'PATCH') {
        return { ok: false, status: 409, json: async () => ({ error: 'locked' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    await user.click(screen.getByTestId('confirm-classify-btn'));
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalled();
  });

  it('T17: submitting prevents double submission', async () => {
    let resolvePatch: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url === '/api/transactions/tx-a' && init?.method === 'PATCH') {
        return new Promise((resolve) => {
          resolvePatch = resolve;
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    await user.click(screen.getByTestId('confirm-classify-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-classify-btn')).toBeDisabled();
    });
    resolvePatch?.(mockPatchOk());
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-classify-btn')).not.toBeInTheDocument();
    });
  });

  it('T18: the UI never calls the KE learning loop directly', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url === '/api/transactions/tx-a' && init?.method === 'PATCH') return mockPatchOk();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    await user.click(screen.getByText('ABC 777 ENTITY-1'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    await user.click(screen.getByTestId('confirm-classify-btn'));
    await waitFor(() => {
      expect(screen.queryByText('ABC 777 ENTITY-1')).not.toBeInTheDocument();
    });
    // Every fetch went to the queue, accounts source, or the PATCH — no
    // learning/classification-write endpoints were ever touched.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const forbidden = urls.filter(
      (u) =>
        u.includes('/api/learning/') ||
        /\/api\/transactions\/[a-z0-9-]+\/(resolve|rehabilitate)/.test(u) ||
        u.includes('/api/memory'),
    );
    expect(forbidden).toEqual([]);
  });
});
