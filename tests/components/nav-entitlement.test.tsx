// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector?: (s: { t: (key: string) => string }) => unknown) =>
    selector ? selector({ t: (key: string) => key }) : { t: (key: string) => key },
}));

import { useAuthStore, type Company } from '@/store/auth-store';
import { SidebarNav } from '@/components/app/SidebarNav';
import { DesktopNavItems } from '@/components/app/DesktopNavItems';

const companyA: Company = {
  id: 'company-a',
  legalName: 'Company A',
  taxId: null,
  isOnboardingComplete: true,
};
const companyB: Company = {
  id: 'company-b',
  legalName: 'Company B',
  taxId: null,
  isOnboardingComplete: true,
};

const ROWS: Record<string, Array<{ moduleKey: string; enabled: boolean }>> = {
  'company-a': [
    { moduleKey: 'accounting', enabled: true },
    { moduleKey: 'banking', enabled: true },
  ],
  'company-b': [
    { moduleKey: 'accounting', enabled: true },
    { moduleKey: 'banking', enabled: false },
  ],
};

type FetchMode = 'ok' | 'error' | 'never';

function makeFetch(mode: FetchMode, delayCompanyB = false) {
  const pendingResolvers: Array<() => void> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const companyId = new URL(url, 'http://localhost').searchParams.get('companyId') ?? '';
    if (mode === 'never') {
      return new Promise<Response>(() => {});
    }
    if (mode === 'error') {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    if (delayCompanyB && companyId === 'company-b') {
      await new Promise<void>((resolve) => pendingResolvers.push(resolve));
    }
    const entitlements = ROWS[companyId] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ companyId, entitlements }),
    } as Response;
  });
  return {
    fetchMock,
    releaseCompanyB: () => {
      pendingResolvers.splice(0).forEach((resolve) => resolve());
    },
  };
}

function renderWithQuery(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const COMMERCIAL_LABELS = [
  'accounts.title',
  'journal.title',
  'banks.title',
  'bank-rules.title',
  'reconciliation.title',
  'movement-summary.title',
  'reports.title',
  'export.title',
];

function expectCommercialHidden() {
  for (const label of COMMERCIAL_LABELS) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
  expect(screen.getByText('settings.title')).toBeInTheDocument();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  useAuthStore.setState({ activeCompany: null, currentView: 'dashboard' });
});

interface RendererCase {
  name: string;
  renderNav: () => void;
}

const renderers: RendererCase[] = [
  {
    name: 'SidebarNav',
    renderNav: () => {
      renderWithQuery(<SidebarNav />);
    },
  },
  {
    name: 'DesktopNavItems',
    renderNav: () => {
      renderWithQuery(<DesktopNavItems collapsed={false} />);
    },
  },
];

describe.each(renderers)('$name — entitlement gating', ({ renderNav }) => {
  it('T7: Company A visible -> switch to B -> render depends on B', async () => {
    const { fetchMock } = makeFetch('ok');
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({ activeCompany: companyA });
    renderNav();

    await waitFor(() => {
      expect(screen.getByText('accounts.title')).toBeInTheDocument();
      expect(screen.getByText('banks.title')).toBeInTheDocument();
    });

    await act(async () => {
      useAuthStore.setState({ activeCompany: companyB });
    });

    await waitFor(() => {
      expect(screen.getByText('accounts.title')).toBeInTheDocument();
    });
    expect(screen.queryByText('banks.title')).not.toBeInTheDocument();
    expect(screen.getByText('settings.title')).toBeInTheDocument();
  });

  it('T8: A -> B never presents A entitlements as B state', async () => {
    const { fetchMock, releaseCompanyB } = makeFetch('ok', true);
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({ activeCompany: companyA });
    renderNav();

    await waitFor(() => {
      expect(screen.getByText('banks.title')).toBeInTheDocument();
    });

    await act(async () => {
      useAuthStore.setState({ activeCompany: companyB });
    });

    expectCommercialHidden();

    await act(async () => {
      releaseCompanyB();
    });

    await waitFor(() => {
      expect(screen.getByText('accounts.title')).toBeInTheDocument();
    });
    expect(screen.queryByText('banks.title')).not.toBeInTheDocument();
    expect(screen.getByText('settings.title')).toBeInTheDocument();
  });

  it('T9: activeCompany=null => commercial nav hidden (fetch disabled)', async () => {
    const { fetchMock } = makeFetch('ok');
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({ activeCompany: null });
    renderNav();

    expect(screen.getByText('settings.title')).toBeInTheDocument();
    expectCommercialHidden();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T10: loading => commercial nav hidden', async () => {
    const { fetchMock } = makeFetch('never');
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({ activeCompany: companyA });
    renderNav();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expectCommercialHidden();
  });

  it('T11: error => commercial nav hidden', async () => {
    const { fetchMock } = makeFetch('error');
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({ activeCompany: companyA });
    renderNav();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText('settings.title')).toBeInTheDocument();
    });
    expectCommercialHidden();
  });
});
