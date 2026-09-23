// TX-RECLASSIFY-UI-001 — UI tests (T1–T23)
// ReclassifyDialog + BankDetailView reclassify action.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReclassifyDialog } from '../../src/components/import/ReclassifyDialog';
import { BankDetailView } from '../../src/components/spa/banks/BankDetailView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';

const tFn = vi.fn((key: string) => key);
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn }),
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector({ activeCompany: { id: 'company-1' } }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// AccountSelector mocked to a native select (Popover/Command not jsdom-friendly).
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
      <select data-testid="reclassify-gl-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
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

const fetchMock = vi.fn();

const ACCOUNTS = [
  { id: 'gl-a', code: '1.1.1', name: 'Cash', accountType: 'asset', normalBalance: 'debit' },
  { id: 'gl-b', code: '5.1.1', name: 'Office Expense', accountType: 'expense', normalBalance: 'debit' },
];

const TX = {
  id: 'tx-1',
  date: '2026-01-15T00:00:00.000Z',
  description: 'ABC 777 ENTITY-1',
  amount: -500,
  glAccountId: 'gl-a',
  glAccount: { id: 'gl-a', code: '1.1.1', name: 'Cash' },
};

function renderDialog(overrides: Partial<typeof TX> = {}) {
  return render(
    <ReclassifyDialog
      transaction={{ ...TX, ...overrides }}
      accounts={ACCOUNTS}
      onOpenChange={vi.fn()}
      onReclassified={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('TX-RECLASSIFY-UI-001 — ReclassifyDialog (T1–T23)', () => {
  it('T2: current GL is visible', () => {
    renderDialog();
    expect(screen.getByTestId('current-gl-label')).toHaveTextContent('1.1.1 Cash');
  });

  it('T3: the dialog identifies the correct transaction', () => {
    renderDialog();
    expect(screen.getByText('ABC 777 ENTITY-1')).toBeInTheDocument();
  });

  it('T4: the selector receives the existing GL source', () => {
    renderDialog();
    const select = screen.getByTestId('reclassify-gl-select') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['', 'gl-a', 'gl-b']);
  });

  it('T5: a different GL can be selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    expect((screen.getByTestId('reclassify-gl-select') as HTMLSelectElement).value).toBe('gl-b');
  });

  it('T6: selecting the current GL blocks confirmation (no-op, no PATCH)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-a');
    expect(screen.getByTestId('confirm-reclassify-btn')).toBeDisabled();
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    // Opening the dialog fires the entity-status GET; assert NO PATCH only.
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(0);
  });

  it('T7+T8+T9+T10+T11+T12: confirmation calls exactly PATCH /api/transactions/[id] with the real contract payload', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ transaction: {} }) });
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/transactions/tx-1' && c[1]?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body as string);
      expect(Object.keys(body)).toEqual(['glAccountId']);
      expect(body.glAccountId).toBe('gl-b');
      expect(body.companyId).toBeUndefined();
      expect(body.userId).toBeUndefined();
      expect(body.journal).toBeUndefined();
      expect(body.balance).toBeUndefined();
      expect(body.learning).toBeUndefined();
      expect(body.confidence).toBeUndefined();
      expect(body.conflict).toBeUndefined();
    });
  });

  it('T13+T14: success notifies the parent with the new GL and closes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ transaction: {} }) });
    const onReclassified = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ReclassifyDialog
        transaction={TX}
        accounts={ACCOUNTS}
        onOpenChange={onOpenChange}
        onReclassified={onReclassified}
      />,
    );
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      expect(onReclassified).toHaveBeenCalledWith('tx-1', 'gl-b');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('T15+T16: error keeps the dialog open with the old GL, allows retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'locked' }) });
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // Dialog still open (transaction still rendered) and retry possible.
    expect(screen.getByTestId('reclassify-gl-select')).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ transaction: {} }) });
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(2);
    });
  });

  it('T17: submitting prevents double submission', async () => {
    let resolvePatch: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation(
      (_url: string, _init?: RequestInit) =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        }),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-reclassify-btn')).toBeDisabled();
    });
    resolvePatch?.({ ok: true, status: 200, json: async () => ({}) });
  });

  it('T18: cancel does not perform any PATCH', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ReclassifyDialog transaction={TX} accounts={ACCOUNTS} onOpenChange={onOpenChange} onReclassified={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: tFn('reclassifyTx.cancel') }));
    // Opening the dialog fires the entity-status GET; assert NO PATCH only.
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // ─── Entity identity confirmation (UNKNOWN → explicit confirm) ───

  function mockStatusGet(entityStatus: string | Error) {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ transaction: {} }) };
      }
      if (entityStatus instanceof Error) throw entityStatus;
      return { ok: true, status: 200, json: async () => ({ entityStatus }) };
    });
  }

  it('identity section visible when status GET returns UNKNOWN', async () => {
    mockStatusGet('UNKNOWN');
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('identity-confirm-toggle')).toBeInTheDocument();
    });
  });

  it('identity section hidden when status GET returns KNOWN or fails', async () => {
    mockStatusGet('KNOWN');
    const { unmount } = renderDialog();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('identity-confirm-toggle')).not.toBeInTheDocument();
    unmount();

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('network down'));
    renderDialog();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('identity-confirm-toggle')).not.toBeInTheDocument();
  });

  it('UNKNOWN + checked toggle + name + type → PATCH body includes confirmedEntity', async () => {
    mockStatusGet('UNKNOWN');
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('identity-confirm-toggle')).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('identity-confirm-toggle'));
    await user.type(screen.getByTestId('identity-canonical-name'), '  ACME Corp  ');
    await user.selectOptions(screen.getByTestId('identity-entity-type'), 'company');
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body as string);
      expect(body.glAccountId).toBe('gl-b');
      expect(body.confirmedEntity).toEqual({
        canonicalName: 'ACME Corp',
        entityType: 'company',
      });
    });
  });

  it('UNKNOWN + unchecked toggle → PATCH body keys exactly ["glAccountId"]', async () => {
    mockStatusGet('UNKNOWN');
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('identity-confirm-toggle')).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body as string);
      expect(Object.keys(body)).toEqual(['glAccountId']);
    });
  });

  it('checked toggle + empty name → confirm disabled, no PATCH', async () => {
    mockStatusGet('UNKNOWN');
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('identity-confirm-toggle')).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId('reclassify-gl-select'), 'gl-b');
    await user.click(screen.getByTestId('identity-confirm-toggle'));
    expect(screen.getByTestId('confirm-reclassify-btn')).toBeDisabled();
    await user.click(screen.getByTestId('confirm-reclassify-btn'));
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(0);
  });

  it('T1+T2+T3 (BankDetailView): categorized transaction shows the reclassify action with current GL visible', async () => {
    const user = userEvent.setup();
    const onReclassify = vi.fn();
    render(
      <BankDetailView
        account={{
          id: 'bank-1', companyId: 'company-1', accountName: 'Bank One', bankName: 'Bank',
          accountNo: null, routingNo: null, glAccountId: 'gl-bank', balance: 0, initialBalance: 0,
          currency: 'USD', isActive: true, createdAt: '', updatedAt: '',
          glAccount: { id: 'gl-bank', code: '1.0.0', name: 'Bank', accountType: 'asset' },
          _count: { statements: 1 },
        }}
        transactions={[{ ...TX, isReconciled: false, reference: null }]}
        onBack={vi.fn()}
        onEdit={vi.fn()}
        onReclassify={onReclassify}
      />,
    );
    expect(screen.getByText('1.1.1')).toBeInTheDocument();
    await user.click(screen.getByTestId('reclassify-btn-tx-1'));
    expect(onReclassify).toHaveBeenCalledWith(expect.objectContaining({ id: 'tx-1' }));
  });

  it('BankDetailView: uncategorized transactions do not show the reclassify action', () => {
    render(
      <BankDetailView
        account={{
          id: 'bank-1', companyId: 'company-1', accountName: 'Bank One', bankName: 'Bank',
          accountNo: null, routingNo: null, glAccountId: 'gl-bank', balance: 0, initialBalance: 0,
          currency: 'USD', isActive: true, createdAt: '', updatedAt: '',
          glAccount: { id: 'gl-bank', code: '1.0.0', name: 'Bank', accountType: 'asset' },
          _count: { statements: 1 },
        }}
        transactions={[{ ...TX, id: 'tx-null', glAccountId: null, glAccount: null, isReconciled: false, reference: null }]}
        onBack={vi.fn()}
        onEdit={vi.fn()}
        onReclassify={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('reclassify-btn-tx-null')).not.toBeInTheDocument();
  });
});
