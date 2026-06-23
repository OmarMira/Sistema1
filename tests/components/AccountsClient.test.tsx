// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountsClient } from '@/components/spa/AccountsClient';

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

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
      const safe: Record<string, unknown> = {};
      for (const key of Object.keys(props)) {
        if (['variants', 'initial', 'animate', 'exit', 'transition', 'custom', 'layout'].includes(key)) continue;
        safe[key] = props[key];
      }
      return <div {...safe}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock('next/dynamic', () => ({
  default: function mockDynamic() {
    return function MockComponent() {
      return null;
    };
  },
}));

vi.mock('@/components/spa/accounts/BalanceBadge', () => ({
  BalanceBadge: () => null,
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockAccounts = [
  {
    id: 'a1',
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
    isActive: true,
    balance: 5000,
    parentId: null,
    isSystem: false,
    _count: { children: 2 },
  },
  {
    id: 'a2',
    code: '1011',
    name: 'Checking',
    accountType: 'asset',
    normalBalance: 'debit',
    isActive: true,
    balance: 3000,
    parentId: 'a1',
    isSystem: false,
    _count: { children: 0 },
  },
  {
    id: 'a3',
    code: '2010',
    name: 'Accounts Payable',
    accountType: 'liability',
    normalBalance: 'credit',
    isActive: true,
    balance: -1200,
    parentId: null,
    isSystem: false,
    _count: { children: 0 },
  },
];

function setupFetchSuccess(accounts = mockAccounts) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/accounts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('AccountsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders chart of accounts title', async () => {
    setupFetchSuccess();
    render(<AccountsClient />);

    await waitFor(() => {
      expect(screen.getByText('accounts.title')).toBeInTheDocument();
    });
  });

  it('renders accounts grouped by type sections', async () => {
    setupFetchSuccess();
    render(<AccountsClient />);

    await waitFor(() => {
      expect(screen.getByText('Cash')).toBeInTheDocument();
      expect(screen.getByText('Accounts Payable')).toBeInTheDocument();
    });
  });

  it('search filtering updates the fetch', async () => {
    setupFetchSuccess();
    const user = userEvent.setup();
    render(<AccountsClient />);

    await waitFor(() => {
      expect(screen.getByText('Cash')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('accounts.searchAccounts');
    await user.clear(searchInput);
    await user.type(searchInput, 'payable');

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: any) => c[0]);
      expect(calls.some((url: string) => url.includes('search=payable'))).toBe(true);
    });
  });

  it('new account button is rendered', async () => {
    setupFetchSuccess();
    render(<AccountsClient />);

    await waitFor(() => {
      expect(screen.getByText('accounts.newAccount')).toBeInTheDocument();
    });
  });

  it('shows skeleton while loading', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<AccountsClient />);

    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
