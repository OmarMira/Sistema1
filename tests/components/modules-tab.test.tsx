// GAP #11E-B — ModulesTab (Module Configuration UI, NO pricing).
//
// U1  renders exactly 5 modules
// U2  AVAILABLE badge correct
// U3  PARTIAL visible, never hidden
// U4  UNAVAILABLE visible with disabled toggle
// U5  company_admin can trigger PATCH
// U6  viewer sees modules but cannot mutate
// U7  PATCH contract: moduleKey path + boolean enabled body
// U8  MISSING_DEPENDENCY response shows missingDependencies
// U9  successful mutation refreshes module data (GET refetch)
// U10 successful mutation invalidates the 11C nav query key
// U11 backend error shows feedback without breaking the UI
// U12 no pricing UI rendered ($, USD, 0.00, price)
// U13 Settings registers the modules tab (PASO 2 integration)
// U14 dependent module recomputes after its dependency is disabled
//
// Real component + real react-query + real 11C hook; only stores, toast,
// fetch and sibling tabs are mocked (pattern: settings-knowledge-engine
// and nav-entitlement suites).

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/* ── Mock stores (precedent: settings-knowledge-engine.test.tsx) ── */

const tFn = (key: string) => key;
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: { t: (key: string) => string; language: string }) => unknown) =>
    selector({ t: tFn, language: 'en' }),
}));

let mockUser: { id: string; role: 'super_admin' | 'user' } | null = { id: 'u1', role: 'user' };
let mockTenantRole: 'company_admin' | 'employee' | 'viewer' | null = 'company_admin';
let mockActiveTab = 'user-profile';
const mockSetActiveTab = vi.fn((tab: string) => {
  mockActiveTab = tab;
});

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: mockUser,
      activeCompany: { id: 'company-1', legalName: 'Test Co', role: mockTenantRole },
      activeCompanyRole: () => mockTenantRole,
      settingsActiveTab: mockActiveTab,
      setSettingsActiveTab: mockSetActiveTab,
    }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/* ── Mock framer-motion + sibling tabs (isolate Settings registration) ── */

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

vi.mock('@/components/spa/settings/DiagnosticsTab', () => ({ DiagnosticsTab: () => <div /> }));
vi.mock('@/components/spa/settings/UserProfileTab', () => ({ UserProfileTab: () => <div /> }));
vi.mock('@/components/spa/settings/CompanyDataTab', () => ({ CompanyDataTab: () => <div /> }));
vi.mock('@/components/spa/settings/UsersTab', () => ({ UsersTab: () => <div /> }));
vi.mock('@/components/spa/settings/RolesTab', () => ({ RolesTab: () => <div /> }));
vi.mock('@/components/spa/settings/FiscalPeriodsTab', () => ({ FiscalPeriodsTab: () => <div /> }));
vi.mock('@/components/spa/settings/BackupTab', () => ({ BackupTab: () => <div /> }));
vi.mock('@/components/spa/settings/AiConfigTab', () => ({ default: () => <div /> }));
vi.mock('@/components/spa/settings/KnowledgeEngineTab', () => ({ KnowledgeEngineTab: () => <div /> }));
vi.mock('@/components/spa/EntityManagementPage', () => ({ EntityManagementPage: () => <div /> }));

import { ModulesTab } from '@/components/spa/settings/ModulesTab';
import { SettingsPage } from '@/components/spa/SettingsPage';
import { toast } from 'sonner';

/* ── Stateful fetch mock (GET rows + emulated 11E-A PATCH endpoint) ── */

interface EntRow {
  moduleKey: string;
  enabled: boolean;
}

let mockRows: EntRow[] = [];
let fetchMock = vi.fn();
type PatchOverride = (url: string, body: { enabled: boolean }) => { status: number; body: unknown };

const DEPENDENCIES: Record<string, string[]> = {
  accounting: [],
  banking: ['accounting'],
  purchases: ['accounting'],
  sales: ['accounting'],
  inventory: [],
};

function implementationStatusOf(moduleKey: string): string {
  if (moduleKey === 'purchases' || moduleKey === 'sales') return 'PARTIAL';
  if (moduleKey === 'inventory') return 'UNAVAILABLE';
  return 'AVAILABLE';
}

