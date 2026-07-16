// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FiscalPeriodsTab } from '@/components/spa/settings/FiscalPeriodsTab';

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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/format', () => ({
  formatDate: (d: string) => new Date(d).toLocaleDateString('en-US'),
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

const mockFetch = vi.fn();

function setupFetchStub() { vi.stubGlobal('fetch', mockFetch); }

const mockPeriods = [
  { id: 'p1', name: 'January 2026', startDate: '2026-01-01', endDate: '2026-01-31', isLocked: false },
  { id: 'p2', name: 'February 2026', startDate: '2026-02-01', endDate: '2026-02-28', isLocked: true },
];

function setupFetchSuccess(periods = mockPeriods) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/settings')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ periods }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('FiscalPeriodsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFetchStub();
  });

  it('renders fiscal periods list', async () => {
    setupFetchSuccess();
    render(<FiscalPeriodsTab />);

    await waitFor(() => {
      expect(screen.getByText('January 2026')).toBeInTheDocument();
      expect(screen.getByText('February 2026')).toBeInTheDocument();
    });
  });

  it('shows lock button for open periods', async () => {
    setupFetchSuccess();
    render(<FiscalPeriodsTab />);

    await waitFor(() => {
      expect(screen.getByText('January 2026')).toBeInTheDocument();
    });

    const lockButtons = screen.getAllByText('Lock');
    expect(lockButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows locked status for locked periods', async () => {
    setupFetchSuccess();
    render(<FiscalPeriodsTab />);

    await waitFor(() => {
      expect(screen.getByText('February 2026')).toBeInTheDocument();
    });

    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('opens lock confirmation dialog when lock button is clicked', async () => {
    setupFetchSuccess();
    const user = userEvent.setup();
    render(<FiscalPeriodsTab />);

    await waitFor(() => {
      expect(screen.getByText('January 2026')).toBeInTheDocument();
    });

    const lockButtons = screen.getAllByText('Lock');
    await user.click(lockButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('settings.periods.confirmLock')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<FiscalPeriodsTab />);

    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
