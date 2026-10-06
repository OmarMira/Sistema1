// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { BankRulesPage } from '@/components/spa/BankRulesPage';
import enLocale from '@/i18n/locales/en';
import esLocale from '@/i18n/locales/es';

afterEach(() => cleanup());

const tFn = (key: string) => key;
const mockLangState = { t: tFn, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector(mockLangState),
}));

const mockAuthState = {
  user: { id: 'test-user', name: 'Test User' },
  activeCompany: { id: 'test-company', legalName: 'Test Co' },
  activeCompanyId: 'test-company',
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector(mockAuthState),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/spa/journal/AccountSelector', () => ({
  AccountSelector: ({ value, onChange }: { value: string | null; onChange: (id: string) => void }) => (
    <select data-testid="account-selector" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select account</option>
    </select>
  ),
}));

vi.mock('@/components/learning/EntityOnboardingModal', () => ({
  EntityOnboardingModal: () => null,
}));

vi.mock('@/components/spa/settings/AIRulesGeneratorTab', () => ({
  AIRulesGeneratorTab: () => null,
}));

const mockFetch = vi.fn();

function setupFetchStub() { vi.stubGlobal('fetch', mockFetch); }

const mockRules = [
  {
    id: 'r1',
    companyId: 'test-company',
    name: 'Walmart purchases',
    conditionType: 'contains',
    conditionValue: 'WALMART',
    transactionDirection: 'any',
    glAccountId: 'acc-1',
    priority: 5,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    glAccount: { id: 'acc-1', code: '5010', name: 'Cost of Goods', accountType: 'expense' },
    _matchCount: 42,
  },
  {
    id: 'r2',
    companyId: 'test-company',
    name: 'Uber rides',
    conditionType: 'contains',
    conditionValue: 'UBER',
    transactionDirection: 'debit',
    glAccountId: 'acc-2',
    priority: 12,
    isActive: false,
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    glAccount: { id: 'acc-2', code: '6100', name: 'Transport', accountType: 'expense' },
    _matchCount: 8,
  },
];

