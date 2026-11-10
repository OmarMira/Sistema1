// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * The company badge lets the installation owner leave the active company and pick
 * another one. The affordance is only useful to that account, so the hint is shown
 * to a super administrator and withheld from everybody else.
 */
const mockLang = { t: (key: string) => key, language: 'es' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector?: (state: typeof mockLang) => unknown) =>
    selector ? selector(mockLang) : mockLang,
}));

const setActiveCompany = vi.fn();
const setCurrentView = vi.fn();
const push = vi.fn();

const authState = {
  user: { id: 'u1', email: 'owner@example.test', role: 'super_admin' as 'super_admin' | 'user' },
  activeCompany: { id: 'tenant', legalName: 'LQ & OM LLC' },
  logout: vi.fn(),
  sidebarOpen: false,
  setSidebarOpen: vi.fn(),
  setCurrentView,
  isProcessing: false,
  processingMessage: null as string | null,
};

vi.mock('@/store/auth-store', () => {
  const store = (selector?: (state: typeof authState) => unknown) =>
    selector ? selector(authState) : authState;
  store.getState = () => ({ setActiveCompany, setCurrentView });
  return { useAuthStore: store };
});

vi.mock('@/components/providers/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push }),
}));

// jsdom implements no ResizeObserver and the header renders Radix tooltips.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

vi.mock('@/components/app/SidebarNav', () => ({ SidebarNav: () => null }));
vi.mock('@/components/app/DesktopSidebar', () => ({ DesktopSidebar: () => null }));
vi.mock('@/components/spa/AIAssistantModal', () => ({ AIAssistantModal: () => null }));

import { AppShell } from '@/components/spa/AppShell';

function renderShell() {
  return render(
    <AppShell>
      <div>contenido</div>
    </AppShell>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: 'u1', email: 'owner@example.test', role: 'super_admin' };
});

afterEach(() => cleanup());

describe('company badge change affordance', () => {
  it('describes the switch for the installation owner', () => {
    renderShell();
    const change = screen.getByLabelText('common.change: common.changeCompanyHint');
    expect(change).toHaveTextContent('common.change');
  });

  it('leaves a non-owner with the plain button and no hint', () => {
    authState.user = { id: 'u2', email: 'contador@example.test', role: 'user' };
    renderShell();
    const change = screen.getByRole('button', { name: 'common.change' });
    expect(change).not.toHaveAttribute('aria-label');
  });

  it('explains the header controls instead of leaving bare icons', () => {
    renderShell();
    expect(screen.getByLabelText('common.languageHint')).toBeInTheDocument();
    expect(screen.getByLabelText('common.themeToggleHint')).toBeInTheDocument();
    expect(screen.getByLabelText('common.userMenu: common.accountMenuHint')).toBeInTheDocument();
    expect(screen.getByLabelText('LQ & OM LLC: common.viewCompanyStructureDetail')).toBeInTheDocument();
  });
});
