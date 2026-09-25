// S10 POST-1B.2B.2 §12 — AiProposalSection direct contract tests (T1–T17).
// Proves the AI proposal human-decision surface: GET/POST ?companyId=,
// exact ACCEPT/CORRECT/REJECT bodies, identity never pre-filled, error
// handling without optimistic removal, anti-double-submit, no legacy
// mutation authority (no PATCH /api/transactions/*, no KE, no direct
// PendingApproval), and stable parent-callback identity.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { AiProposalSection } from '../../src/components/import/AiProposalSection';

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

const GET_URL = '/api/import/ai-proposals?companyId=company-1';

const ACCOUNTS = [
  { id: 'gl-a', code: '1.1.1', name: 'Cash', accountType: 'asset', normalBalance: 'debit' },
  { id: 'gl-b', code: '5.1.1', name: 'Office Expense', accountType: 'expense', normalBalance: 'debit' },
];

// Base fixture. aiProposal deliberately carries confidence/reasoning-like
// fields: the UI must NOT render them (T6/T7).
const PROPOSAL = {
  approvalId: 'approval-1',
  requestedBy: 'ai-agent',
  requestedAt: '2026-01-15T10:00:00.000Z',
  bankAccountId: 'bank-1',
  deterministicResult: null,
  aiProposal: {
    role: 'expense',
    glAccountCode: '5.1.1',
    glAccountId: 'gl-b',
    confidence: 0.97,
    reasoning: 'Merchant matches recurring office-expense pattern',
  },
  proposedEntity: null,
  proposedGlAccount: { id: 'gl-b', code: '5.1.1', name: 'Office Expense' },
  transaction: {
    id: 'tx-1',
    importHash: 'hash-1',
    date: '2026-01-15T00:00:00.000Z',
    amount: -123.45,
    description: 'AMAZON WEB SERVICES',
  },
};

// Fixture with a proposed entity (shown as information only — T8).
const PROPOSAL_ENTITY = {
  ...PROPOSAL,
  approvalId: 'approval-entity',
  proposedEntity: { canonicalName: 'Amazon Web Services', entityType: 'company' },
  transaction: { ...PROPOSAL.transaction, id: 'tx-entity' },
};

function proposal(item: Partial<typeof PROPOSAL> & { approvalId: string; transactionId: string }) {
  return {
    ...PROPOSAL,
    approvalId: item.approvalId,
    transaction: { ...PROPOSAL.transaction, id: item.transactionId },
  };
}

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const fail = (status: number, error?: string) => ({
  ok: false,
  status,
  json: async () => (error !== undefined ? { error } : {}),
});

function postCalls() {
  return fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');
}

function getCalls() {
  return fetchMock.mock.calls.filter((c) => String(c[0]) === GET_URL && !c[1]?.method);
}

