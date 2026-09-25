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
  isReconciled: false,
  bankAccountId: 'bank-1',
  bankAccountName: 'Bank One',
};

const TX_RECONCILED = {
  ...TX_A,
  id: 'tx-rec',
  description: 'RECONCILED NO-GL TX',
  isReconciled: true,
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

  // ─── RECONCILED-UNCLASSIFIED-001 (T7/T8) ─────────────────────────

  it('T7: a reconciled uncategorized transaction is rendered in the review queue', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_RECONCILED]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('RECONCILED NO-GL TX')).toBeInTheDocument();
    });
  });

  it('T8: the reconciled transaction shows the explicit Reconciled signal', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_RECONCILED]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('reconciled-badge-tx-rec')).toBeInTheDocument();
    });
    expect(tFn).toHaveBeenCalledWith('importReview.reconciled');
  });

  it('T8b: an unreconciled queue entry shows no reconciled badge', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('reconciled-badge-tx-a')).not.toBeInTheDocument();
  });

  // ─── S10 POST-1B.2B.2 §13 — Host integration (H1–H4) ─────────────

  const AI_PROPOSAL_FOR_A = {
    approvalId: 'approval-a',
    requestedBy: 'ai-agent',
    requestedAt: '2026-01-15T10:00:00.000Z',
    bankAccountId: 'bank-1',
    deterministicResult: null,
    aiProposal: { role: 'expense', glAccountCode: '5.1.1', glAccountId: 'gl-b' },
    proposedEntity: null,
    proposedGlAccount: { id: 'gl-b', code: '5.1.1', name: 'Office Expense' },
    transaction: {
      id: 'tx-a',
      importHash: 'hash-a',
      date: '2026-01-15T00:00:00.000Z',
      amount: -500,
      description: 'ABC 777 ENTITY-1',
    },
  };

  function withProposalSection(proposals: typeof AI_PROPOSAL_FOR_A[]) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url.includes('/api/import/ai-proposals') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ decision: 'ACCEPT' }) };
      }
      if (url.includes('/api/import/ai-proposals')) {
        return { ok: true, status: 200, json: async () => ({ proposals }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  }

  it('H1: the legacy queue requests the company-scoped URL and AiProposalSection is integrated in the productive host', async () => {
    withProposalSection([]);
    renderDialog();
    await waitFor(() => {
      const queueCall = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes('/api/transactions?classificationStatus=uncategorized'),
      );
      expect(queueCall).toBeDefined();
      expect(String(queueCall![0])).toBe(
        '/api/transactions?classificationStatus=uncategorized&companyId=company-1',
      );
    });
    // The productive host mounts the proposal section.
    await waitFor(() => {
      expect(screen.getByTestId('ai-proposals-empty')).toBeInTheDocument();
    });
  });

  it('H2: a row with an active proposal is marked pending and the legacy PATCH action is not offered', async () => {
    withProposalSection([AI_PROPOSAL_FOR_A]);
    const user = userEvent.setup();
    renderDialog();
    // Row exists (queue) and the section reports the pending proposal.
    await waitFor(() => {
      expect(screen.getByTestId('review-row-tx-a')).toBeInTheDocument();
      expect(screen.getByTestId('proposal-pending-badge-tx-a')).toBeInTheDocument();
    });
    const row = screen.getByTestId('review-row-tx-a');
    expect(row).toHaveAttribute('data-proposal-pending', 'true');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    // Clicking the pending row never opens the legacy PATCH panel.
    await user.click(row);
    expect(screen.queryByTestId('confirm-classify-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gl-account-select')).not.toBeInTheDocument();
    // No PATCH was ever attempted.
    const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH');
    expect(patchCalls).toHaveLength(0);
  });

  it('H3: a row WITHOUT a pending proposal keeps the exact legacy PATCH flow', async () => {
    withProposalSection([AI_PROPOSAL_FOR_A]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/transactions?classificationStatus=uncategorized')) return mockQueueResponse([TX_A]);
      if (url.includes('/api/journal/accounts')) return mockAccountsResponse();
      if (url.includes('/api/import/ai-proposals')) {
        return { ok: true, status: 200, json: async () => ({ proposals: [] }) };
      }
      if (url === '/api/transactions/tx-a' && init?.method === 'PATCH') return mockPatchOk();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
      expect(screen.getByTestId('ai-proposals-empty')).toBeInTheDocument();
    });
    const row = screen.getByTestId('review-row-tx-a');
    expect(row).toHaveAttribute('data-proposal-pending', 'false');
    // Legacy flow end-to-end: select → account → confirm → PATCH.
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
      expect(JSON.parse(patchCall![1].body as string)).toEqual({ glAccountId: 'gl-a' });
    });
  });

  it('H4: onProposalResolved re-fetches the queue without any second reclassification or PATCH', async () => {
    withProposalSection([AI_PROPOSAL_FOR_A]);
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument();
      expect(screen.getByTestId('review-row-tx-a')).toBeInTheDocument();
    });
    const queueCallsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('classificationStatus=uncategorized'),
    ).length;
    const patchCallsBefore = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH').length;
    // Resolve the proposal through the certified POST only.
    await user.click(screen.getByTestId('ai-accept-btn'));
    // Host re-queries the queue (server-authoritative refresh)…
    await waitFor(() => {
      const queueCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('classificationStatus=uncategorized'),
      );
      expect(queueCalls.length).toBeGreaterThan(queueCallsBefore);
    });
    // …and performs no second reclassification: no PATCH at any point.
    const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH');
    expect(patchCalls.length).toBe(patchCallsBefore);
    expect(patchCallsBefore).toBe(0);
    // The mutating authority used was the proposal POST, not transactions.
    const proposalPosts = fetchMock.mock.calls.filter(
      (c) => c[1]?.method === 'POST' && String(c[0]).includes('/api/import/ai-proposals'),
    );
    expect(proposalPosts).toHaveLength(1);
  });
});
