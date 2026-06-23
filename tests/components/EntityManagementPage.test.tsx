// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityManagementPage } from '@/components/spa/EntityManagementPage';

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
  setCurrentView: vi.fn(),
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector(mockAuthState),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockEntities = [
  {
    id: '1',
    pattern: 'WALMART*',
    role: 'PROVEEDOR',
    source: 'auto',
    createdAt: '2026-01-15T00:00:00Z',
  },
  {
    id: '2',
    pattern: 'TRANSFER TO SAVINGS',
    role: 'OTRO',
    source: 'manual',
    createdAt: '2026-02-10T00:00:00Z',
  },
];

function setupFetchSuccess(data = mockEntities, totalPages = 1) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/entity-context')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data,
            pagination: { page: 1, limit: 20, total: data.length, totalPages },
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('EntityManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title and search input', async () => {
    setupFetchSuccess();
    render(<EntityManagementPage />);

    await waitFor(() => {
      expect(screen.getByText('entityManagement.title')).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('entityManagement.search.placeholder')).toBeInTheDocument();
  });

  it('displays entity table with expected columns', async () => {
    setupFetchSuccess();
    render(<EntityManagementPage />);

    await waitFor(() => {
      expect(screen.getByText('WALMART*')).toBeInTheDocument();
    });

    expect(screen.getByText('entityManagement.columns.pattern')).toBeInTheDocument();
    expect(screen.getByText('entityManagement.columns.role')).toBeInTheDocument();
    expect(screen.getByText('entityManagement.columns.actions')).toBeInTheDocument();
  });

  it('search filtering updates the fetch call', async () => {
    setupFetchSuccess();
    const user = userEvent.setup();
    render(<EntityManagementPage />);

    await waitFor(() => {
      expect(screen.getByText('WALMART*')).toBeInTheDocument();
    });

    const callCountBefore = mockFetch.mock.calls.length;
    const searchInput = screen.getByPlaceholderText('entityManagement.search.placeholder');
    await user.type(searchInput, 'test');

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callCountBefore);
      const newCalls = mockFetch.mock.calls.slice(callCountBefore).map((c: any) => c[0]);
      expect(newCalls.some((url: string) => url.includes('search='))).toBe(true);
    });
  });

  it('shows empty state when no entities returned', async () => {
    setupFetchSuccess([]);
    render(<EntityManagementPage />);

    await waitFor(() => {
      expect(screen.getByText('entityManagement.emptyState')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton initially', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<EntityManagementPage />);

    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
