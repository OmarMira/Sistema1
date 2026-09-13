// KE-NAV-INTEGRATION-001 — T1–T6
// Settings exposes a Knowledge Engine entry that makes the EXISTING
// productive KE surfaces (conflicts + structural generalization)
// discoverable without manual URLs.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '@/components/spa/SettingsPage';

afterEach(() => cleanup());

/* ── Mock stores (precedent: settings-diagnostics-visibility.test.tsx) ── */

const tFn = (key: string) => key;
const mockLangState = { t: tFn, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector(mockLangState),
}));

type MockUser = { id: string; role: 'super_admin' | 'company_admin' } | null;
let mockUser: MockUser = null;
let mockActiveTab = 'user-profile';
const setActiveTab = vi.fn((tab: string) => {
  mockActiveTab = tab;
});

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({
      user: mockUser,
      activeCompany: { id: 'test-company', legalName: 'Test Co' },
      activeCompanyId: 'test-company',
      settingsActiveTab: mockActiveTab,
      setSettingsActiveTab: setActiveTab,
    }),
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

/* ── Mock sibling settings tabs (isolate navigation logic) ── */

vi.mock('@/components/spa/settings/DiagnosticsTab', () => ({
  DiagnosticsTab: () => <div data-testid="diagnostics-tab">Diagnostics</div>,
}));
vi.mock('@/components/spa/settings/UserProfileTab', () => ({
  UserProfileTab: () => <div data-testid="user-profile-tab">Profile</div>,
}));
vi.mock('@/components/spa/settings/CompanyDataTab', () => ({
  CompanyDataTab: () => <div>CompanyData</div>,
}));
vi.mock('@/components/spa/settings/UsersTab', () => ({
  UsersTab: () => <div>Users</div>,
}));
vi.mock('@/components/spa/settings/RolesTab', () => ({
  RolesTab: () => <div>Roles</div>,
}));
vi.mock('@/components/spa/settings/FiscalPeriodsTab', () => ({
  FiscalPeriodsTab: () => <div data-testid="periods-tab">Periods</div>,
}));
vi.mock('@/components/spa/settings/BackupTab', () => ({
  BackupTab: () => <div>Backup</div>,
}));
vi.mock('@/components/spa/settings/AiConfigTab', () => ({
  default: () => <div>AiConfig</div>,
}));
vi.mock('@/components/spa/EntityManagementPage', () => ({
  EntityManagementPage: () => <div>EntityManagement</div>,
}));

/* NOTE: KnowledgeEngineTab is NOT mocked — the real component renders,
   proving the actual links to the existing productive surfaces. */

const keNavLabel = 'settings.knowledgeEngine';

function renderSettings() {
  return render(<SettingsPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'u1', role: 'company_admin' };
  mockActiveTab = 'user-profile';
});

describe('KE-NAV-INTEGRATION-001 — Settings → Knowledge Engine (T1–T6)', () => {
  it('T1: Settings contains a visible Knowledge Engine entry', () => {
    renderSettings();
    expect(screen.getByText(keNavLabel)).toBeInTheDocument();
  });

  it('T2: from the entry, Conflicts is reachable', async () => {
    const user = userEvent.setup();
    const first = renderSettings();
    await user.click(screen.getByText(keNavLabel));
    expect(setActiveTab).toHaveBeenCalledWith('knowledge-engine');
    first.unmount();
    // Re-render with the tab active (store-driven navigation).
    mockActiveTab = 'knowledge-engine';
    renderSettings();
    expect(screen.getByTestId('knowledge-engine-tab')).toBeInTheDocument();
    expect(screen.getByTestId('ke-conflicts-link')).toBeInTheDocument();
  });

  it('T3: from the entry, Structural Generalization is reachable', async () => {
    const user = userEvent.setup();
    const first = renderSettings();
    await user.click(screen.getByText(keNavLabel));
    first.unmount();
    mockActiveTab = 'knowledge-engine';
    renderSettings();
    expect(screen.getByTestId('ke-generalization-link')).toBeInTheDocument();
  });

  it('T4: destinations are EXACTLY the existing productive surfaces (no duplication)', async () => {
    mockActiveTab = 'knowledge-engine';
    renderSettings();
    expect(screen.getByTestId('ke-conflicts-link')).toHaveAttribute(
      'href',
      '/company-knowledge/conflicts',
    );
    expect(screen.getByTestId('ke-generalization-link')).toHaveAttribute(
      'href',
      '/company-knowledge/structural-candidates',
    );
  });

  it('T5: RBAC unchanged — the entry adds no client-side role gating and no relaxed access', () => {
    // The entry is plain navigation: no role filter was added around it
    // (unlike diagnostics), and the destination pages/APIs keep their own
    // server-side company_admin gates (proven by their existing suites).
    mockUser = { id: 'u1', role: 'company_admin' };
    renderSettings();
    expect(screen.getByText(keNavLabel)).toBeInTheDocument();
    // No new permission-style filtering exists in the nav rendering path:
    // the item renders for the standard admin role exactly like other tabs.
    mockUser = { id: 's1', role: 'super_admin' };
    cleanup();
    renderSettings();
    expect(screen.getByText(keNavLabel)).toBeInTheDocument();
  });

  it('T6: existing Settings navigation is not broken (another tab still works)', async () => {
    const user = userEvent.setup();
    const first = renderSettings();
    await user.click(screen.getByText('settings.fiscalPeriodsTab'));
    expect(setActiveTab).toHaveBeenCalledWith('periods');
    first.unmount();
    mockActiveTab = 'periods';
    renderSettings();
    expect(screen.getByTestId('periods-tab')).toBeInTheDocument();
    // The KE entry coexists without altering the other items.
    expect(screen.getByText(keNavLabel)).toBeInTheDocument();
  });
});
