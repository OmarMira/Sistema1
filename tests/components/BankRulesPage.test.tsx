// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BankRulesPage } from '@/components/spa/BankRulesPage';

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
vi.stubGlobal('fetch', mockFetch);

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
});
