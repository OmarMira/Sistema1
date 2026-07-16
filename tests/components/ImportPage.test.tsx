// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportPage } from '@/components/spa/ImportPage';

afterEach(() => cleanup());

const tFn = (key: string) => key;
const mockLangState = { t: tFn, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector(mockLangState),
}));

const mockSetCurrentView = vi.fn();
const mockStartProcessing = vi.fn();
const mockStopProcessing = vi.fn();
const mockAuthState = {
  user: { id: 'test-user', name: 'Test User' },
  activeCompany: { id: 'test-company', legalName: 'Test Co' },
  activeCompanyId: 'test-company',
  setCurrentView: mockSetCurrentView,
  startProcessing: mockStartProcessing,
  stopProcessing: mockStopProcessing,
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector(mockAuthState),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/spa/journal/AccountSelector', () => ({
  AccountSelector: () => <div data-testid="account-selector" />,
}));

vi.mock('@/components/learning/EntityOnboardingModal', () => ({
  EntityOnboardingModal: () => null,
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

const mockFetch = vi.fn();

function setupFetchStub() { vi.stubGlobal('fetch', mockFetch); }

function setupFetchSuccess() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/banks')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [] }) });
    }
    if (url.includes('/api/import/history')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ statements: [] }) });
    }
    if (url.includes('/api/journal/accounts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function setupWithHistory() {
  const statements = [
    {
      id: 's1',
      bankAccountId: 'ba1',
      bankAccount: { id: 'ba1', accountName: 'Checking', bankName: 'Chase' },
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      openingBalance: 1000,
      closingBalance: 2500,
      format: 'csv',
      fileName: 'chase-jan.csv',
      createdAt: '2026-02-01T00:00:00Z',
      transactionCount: 45,
      autoCategorizedCount: 38,
      autoCategorizedPercent: 84,
    },
  ];
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/banks')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [] }) });
    }
    if (url.includes('/api/import/history')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ statements }) });
    }
    if (url.includes('/api/journal/accounts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('ImportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFetchStub();
  });

  it('renders upload area and import header', async () => {
    setupFetchSuccess();
    render(<ImportPage />);

    await waitFor(() => {
      const elements = screen.getAllByText('banks.importStatement');
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('banks.supportedFormats')).toBeInTheDocument();
  });

  it('displays supported format badges', async () => {
    setupFetchSuccess();
    render(<ImportPage />);

    await waitFor(() => {
      expect(screen.getByText('CSV')).toBeInTheDocument();
    });
    expect(screen.getByText('OFX')).toBeInTheDocument();
    expect(screen.getByText('QFX')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
  });

  it('displays import history when data is present', async () => {
    setupWithHistory();
    render(<ImportPage />);

    await waitFor(() => {
      expect(screen.getByText('chase-jan.csv')).toBeInTheDocument();
    });

    expect(screen.getByText('45')).toBeInTheDocument();
  });

  it('shows empty history state', async () => {
    setupFetchSuccess();
    render(<ImportPage />);

    await waitFor(() => {
      expect(screen.getByText('banks.noImportHistory')).toBeInTheDocument();
    });
  });

  it('import button is disabled when no files selected', async () => {
    setupFetchSuccess();
    render(<ImportPage />);

    await waitFor(() => {
      const elements = screen.getAllByText('banks.importStatement');
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });

    const buttons = screen.getAllByRole('button');
    const importButton = buttons.find((btn) => btn.textContent?.includes('banks.importStatement'));
    expect(importButton).toBeDefined();
    expect(importButton).toHaveProperty('disabled', true);
  });
});