function renderSection(props: Partial<React.ComponentProps<typeof AiProposalSection>> = {}) {
  return render(
    <AiProposalSection companyId="company-1" accounts={ACCOUNTS} {...props} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
    return fail(404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('S10 §12 — AiProposalSection (T1–T17)', () => {
  it('T1: GET uses /api/import/ai-proposals?companyId=company-1', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(GET_URL);
    // No method/init argument — a plain GET.
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(GET_URL);
  });

  it('T2: loading state is shown while the GET is in flight', async () => {
    let release: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderSection();
    expect(screen.getByTestId('ai-proposals-loading')).toBeInTheDocument();
    release?.(ok({ proposals: [] }));
    await waitFor(() => expect(screen.getByTestId('ai-proposals-empty')).toBeInTheDocument());
  });

  it('T3: GET error shows the error state and retry re-executes the GET', async () => {
    let first = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === GET_URL) {
        if (first) {
          first = false;
          return fail(500);
        }
        return ok({ proposals: [] });
      }
      return fail(404);
    });
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposals-error')).toBeInTheDocument());
    expect(screen.getByTestId('ai-proposals-retry')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('ai-proposals-retry'));
    await waitFor(() => expect(screen.getByTestId('ai-proposals-empty')).toBeInTheDocument());
    expect(getCalls()).toHaveLength(2);
  });

  it('T4: empty state when proposals=[]', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === GET_URL ? ok({ proposals: [] }) : fail(404),
    );
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposals-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-proposal-section')).not.toBeInTheDocument();
  });

  it('T5: loaded state shows description, date, amount, proposed GL code+name and role', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    // Description
    expect(screen.getByText('AMAZON WEB SERVICES')).toBeInTheDocument();
    // Date + amount (same rendering rules as the component)
    const expectedLine = `${new Date(PROPOSAL.transaction.date).toLocaleDateString()} · ${PROPOSAL.transaction.amount.toFixed(2)}`;
    expect(screen.getByText(expectedLine)).toBeInTheDocument();
    // proposedGlAccount.code + name
    expect(screen.getByTestId('ai-proposed-account')).toHaveTextContent('5.1.1 Office Expense');
    // aiProposal.role when present
    expect(screen.getByTestId('ai-proposal-role')).toHaveTextContent('expense');
  });

  it('T6: confidence is never rendered nor invented', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText('0.97')).not.toBeInTheDocument();
  });

  it('T7: reasoning is never rendered nor invented', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    expect(screen.queryByText(/reasoning/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText('Merchant matches recurring office-expense pattern'),
    ).not.toBeInTheDocument();
  });

  it('T8: proposedEntity may be shown as information, but CORRECT never pre-fills or pre-confirms identity', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === GET_URL ? ok({ proposals: [PROPOSAL_ENTITY] }) : fail(404),
    );
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    // Shown as information only.
    expect(screen.getByTestId('ai-proposed-entity')).toHaveTextContent('Amazon Web Services');
    // Open CORRECT.
    await user.click(screen.getByTestId('ai-correct-btn'));
    expect(screen.getByTestId('ai-correct-form')).toBeInTheDocument();
    // Identity is NOT automatically confirmed.
    expect(screen.getByTestId('ai-identity-toggle')).not.toBeChecked();
    // Identity input is not pre-filled from proposedEntity.
    expect(screen.queryByTestId('ai-canonical-name')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('ai-identity-toggle'));
    expect(screen.getByTestId('ai-canonical-name')).toHaveValue('');
  });

  it('T9: ACCEPT sends exactly ONE POST with the exact body and nothing else', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return ok({ decision: 'ACCEPT' });
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-accept-btn'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    // Exact URL, exact body — no glAccountId, no confirmedEntity.
    expect(postCalls()[0][0]).toBe(GET_URL);
    expect(JSON.parse(postCalls()[0][1].body as string)).toEqual({
      approvalId: 'approval-1',
      decision: 'ACCEPT',
    });
    // Exactly one mutation total in the flow.
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[1]?.method).length).toBe(1));
  });

  it('T10: ACCEPT success refreshes from the server (no optimistic removal) and fires the resolution callback', async () => {
    let getCount = 0;
    let releaseSecondGet: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') {
        return Promise.resolve(ok({ decision: 'ACCEPT' }));
      }
      if (url === GET_URL) {
        getCount += 1;
        if (getCount === 1) return Promise.resolve(ok({ proposals: [PROPOSAL] }));
        // Second (refresh) GET stays pending until released: the item must not
        // disappear by a local filter — only the server response decides.
        return new Promise((resolve) => {
          releaseSecondGet = () => resolve(ok({ proposals: [PROPOSAL] }));
        });
      }
      return Promise.resolve(fail(404));
    });
    const onProposalResolved = vi.fn();
    const user = userEvent.setup();
    renderSection({ onProposalResolved });
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-accept-btn'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Refresh was initiated from the server (2nd GET), not substituted.
    await waitFor(() => expect(getCalls()).toHaveLength(2));
    releaseSecondGet?.(ok({ proposals: [PROPOSAL] }));
    // Server still reports the proposal → the item remains (no optimistic delete).
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    expect(screen.getByText('AMAZON WEB SERVICES')).toBeInTheDocument();
    await waitFor(() => expect(onProposalResolved).toHaveBeenCalledTimes(1));
  });

  it('T11: CORRECT without human identity sends exactly ONE POST { approvalId, decision, glAccountId } — no confirmedEntity', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return ok({ decision: 'CORRECT' });
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-correct-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-correct-btn'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-b');
    await user.click(screen.getByTestId('ai-correct-confirm-btn'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe(GET_URL);
    expect(JSON.parse(postCalls()[0][1].body as string)).toEqual({
      approvalId: 'approval-1',
      decision: 'CORRECT',
      glAccountId: 'gl-b',
    });
    expect(Object.keys(JSON.parse(postCalls()[0][1].body as string))).not.toContain(
      'confirmedEntity',
    );
  });

  it('T12: CORRECT with explicit human identity sends trimmed canonicalName + entityType, and blocks when the name is empty/whitespace', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return ok({ decision: 'CORRECT' });
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-correct-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-correct-btn'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-b');
    // Identity toggle ON but name empty → blocked.
    await user.click(screen.getByTestId('ai-identity-toggle'));
    expect(screen.getByTestId('ai-correct-confirm-btn')).toBeDisabled();
    // Whitespace-only name → still blocked.
    await user.type(screen.getByTestId('ai-canonical-name'), '   ');
    expect(screen.getByTestId('ai-correct-confirm-btn')).toBeDisabled();
    expect(postCalls()).toHaveLength(0);
    // Valid typed name + explicit entity type → enabled.
    await user.type(screen.getByTestId('ai-canonical-name'), 'Acme Corp');
    await user.selectOptions(screen.getByTestId('ai-entity-type'), 'person');
    expect(screen.getByTestId('ai-correct-confirm-btn')).toBeEnabled();
    await user.click(screen.getByTestId('ai-correct-confirm-btn'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(postCalls()[0][1].body as string)).toEqual({
      approvalId: 'approval-1',
      decision: 'CORRECT',
      glAccountId: 'gl-b',
      confirmedEntity: { canonicalName: 'Acme Corp', entityType: 'person' },
    });
  });

  it('T12b: canonicalName is trimmed to the human-typed value', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return ok({ decision: 'CORRECT' });
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-correct-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-correct-btn'));
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-b');
    await user.click(screen.getByTestId('ai-identity-toggle'));
    await user.type(screen.getByTestId('ai-canonical-name'), '  Acme Corp  ');
    await user.click(screen.getByTestId('ai-correct-confirm-btn'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const body = JSON.parse(postCalls()[0][1].body as string);
    expect(body.confirmedEntity.canonicalName).toBe('Acme Corp');
  });

  it('T13: REJECT sends exactly ONE POST with the exact body — no glAccountId, no confirmedEntity', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return ok({ decision: 'REJECT' });
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-reject-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-reject-btn'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe(GET_URL);
    expect(JSON.parse(postCalls()[0][1].body as string)).toEqual({
      approvalId: 'approval-1',
      decision: 'REJECT',
    });
  });

  it('T14: across ACCEPT/CORRECT/REJECT the ONLY mutating authority is POST /api/import/ai-proposals?companyId=…', async () => {
    const list = [
      proposal({ approvalId: 'approval-a', transactionId: 'tx-a' }),
      proposal({ approvalId: 'approval-b', transactionId: 'tx-b' }),
      proposal({ approvalId: 'approval-c', transactionId: 'tx-c' }),
    ];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return ok({ decision: 'DONE' });
      if (url === GET_URL) return ok({ proposals: list });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getAllByTestId('ai-proposal-item')).toHaveLength(3));
    // ACCEPT item 1.
    await user.click(screen.getAllByTestId('ai-accept-btn')[0]);
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    // CORRECT item 2.
    await user.click(screen.getAllByTestId('ai-correct-btn')[1]);
    await user.selectOptions(screen.getByTestId('gl-account-select'), 'gl-a');
    await user.click(screen.getByTestId('ai-correct-confirm-btn'));
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    // REJECT item 3.
    await user.click(screen.getAllByTestId('ai-reject-btn')[2]);
    await waitFor(() => expect(postCalls()).toHaveLength(3));
    // Every call went to the proposal endpoint — nothing else, ever.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u === GET_URL)).toBe(true);
    // No PATCH /api/transactions/*, no KE, no direct PendingApproval surface.
    const mutating = fetchMock.mock.calls.filter((c) => c[1]?.method && c[1]?.method !== 'GET');
    expect(mutating.length).toBe(3);
    expect(mutating.every((c) => c[1]?.method === 'POST' && String(c[0]) === GET_URL)).toBe(true);
    expect(urls.some((u) => u.includes('/api/transactions'))).toBe(false);
    expect(urls.some((u) => u.includes('/api/learning') || u.includes('/api/memory'))).toBe(false);
    expect(urls.some((u) => u.includes('pending-approval'))).toBe(false);
  });

  it('T15: while a decision is in flight no second decision can be emitted (anti-double-submit)', async () => {
    let resolvePost: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') {
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      }
      if (url === GET_URL) return Promise.resolve(ok({ proposals: [PROPOSAL] }));
      return Promise.resolve(fail(404));
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-accept-btn'));
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeDisabled());
    // Second decision attempts while in flight: every decision button is
    // disabled and the submitting guard is active.
    expect(screen.getByTestId('ai-reject-btn')).toBeDisabled();
    expect(screen.getByTestId('ai-correct-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ai-accept-btn'));
    fireEvent.click(screen.getByTestId('ai-reject-btn'));
    expect(postCalls()).toHaveLength(1);
    resolvePost?.(ok({ decision: 'ACCEPT' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Still exactly one mutation after resolution.
    expect(postCalls()).toHaveLength(1);
  });

  it('T16a: 409 shows an error, performs an authoritative refetch, never appears as success, and never auto-retries the POST', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return fail(409, 'Proposal already consumed');
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const onProposalResolved = vi.fn();
    const user = userEvent.setup();
    renderSection({ onProposalResolved });
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-accept-btn'));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('aiProposals.alreadyResolved'));
    // Authoritative refetch + resolution callback.
    await waitFor(() => expect(onProposalResolved).toHaveBeenCalledTimes(1));
    expect(getCalls().length).toBeGreaterThanOrEqual(2);
    // Never appears as success; no automatic POST retry.
    expect(toast.success).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(postCalls()).toHaveLength(1);
  });

  it('T16b: 404 shows an error, performs an authoritative refetch, never appears as success', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return fail(404, 'Proposal not found');
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const onProposalResolved = vi.fn();
    const user = userEvent.setup();
    renderSection({ onProposalResolved });
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-accept-btn'));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('aiProposals.notFound'));
    await waitFor(() => expect(onProposalResolved).toHaveBeenCalledTimes(1));
    expect(getCalls().length).toBeGreaterThanOrEqual(2);
    expect(toast.success).not.toHaveBeenCalled();
    expect(postCalls()).toHaveLength(1);
  });

  it('T16c: 400 shows an error, keeps the proposal visible, never appears as success, no POST retry', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST') return fail(400, 'Invalid decision input');
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-accept-btn'));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Proposal still visible.
    expect(screen.getByText('AMAZON WEB SERVICES')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(postCalls()).toHaveLength(1);
  });

  it('T16d: 422 shows an error, keeps the proposal visible, never appears as success, no POST retry', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'POST')
        return fail(422, 'Reclassification rejected');
      if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
      return fail(404);
    });
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('ai-reject-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-reject-btn'));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Reclassification rejected'));
    expect(screen.getByText('AMAZON WEB SERVICES')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(postCalls()).toHaveLength(1);
  });

  it('T16e: 401/403 show the access error and never mutate anything', async () => {
    for (const status of [401, 403]) {
      cleanup();
      vi.clearAllMocks();
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === GET_URL && init?.method === 'POST') return fail(status);
        if (url === GET_URL) return ok({ proposals: [PROPOSAL] });
        return fail(404);
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      renderSection();
      await waitFor(() => expect(screen.getByTestId('ai-accept-btn')).toBeInTheDocument());
      await user.click(screen.getByTestId('ai-accept-btn'));
      const { toast } = await import('sonner');
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('aiProposals.accessError'));
      expect(toast.success).not.toHaveBeenCalled();
      expect(postCalls()).toHaveLength(1);
    }
  });

  it('T17: parent callback identity changes / re-renders never re-trigger the GET loop', async () => {
    const onPending1 = vi.fn();
    const resolved1 = vi.fn();
    const { rerender } = renderSection({
      onPendingProposalsChange: onPending1,
      onProposalResolved: resolved1,
    });
    await waitFor(() => expect(screen.getByTestId('ai-proposal-section')).toBeInTheDocument());
    const countAfterMount = getCalls().length;
    // Inline (unstable) identities across re-renders — the ref pattern must
    // keep the GET dependency limited to companyId.
    rerender(
      <AiProposalSection
        companyId="company-1"
        accounts={ACCOUNTS}
        onPendingProposalsChange={() => {}}
        onProposalResolved={() => {}}
      />,
    );
    rerender(
      <AiProposalSection
        companyId="company-1"
        accounts={ACCOUNTS}
        onPendingProposalsChange={() => {}}
        onProposalResolved={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(getCalls()).toHaveLength(countAfterMount);
    expect(onPending1).toHaveBeenCalledTimes(1);
  });
});
