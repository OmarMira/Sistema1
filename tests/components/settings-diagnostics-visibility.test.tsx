// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '@/components/spa/SettingsPage';

afterEach(() => cleanup());

/* ── Mock stores ─────────────────────────────────────────────── */

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

const mockAuthState = {
  get user() {
    return mockUser;
  },
  activeCompany: { id: 'test-company', legalName: 'Test Co' },
  activeCompanyId: 'test-company',
  settingsActiveTab: mockActiveTab,
  setSettingsActiveTab: setActiveTab,
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({
      user: mockUser,
      activeCompany: mockAuthState.activeCompany,
      activeCompanyId: mockAuthState.activeCompanyId,
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

/* ── Mock sibling settings tabs: isolate SettingsPage visibility logic ── */

let diagnosticsMountCount = 0;
vi.mock('@/components/spa/settings/DiagnosticsTab', () => ({
  DiagnosticsTab: () => {
    diagnosticsMountCount += 1;
    return <div data-testid="diagnostics-tab">Diagnostics</div>;
  },
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
  FiscalPeriodsTab: () => <div>Periods</div>,
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

/* ── Fetch spy for /api/diagnostics evidence ─────────────────── */

const fetchMock = vi.fn();
function setupFetchSpy() {
  vi.stubGlobal('fetch', fetchMock);
}

const diagnosticsNavLabel = 'settings.diagnosticsTab';

describe('SettingsPage — Diagnostics tab visibility (UX only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = null;
    mockActiveTab = 'user-profile';
    diagnosticsMountCount = 0;
    setupFetchSpy();
  });

  it('1. super_admin → tab visible', async () => {
    mockUser = { id: 's1', role: 'super_admin' };
    render(<SettingsPage />);
    expect(screen.getByText(diagnosticsNavLabel)).toBeInTheDocument();
  });

  it('2. company_admin → tab absent', async () => {
    mockUser = { id: 'u1', role: 'company_admin' };
    render(<SettingsPage />);
    expect(screen.queryByText(diagnosticsNavLabel)).not.toBeInTheDocument();
  });

  it('3. employee (User.role=company_admin) → tab absent', async () => {
    mockUser = { id: 'u2', role: 'company_admin' };
    render(<SettingsPage />);
    expect(screen.queryByText(diagnosticsNavLabel)).not.toBeInTheDocument();
  });

  it('4. viewer (User.role=company_admin) → tab absent', async () => {
    mockUser = { id: 'u3', role: 'company_admin' };
    render(<SettingsPage />);
    expect(screen.queryByText(diagnosticsNavLabel)).not.toBeInTheDocument();
  });

  it('5. unknown/loading user (null) → tab absent (visual fail-closed)', async () => {
    mockUser = null;
    render(<SettingsPage />);
    expect(screen.queryByText(diagnosticsNavLabel)).not.toBeInTheDocument();
  });

  it('6. non-super_admin → DiagnosticsTab never mounts', async () => {
    mockUser = { id: 'u4', role: 'company_admin' };
    render(<SettingsPage />);
    expect(diagnosticsMountCount).toBe(0);
  });

  it('7. non-super_admin → 0 fetch /api/diagnostics', async () => {
    mockUser = { id: 'u5', role: 'company_admin' };
    render(<SettingsPage />);
    const diagCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/api/diagnostics'),
    );
    expect(diagCalls.length).toBe(0);
  });

  it('8. super_admin can select diagnostics → tab mounts and content renders', async () => {
    mockUser = { id: 's2', role: 'super_admin' };
    const user = userEvent.setup();
    const { rerender } = render(<SettingsPage />);

    await user.click(screen.getByText(diagnosticsNavLabel));

    expect(setActiveTab).toHaveBeenCalledWith('diagnostics');
    rerender(<SettingsPage />);
    expect(screen.getByTestId('diagnostics-tab')).toBeInTheDocument();
    expect(diagnosticsMountCount).toBe(1);
  });
});