function emulateEngine(moduleKey: string, enabled: boolean) {
  const missingDependencies =
    moduleKey === 'inventory' || !enabled
      ? []
      : DEPENDENCIES[moduleKey].filter(
          (dependency) => mockRows.find((row) => row.moduleKey === dependency)?.enabled !== true,
        );
  let reason = 'EFFECTIVE_ENABLED';
  let effectiveEnabled = true;
  if (moduleKey === 'inventory') {
    effectiveEnabled = false;
    reason = 'IMPLEMENTATION_UNAVAILABLE';
  } else if (!enabled) {
    effectiveEnabled = false;
    reason = 'COMMERCIALLY_DISABLED';
  } else if (missingDependencies.length > 0) {
    effectiveEnabled = false;
    reason = 'MISSING_DEPENDENCY';
  }
  return {
    moduleKey,
    implementationStatus: implementationStatusOf(moduleKey),
    configured: true,
    commercialEnabled: enabled,
    effectiveEnabled,
    reason,
    missingDependencies,
  };
}

function defaultPatch(url: string, body: { enabled: boolean }) {
  const moduleKey = new URL(url, 'http://localhost').pathname.split('/').pop() as string;
  const existing = mockRows.find((row) => row.moduleKey === moduleKey);
  if (existing) {
    existing.enabled = body.enabled;
  } else {
    mockRows.push({ moduleKey, enabled: body.enabled });
  }
  return { status: 200, body: { companyId: 'company-1', entitlement: emulateEngine(moduleKey, body.enabled) } };
}

function installFetch(patchOverride?: PatchOverride) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      const parsed = JSON.parse(String(init.body)) as { enabled: boolean };
      const result = patchOverride ? patchOverride(url, parsed) : defaultPatch(url, parsed);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ companyId: 'company-1', entitlements: [...mockRows] }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function patchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
}

function getCalls() {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PATCH');
}

/* ── Render helpers ── */

function renderWithQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...utils };
}

async function renderModulesTab() {
  const utils = renderWithQuery(<ModulesTab />);
  await waitFor(() => expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5));
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'u1', role: 'user' };
  mockTenantRole = 'company_admin';
  mockActiveTab = 'user-profile';
  mockRows = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ── U1–U12 ── */

