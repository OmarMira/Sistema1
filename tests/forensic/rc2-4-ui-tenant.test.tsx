// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { toast } from 'sonner';

/* ─── Store mock (mutable per test) ─────────────────────────────── */

const storeState = {
  user: { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Admin' },
  activeCompany: { id: 'co1', role: 'company_admin' },
  isAuthenticated: true,
  setCurrentView: vi.fn(),
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: (s: any) => any) =>
    selector ? selector(storeState as any) : storeState,
}));

const tFn = (key: string) => key;
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn, language: 'en' }),
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

const rbacCalls: Array<{ role: string | null; resource: string; action: string }> = [];
vi.mock('@/hooks/useRBAC', () => ({
  useRBAC: (authCtx: any, resource: string, action: string) => {
    rbacCalls.push({ role: authCtx?.role ?? null, resource, action });
    return true;
  },
}));

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/users')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            users: [
              { id: 'u9', email: 'peer@example.com', firstName: 'Peer', lastName: 'User', role: 'user', isActive: true, joinedAt: new Date().toISOString() },
            ],
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
});

afterEach(() => {
  cleanup();
});

function log(...args: unknown[]) {
  console.log('[EVIDENCE-RC24UI]', ...args);
}

async function renderUsersPage() {
  const { UsersPage } = await import('@/components/spa/UsersPage');
  render(<UsersPage />);
}

describe('RC2-4 UI — UsersPage uses tenant authority (CompanyMember.role)', () => {
  it('UI-1: role=user + active membership company_admin -> admin allowed', async () => {
    storeState.user = { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Admin' };
    storeState.activeCompany = { id: 'co1', role: 'company_admin' };

    await renderUsersPage();
    await screen.findByText('users.title');
    await waitFor(() => {
      expect(screen.queryByText('users.accessDenied')).toBeNull();
    });
    log('UI-1: user.role=user + membership company_admin -> titled page rendered');
    expect(mockFetch).toHaveBeenCalledWith('/api/users?companyId=co1');
  });

  it('UI-2: membership employee -> access denied', async () => {
    storeState.user = { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Employee' };
    storeState.activeCompany = { id: 'co1', role: 'employee' };

    await renderUsersPage();
    await screen.findByText('users.accessDenied');
    log('UI-2: membership employee -> accessDenied rendered');
    expect(mockFetch).not.toHaveBeenCalledWith('/api/users?companyId=co1');
  });

  it('UI-3: membership viewer -> access denied', async () => {
    storeState.user = { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Viewer' };
    storeState.activeCompany = { id: 'co1', role: 'viewer' };

    await renderUsersPage();
    await screen.findByText('users.accessDenied');
    log('UI-3: membership viewer -> accessDenied rendered');
  });

  it('UI-4: super_admin global -> allowed without any membership role', async () => {
    storeState.user = { id: 'u1', role: 'super_admin', firstName: 'Super', lastName: 'Admin' };
    storeState.activeCompany = { id: 'co1', role: null };

    await renderUsersPage();
    await screen.findByText('users.title');
    await waitFor(() => {
      expect(screen.queryByText('users.accessDenied')).toBeNull();
    });
    log('UI-4: super_admin + no membership role -> titled page rendered');
    expect(mockFetch).toHaveBeenCalledWith('/api/users?companyId=co1');
  });

  it('UI-5: switching activeCompany changes tenant authority', async () => {
    storeState.user = { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Switch' };
    storeState.activeCompany = { id: 'co1', role: 'company_admin' };

    const { UsersPage } = await import('@/components/spa/UsersPage');
    const view = render(<UsersPage />);
    await screen.findByText('users.title');
    await waitFor(() => {
      expect(screen.queryByText('users.accessDenied')).toBeNull();
    });

    // Switch to a different company where the user is only a viewer.
    act(() => {
      storeState.activeCompany = { id: 'co2', role: 'viewer' };
    });
    view.rerender(<UsersPage />);
    await screen.findByText('users.accessDenied');
    log('UI-5: switched to company with viewer membership -> accessDenied rendered');
    expect(mockFetch).not.toHaveBeenCalledWith('/api/users?companyId=co2');
  });
});

describe('RC2-4 UI — FinancialAssistantPanel uses active membership, not User.role', () => {
  it('UI-6: role=user + membership company_admin -> RBAC role passed as company_admin', async () => {
    storeState.user = { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Panel' };
    storeState.activeCompany = { id: 'co1', role: 'company_admin' };
    rbacCalls.length = 0;

    const { FinancialAssistantPanel } = await import(
      '@/components/assistant/FinancialAssistantPanel'
    );
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FinancialAssistantPanel companyId="co1" />
      </QueryClientProvider>,
    );
    log('UI-6: useRBAC calls =', JSON.stringify(rbacCalls));
    expect(rbacCalls[0]?.role).toBe('company_admin');
    expect(rbacCalls[0]?.resource).toBe('reports');
    expect(rbacCalls[0]?.action).toBe('read');
  });

  it('UI-7: super_admin -> RBAC role stays super_admin regardless of membership', async () => {
    storeState.user = { id: 'u1', role: 'super_admin', firstName: 'Super', lastName: 'Panel' };
    storeState.activeCompany = { id: 'co1', role: null };
    rbacCalls.length = 0;

    const { FinancialAssistantPanel } = await import(
      '@/components/assistant/FinancialAssistantPanel'
    );
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FinancialAssistantPanel companyId="co1" />
      </QueryClientProvider>,
    );
    log('UI-7: useRBAC calls =', JSON.stringify(rbacCalls));
    expect(rbacCalls[0]?.role).toBe('super_admin');
  });

  it('UI-8: employee membership -> RBAC role employee, allowed by reports.read', async () => {
    storeState.user = { id: 'u1', role: 'user', firstName: 'Tenant', lastName: 'Employee' };
    storeState.activeCompany = { id: 'co1', role: 'employee' };
    rbacCalls.length = 0;

    const { FinancialAssistantPanel } = await import(
      '@/components/assistant/FinancialAssistantPanel'
    );
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FinancialAssistantPanel companyId="co1" />
      </QueryClientProvider>,
    );
    log('UI-8: useRBAC calls =', JSON.stringify(rbacCalls));
    expect(rbacCalls[0]?.role).toBe('employee');
  });
});