function setupFetchSuccess(rules = mockRules) {
  mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
    if (url.includes('/api/bank-rules') && opts?.method === 'PUT') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url.includes('/api/bank-rules') && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url.includes('/api/bank-rules')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: rules }) });
    }
    if (url.includes('/api/journal/accounts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('BankRulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFetchStub();
  });

  it('renders page with rules table', async () => {
    setupFetchSuccess();
    render(<BankRulesPage />);

    expect(screen.getByText('bankRules.title')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Walmart purchases')).toBeInTheDocument();
      expect(screen.getByText('Uber rides')).toBeInTheDocument();
    });
  });

  it('displays rule details including condition and match count', async () => {
    setupFetchSuccess();
    render(<BankRulesPage />);

    await waitFor(() => {
      expect(screen.getByText('Walmart purchases')).toBeInTheDocument();
    });

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('5010')).toBeInTheDocument();
  });

  it('renders edit and delete action buttons for each rule', async () => {
    setupFetchSuccess();
    render(<BankRulesPage />);

    await waitFor(() => {
      expect(screen.getByText('Walmart purchases')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole('button');
    expect(deleteButtons.length).toBeGreaterThan(0);
  });

  it('shows empty state when no rules exist', async () => {
    setupFetchSuccess([]);
    render(<BankRulesPage />);

    await waitFor(() => {
      expect(screen.getByText('bankRules.noRules')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<BankRulesPage />);

    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  // ── Apply All enforcement dialog ─────────────────────────────

  describe('Apply All enforcement dialog', () => {
    function setupApplyAllFetch(applyAllResponse: Record<string, unknown>) {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes('/api/bank-rules/apply-all')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(applyAllResponse) });
        }
        if (url.includes('/api/bank-rules') && opts?.method === 'PUT') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        if (url.includes('/api/bank-rules') && opts?.method === 'DELETE') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        if (url.includes('/api/bank-rules')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: mockRules }) });
        }
        if (url.includes('/api/journal/accounts')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    }

    async function openApplyAllDialog() {
      const user = userEvent.setup();
      const headerBtn = screen.getByText('bankRules.applyAll');
      await user.click(headerBtn);
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
    }

    async function clickApplyAllInDialog() {
      const user = userEvent.setup();
      const dialog = screen.getByRole('dialog');
      const applyBtn = within(dialog).getByText('bankRules.applyAll');
      await user.click(applyBtn);
    }

    it('EXECUTED shows success result with matched count', async () => {
      setupApplyAllFetch({ status: 'EXECUTED', success: true, matched: 3, total: 3, remaining: 0, rulesApplied: [] });
      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText('bankRules.transactionsCategorized')).toBeInTheDocument();
      });
    });

    it('EXECUTED with policyWarning shows warning banner', async () => {
      setupApplyAllFetch({
        status: 'EXECUTED', success: true, matched: 2, total: 2, remaining: 0, rulesApplied: [],
        policyWarning: { reasonCode: 'READINESS_NOT_MET', transactionCount: 2, profileId: 'standard-enforcement-v1', profileVersion: '1.0.0' },
      });
      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(screen.getByText('READINESS_NOT_MET')).toBeInTheDocument();
      });
    });

    it('CONFIRMATION_REQUIRED shows confirmation prompt with decision details', async () => {
      setupApplyAllFetch({
        status: 'CONFIRMATION_REQUIRED',
        decision: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met', profileId: 'standard-enforcement-v1', profileVersion: '1.0.0', readinessStatus: 'NOT_READY' },
        context: { transactionCount: 12, matchedRuleCount: 3 },
      });
      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(screen.getByText('bankRules.confirmationRequired')).toBeInTheDocument();
        expect(screen.getByText('bankRules.applyAllReasons.readinessNotMet')).toBeInTheDocument();
        expect(screen.getByText('bankRules.applyAllReadiness.notReady')).toBeInTheDocument();
        expect(screen.getByText('bankRules.applyAllConfirmDesc.generic')).toBeInTheDocument();
        expect(screen.getByText('12')).toBeInTheDocument();
        // Internal policy codes and technical summary must never reach the UI
        expect(screen.queryByText('READINESS_NOT_MET')).not.toBeInTheDocument();
        expect(screen.queryByText('NOT_READY')).not.toBeInTheDocument();
        expect(screen.queryByText('Readiness not met')).not.toBeInTheDocument();
      });
    });

    // Resolve dotted keys against a real locale so these tests assert the
    // actual human copy the user sees (not the key strings from the mock t).
    const makeLocaleT =
      (locale: unknown) =>
      (key: string): string => {
        const resolved = key
          .split('.')
          .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], locale);
        return typeof resolved === 'string' ? resolved : key;
      };

    const insufficientSampleConfirmation = {
      status: 'CONFIRMATION_REQUIRED',
      decision: {
        reasonCode: 'INSUFFICIENT_SAMPLE',
        summary: 'Rule "enforce-apply-all-insufficient" matched — INSUFFICIENT_SAMPLE. Action: CONFIRM.',
        profileId: 'standard-enforcement-v1',
        profileVersion: '1.0.0',
        readinessStatus: 'INSUFFICIENT_DATA',
      },
      context: { transactionCount: 4, matchedRuleCount: 2 },
    };

    // Locale-aware variant of openApplyAllDialog/clickApplyAllInDialog: with a
    // real locale active, buttons render their translated label, not the key.
    async function openApplyAllWith(realT: (key: string) => string) {
      const user = userEvent.setup();
      const headerBtn = screen.getByText(realT('bankRules.applyAll'));
      await user.click(headerBtn);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      const dialog = screen.getByRole('dialog');
      const applyBtn = within(dialog).getByText(realT('bankRules.applyAll'));
      await user.click(applyBtn);
    }

    it('CONFIRMATION_REQUIRED renders human copy instead of internal codes (EN, real locale)', async () => {
      const realT = makeLocaleT(enLocale);
      mockLangState.t = realT;
      try {
        setupApplyAllFetch(insufficientSampleConfirmation);
        render(<BankRulesPage />);
        await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

        await openApplyAllWith(realT);

        await waitFor(() => {
          expect(screen.getByText('Insufficient history')).toBeInTheDocument();
          expect(screen.getByText('Insufficient data')).toBeInTheDocument();
          expect(screen.getByText('4')).toBeInTheDocument();
          expect(screen.getByText('2')).toBeInTheDocument();
        });
        expect(
          screen.getByText(
            'There is not enough history yet to apply these rules automatically without confirmation. Review the data and confirm if you want to continue.'
          )
        ).toBeInTheDocument();
        expect(screen.queryByText('INSUFFICIENT_SAMPLE')).not.toBeInTheDocument();
        expect(screen.queryByText('INSUFFICIENT_DATA')).not.toBeInTheDocument();
        expect(screen.queryByText('enforce-apply-all-insufficient')).not.toBeInTheDocument();
        expect(screen.queryByText('Action: CONFIRM')).not.toBeInTheDocument();
      } finally {
        mockLangState.t = tFn;
      }
    });

    it('CONFIRMATION_REQUIRED renders Spanish copy (ES, real locale)', async () => {
      const realT = makeLocaleT(esLocale);
      mockLangState.t = realT;
      try {
        setupApplyAllFetch(insufficientSampleConfirmation);
        render(<BankRulesPage />);
        await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

        await openApplyAllWith(realT);

        await waitFor(() => {
          expect(screen.getByText('Historial insuficiente')).toBeInTheDocument();
          expect(screen.getByText('Datos insuficientes')).toBeInTheDocument();
        });
        expect(
          screen.getByText(
            'Todavía no hay suficiente historial para aplicar estas reglas automáticamente sin confirmación. Revisá los datos y confirmá si querés continuar.'
          )
        ).toBeInTheDocument();
        expect(screen.queryByText('INSUFFICIENT_SAMPLE')).not.toBeInTheDocument();
        expect(screen.queryByText('INSUFFICIENT_DATA')).not.toBeInTheDocument();
        expect(screen.queryByText('enforce-apply-all-insufficient')).not.toBeInTheDocument();
      } finally {
        mockLangState.t = tFn;
      }
    });

    it('CONFIRMATION_REQUIRED Cancel resets dialog', async () => {
      setupApplyAllFetch({
        status: 'CONFIRMATION_REQUIRED',
        decision: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met', profileId: 'standard-enforcement-v1', profileVersion: '1.0.0', readinessStatus: 'NOT_READY' },
        context: { transactionCount: 12, matchedRuleCount: 3 },
      });
      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(screen.getByText('bankRules.confirmationRequired')).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const cancelBtn = screen.getByText('common.cancel');
      await user.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('Confirming CONFIRMATION_REQUIRED sends confirmed:true and shows EXECUTED', async () => {
      let callCount = 0;
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes('/api/bank-rules/apply-all') && opts?.method === 'POST') {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({
                status: 'CONFIRMATION_REQUIRED',
                decision: { reasonCode: 'READINESS_NOT_MET', summary: 'Please confirm', profileId: 'standard-enforcement-v1', profileVersion: '1.0.0', readinessStatus: 'NOT_READY' },
                context: { transactionCount: 12, matchedRuleCount: 3 },
              }),
            });
          }
          const body = JSON.parse(opts?.body as string);
          expect(body.confirmed).toBe(true);
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'EXECUTED', success: true, matched: 12, total: 12, remaining: 0, rulesApplied: [] }),
          });
        }
        if (url.includes('/api/bank-rules')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: mockRules }) });
        }
        if (url.includes('/api/journal/accounts')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(screen.getByText('bankRules.confirmationRequired')).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const confirmBtn = screen.getByText('common.confirm');
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText('12')).toBeInTheDocument();
        expect(screen.getByText('bankRules.transactionsCategorized')).toBeInTheDocument();
      });
    });

    it('BLOCKED shows blocked error with reason', async () => {
      setupApplyAllFetch({
        status: 'BLOCKED',
        reasonCode: 'HIGH_RISK',
        summary: 'High risk divergence blocks execution',
        profileId: 'standard-enforcement-v1',
        profileVersion: '1.0.0',
      });
      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(screen.getByText('bankRules.applyAllBlocked')).toBeInTheDocument();
        expect(screen.getByText('HIGH_RISK')).toBeInTheDocument();
        expect(screen.getByText('High risk divergence blocks execution')).toBeInTheDocument();
      });
    });

    it('API error shows error toast', async () => {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes('/api/bank-rules/apply-all')) {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Server error' }) });
        }
        if (url.includes('/api/bank-rules')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: mockRules }) });
        }
        if (url.includes('/api/journal/accounts')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<BankRulesPage />);
      await waitFor(() => expect(screen.getByText('Walmart purchases')).toBeInTheDocument());

      await openApplyAllDialog();
      await clickApplyAllInDialog();

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('bankRules.errors.applyAllFailed');
      });
    });
  });
});
