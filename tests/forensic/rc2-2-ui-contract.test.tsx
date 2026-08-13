// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import AdminUsersPage from '@/components/spa/admin/AdminUsersPage';
import AdminCompanyDetailPage from '@/components/spa/admin/AdminCompanyDetailPage';

afterEach(() => cleanup());

const tFn = (key: string) => key;
const mockLangState = { t: tFn, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector(mockLangState),
}));

const setCurrentView = vi.fn();
const mockAuthState = {
  user: { id: 'super', role: 'super_admin', firstName: 'Super', lastName: 'Admin' },
  activeCompany: null,
  activeCompanyId: '',
  setCurrentView,
  adminSelectedCompanyId: 'company-1',
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: (s: any) => any) =>
    selector ? selector(mockAuthState) : mockAuthState,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>,
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/components/ui/address-autocomplete', () => ({
  AddressAutocomplete: () => <div data-testid="address-autocomplete" />,
}));

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/admin/companies/company-1/users')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            members: [],
            allUsers: [
              { id: 'u1', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', role: 'user', isActive: true },
            ],
          }),
      });
    }
    if (url.includes('/api/admin/companies')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            companies: [
              { id: 'company-1', legalName: 'ACME', taxId: null, address: null, phone: null, email: null, isActive: true },
            ],
          }),
      });
    }
    if (url.includes('/api/admin/users')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ users: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
});

describe('RC2-2 UI — AdminUsersPage global role selector', () => {
  beforeEach(() => {
    mockAuthState.adminSelectedCompanyId = 'company-1';
  });

  it('UI-1: AdminUsersPage offers user + super_admin and DOES NOT offer company_admin as User.role', async () => {
    render(<AdminUsersPage />);
    await screen.findByText('adminUsers.title');

    await userEvent.click(screen.getByText('adminUsers.createBtn'));

    await waitFor(() => {
      expect(screen.getAllByRole('option').some((o) => (o as HTMLOptionElement).value === 'user')).toBe(true);
    });

    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    log('UI-1 options:', JSON.stringify(options));
    expect(options).toContain('user');
    expect(options).toContain('super_admin');
    expect(options).not.toContain('company_admin');
    expect(options).not.toContain('employee');
    expect(options).not.toContain('viewer');
  });
});

describe('RC2-2 UI — AdminCompanyDetailPage membership selector', () => {
  it('UI-2: AdminCompanyDetailPage offers company_admin/employee/viewer and DOES NOT offer super_admin as membership', async () => {
    render(<AdminCompanyDetailPage />);

    await screen.findByText('Assign User');
    await userEvent.click(screen.getByText('Assign User'));

    const dialog = await screen.findByRole('dialog');
    const options = within(dialog)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    log('UI-2 options:', JSON.stringify(options));
    expect(options).toContain('company_admin');
    expect(options).toContain('employee');
    expect(options).toContain('viewer');
    expect(options).not.toContain('super_admin');
  });
});

function log(...args: unknown[]) {
  console.log('[EVIDENCE-RC22-UI]', ...args);
}