describe('GAP #11E-B — ModulesTab', () => {
  it('U1: renders exactly 5 module cards', async () => {
    await renderModulesTab();
    expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5);
    for (const key of ['accounting', 'banking', 'purchases', 'sales', 'inventory']) {
      expect(screen.getByTestId(`module-card-${key}`)).toBeInTheDocument();
    }
  });

  it('U2: AVAILABLE badge is rendered correctly', async () => {
    await renderModulesTab();
    expect(screen.getByTestId('module-status-accounting')).toHaveTextContent(
      'settings.modules.status.AVAILABLE',
    );
  });

  it('U3: PARTIAL modules are visible and never hidden', async () => {
    await renderModulesTab();
    const purchases = screen.getByTestId('module-card-purchases');
    expect(purchases).toBeInTheDocument();
    expect(screen.getByTestId('module-status-purchases')).toHaveTextContent(
      'settings.modules.status.PARTIAL',
    );
    expect(screen.getByTestId('module-card-sales')).toBeInTheDocument();
  });

  it('U4: UNAVAILABLE module is visible with a disabled toggle', async () => {
    await renderModulesTab();
    expect(screen.getByTestId('module-card-inventory')).toBeInTheDocument();
    expect(screen.getByTestId('module-status-inventory')).toHaveTextContent(
      'settings.modules.status.UNAVAILABLE',
    );
    expect(screen.getByTestId('module-toggle-inventory')).toBeDisabled();
  });

  it('U5: company_admin can trigger a PATCH', async () => {
    await renderModulesTab();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('module-toggle-accounting'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0][0]).toContain('/api/company/entitlements/accounting');
  });

  it('U6: viewer sees modules but cannot mutate', async () => {
    mockTenantRole = 'viewer';
    await renderModulesTab();
    const toggle = screen.getByTestId('module-toggle-accounting');
    expect(toggle).toBeDisabled();
    const user = userEvent.setup();
    await user.click(toggle);
    expect(patchCalls()).toHaveLength(0);
    expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5);
  });

  it('U7: PATCH contract uses moduleKey path and boolean enabled body', async () => {
    await renderModulesTab();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('module-toggle-banking'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [url, init] = patchCalls()[0] as [string, RequestInit];
    expect(url).toContain('/api/company/entitlements/banking');
    expect(url).toContain('companyId=company-1');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toHaveProperty('enabled');
    expect(typeof body.enabled).toBe('boolean');
    expect(body.enabled).toBe(true);
  });

  it('U8: MISSING_DEPENDENCY response lists missing dependencies', async () => {
    // accounting never enabled: banking activation persists but engine denies.
    await renderModulesTab();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('module-toggle-banking'));
    await waitFor(() => expect(screen.getByTestId('module-missing-banking')).toBeInTheDocument());
    const missing = screen.getByTestId('module-missing-banking');
    expect(missing).toHaveTextContent('settings.modules.missingDependency');
    expect(missing).toHaveTextContent('Accounting');
    expect(screen.getByTestId('module-state-banking')).toHaveTextContent(
      'settings.modules.reason.MISSING_DEPENDENCY',
    );
    // The feedback is a message, not a blocker: no error alert is raised.
    expect(screen.queryByTestId('module-error-banking')).not.toBeInTheDocument();
  });

  it('U9: successful mutation refreshes module data (GET refetch)', async () => {
    await renderModulesTab();
    const initialGets = getCalls().length;
    const user = userEvent.setup();
    await user.click(screen.getByTestId('module-toggle-accounting'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    await waitFor(() => expect(getCalls().length).toBeGreaterThan(initialGets));
  });

  it('U10: successful mutation invalidates the 11C nav query key', async () => {
    const { client } = renderWithQuery(<ModulesTab />);
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    await waitFor(() => expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('module-toggle-accounting'));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['module-nav-entitlements', 'company-1'],
      }),
    );
  });

  it('U11: backend error shows feedback without breaking the UI', async () => {
    cleanup();
    installFetch(() => ({ status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } }));
    await renderModulesTab();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('module-toggle-accounting'));
    await waitFor(() => expect(screen.getByTestId('module-error-accounting')).toBeInTheDocument());
    expect(screen.getByTestId('module-error-accounting')).toHaveTextContent('Forbidden');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
    // UI is intact: all 5 cards still rendered.
    expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5);
  });

  it('U12: no pricing UI is rendered', async () => {
    await renderModulesTab();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('$');
    expect(text).not.toContain('USD');
    expect(text).not.toContain('0.00');
    expect(text.toLowerCase()).not.toContain('price');
  });

  it('U13: Settings registers and opens the modules tab', async () => {
    const user = userEvent.setup();
    let utils = renderWithQuery(<SettingsPage />);
    await user.click(screen.getByText('settings.modulesTab'));
    expect(mockSetActiveTab).toHaveBeenCalledWith('modules');
    utils.unmount();

    mockActiveTab = 'modules';
    utils = renderWithQuery(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5));
    expect(within(screen.getByTestId('modules-list')).getAllByTestId(/^module-card-/)).toHaveLength(5);
  });

  it('U14: dependent module recomputes after its dependency is disabled', async () => {
    await renderModulesTab();
    const user = userEvent.setup();

    // 1. Enable accounting → becomes effective.
    await user.click(screen.getByTestId('module-toggle-accounting'));
    await waitFor(() => {
      expect(screen.getByTestId('module-state-accounting')).toHaveTextContent(
        'settings.modules.reason.EFFECTIVE_ENABLED',
      );
      expect(screen.getByTestId('module-toggle-accounting')).toBeEnabled();
    });

    // 2. Enable banking → becomes effective (dependency satisfied).
    await user.click(screen.getByTestId('module-toggle-banking'));
    await waitFor(() => {
      expect(screen.getByTestId('module-state-banking')).toHaveTextContent(
        'settings.modules.reason.EFFECTIVE_ENABLED',
      );
      expect(screen.getByTestId('module-toggle-banking')).toBeEnabled();
    });

    // 3. Disable accounting → rows refetch; accounting itself shows disabled.
    await user.click(screen.getByTestId('module-toggle-accounting'));
    await waitFor(() => {
      expect(screen.getByTestId('module-state-accounting')).toHaveTextContent(
        'settings.modules.reason.COMMERCIALLY_DISABLED',
      );
      expect(screen.getByTestId('module-toggle-accounting')).toBeEnabled();
    });

    // 4. Banking must recompute WITHOUT remounting: effectiveEnabled=false
    //    (reason MISSING_DEPENDENCY implies it), missingDependencies includes
    //    Accounting, and the toggle stays commercially on.
    await waitFor(() =>
      expect(screen.getByTestId('module-state-banking')).toHaveTextContent(
        'settings.modules.reason.MISSING_DEPENDENCY',
      ),
    );
    expect(screen.getByTestId('module-missing-banking')).toHaveTextContent('Accounting');
    expect(screen.getByTestId('module-toggle-banking')).toBeChecked();
    expect(screen.getAllByTestId(/^module-card-/)).toHaveLength(5);
  });
});
