// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// ── Mock child components to marker elements ──
vi.mock('@/components/spa/BootstrapPage', () => ({
  BootstrapPage: (props: any) => <div data-testid="bootstrap-page" data-has-users={String(props.hasUsers)} />,
}));
vi.mock('@/components/spa/LoginPage', () => ({
  LoginPage: () => <div data-testid="login-page" />,
}));
vi.mock('@/components/spa/RegisterPage', () => ({
  RegisterPage: () => <div data-testid="register-page" />,
}));
vi.mock('@/components/spa/LandingPage', () => ({
  LandingPage: () => <div data-testid="landing-page" />,
}));
vi.mock('@/components/spa/SelectCompanyPage', () => ({
  SelectCompanyPage: () => <div data-testid="select-company-page" />,
}));
vi.mock('@/components/spa/AppShell', () => ({
  AppShell: () => <div data-testid="app-shell" />,
}));
vi.mock('@/components/spa/admin/SuperAdminDashboardPage', () => ({
  __esModule: true,
  default: () => <div data-testid="admin-page" />,
}));
vi.mock('@/components/onboarding/OnboardingWizard', () => ({
  OnboardingWizard: () => <div data-testid="onboarding-wizard" />,
}));

// ── Mock auth store ──
const mockHydrate = vi.fn().mockResolvedValue(undefined);
let mockAuthState: any = {};

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: (s: any) => any) => {
    const state = {
      isAuthenticated: false,
      activeCompany: null,
      currentView: 'landing',
      hydrate: mockHydrate,
      ...mockAuthState,
    };
    return selector ? selector(state) : state;
  },
}));

// ── Mock fetch for /api/bootstrap/check ──
const mockFetch = vi.fn();

// ── Import AFTER mocks ──
import AppContent from '@/app/page';

describe('AppContent — BootstrapPage gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHydrate.mockResolvedValue(undefined);
    globalThis.fetch = mockFetch;
  });

  it('unauth + dbEmpty + landing → BootstrapPage', async () => {
    mockAuthState = { isAuthenticated: false, currentView: 'landing' };
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ empty: true, hasUsers: false }) });

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('bootstrap-page')).toBeInTheDocument();
    });
  });

  it('unauth + dbEmpty + login → LoginPage (NOT BootstrapPage)', async () => {
    mockAuthState = { isAuthenticated: false, currentView: 'login' };
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ empty: true, hasUsers: true }) });

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('bootstrap-page')).not.toBeInTheDocument();
  });

  it('unauth + dbEmpty + register → RegisterPage (NOT BootstrapPage)', async () => {
    mockAuthState = { isAuthenticated: false, currentView: 'register' };
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ empty: true, hasUsers: false }) });

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('register-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('bootstrap-page')).not.toBeInTheDocument();
  });

  it('unauth + !dbEmpty + landing → LandingPage (NOT BootstrapPage)', async () => {
    mockAuthState = { isAuthenticated: false, currentView: 'landing' };
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ empty: false, hasUsers: true }) });

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('landing-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('bootstrap-page')).not.toBeInTheDocument();
  });

  it('authenticated + any view → NOT BootstrapPage', async () => {
    mockAuthState = {
      isAuthenticated: true,
      currentView: 'dashboard',
      activeCompany: { id: 'c1', isOnboardingComplete: true },
    };

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.queryByTestId('bootstrap-page')).not.toBeInTheDocument();
    });
  });
});

describe('AppContent — RC2-4 onboarding gate (register/onboarding reachability)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHydrate.mockResolvedValue(undefined);
    globalThis.fetch = mockFetch;
  });

  it('post-register state (role=user, activeCompany WITHOUT role, onboarding incomplete) → OnboardingWizard, NOT AppShell', async () => {
    // Mirrors register flow wire state: User.role='user', activeCompany.role=undefined
    // (register response omits role), isOnboardingComplete=false (schema default).
    mockAuthState = {
      isAuthenticated: true,
      currentView: 'dashboard',
      user: { id: 'u1', role: 'user', firstName: 'T', lastName: 'U' },
      activeCompany: { id: 'c1', legalName: 'Fresh Co', taxId: null, isOnboardingComplete: false },
    };

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('select-company-page')).not.toBeInTheDocument();
  });

  it('empty onboarding completion state (create-company path, isOnboardingComplete falsy) → OnboardingWizard, NOT AppShell', async () => {
    mockAuthState = {
      isAuthenticated: true,
      currentView: 'dashboard',
      activeCompany: { id: 'c2', role: undefined as string | undefined },
    };

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('PROOF: role=undefined + isOnboardingComplete truthy WOULD reach AppShell (gate invariant)', async () => {
    // Documents the invariant: the ONLY thing keeping role-less states out of
    // UsersPage/FinancialAssistantPanel is the isOnboardingComplete gate. Within
    // register/select-company/onboarding/hydrate, no flow produces this state.
    mockAuthState = {
      isAuthenticated: true,
      currentView: 'dashboard',
      activeCompany: { id: 'c3', role: undefined as string | undefined, isOnboardingComplete: true },
    };

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
  });
});

describe('AppContent — RC2-4 post-restore authority (bootstrap/restore role contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHydrate.mockResolvedValue(undefined);
    globalThis.fetch = mockFetch;
  });

  it('restored company_admin (role=company_admin, onboarding complete) → AppShell reachable', async () => {
    // Mirrors bootstrap/restore response post-fix: User.role='user' +
    // activeCompany.role='company_admin' + isOnboardingComplete=true.
    mockAuthState = {
      isAuthenticated: true,
      currentView: 'dashboard',
      user: { id: 'u1', role: 'user', firstName: 'Rest', lastName: 'Admin' },
      activeCompany: { id: 'c1', role: 'company_admin', isOnboardingComplete: true },
    };

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('select-company-page')).not.toBeInTheDocument();
  });

  it('restored super_admin (role=null, onboarding complete) → AppShell reachable (global authority)', async () => {
    mockAuthState = {
      isAuthenticated: true,
      currentView: 'dashboard',
      user: { id: 'u1', role: 'super_admin', firstName: 'Rest', lastName: 'Super' },
      activeCompany: { id: 'c1', role: null, isOnboardingComplete: true },
    };

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
  });
});
