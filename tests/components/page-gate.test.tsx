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
