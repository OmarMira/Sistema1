// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(() => cleanup());

const mockLangState = { t: (k: string) => k, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector?: (s: any) => any) => selector ? selector(mockLangState) : mockLangState,
}));

const mockSetCurrentView = vi.fn();
const mockLogin = vi.fn();
const mockAuthState = {
  login: mockLogin,
  setCurrentView: mockSetCurrentView,
  user: null,
  isAuthenticated: false,
  activeCompany: null,
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: (s: any) => any) => selector ? selector(mockAuthState) : mockAuthState,
}));

vi.mock('framer-motion', () => ({
  motion: { div: (props: any) => <div {...props} /> },
}));

import { BootstrapPage } from '@/components/spa/BootstrapPage';

describe('BootstrapPage — conditional card rendering', () => {
  afterEach(() => {
    mockSetCurrentView.mockClear();
    mockLogin.mockClear();
  });

  it('hasUsers=false → shows register card', () => {
    render(<BootstrapPage hasUsers={false} />);
    expect(screen.getByText('bootstrap.startFresh')).toBeInTheDocument();
    expect(screen.queryByText('auth.login')).not.toBeInTheDocument();
  });

  it('hasUsers=true → shows login card', () => {
    render(<BootstrapPage hasUsers={true} />);
    expect(screen.getAllByText('auth.login').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('bootstrap.startFresh')).not.toBeInTheDocument();
  });

  it('hasUsers=undefined → defaults to register card', () => {
    render(<BootstrapPage />);
    expect(screen.getByText('bootstrap.startFresh')).toBeInTheDocument();
    expect(screen.queryByText('auth.login')).not.toBeInTheDocument();
  });

  it('register button click → setCurrentView("register")', () => {
    render(<BootstrapPage hasUsers={false} />);
    const btn = screen.getByRole('button', { name: 'auth.register' });
    btn.click();
    expect(mockSetCurrentView).toHaveBeenCalledWith('register');
  });

  it('login button click → setCurrentView("login")', () => {
    render(<BootstrapPage hasUsers={true} />);
    const btn = screen.getByRole('button', { name: 'auth.login' });
    btn.click();
    expect(mockSetCurrentView).toHaveBeenCalledWith('login');
  });

  it('always shows restore backup option', () => {
    render(<BootstrapPage hasUsers={false} />);
    expect(screen.getByText('bootstrap.restoreBackup')).toBeInTheDocument();
  });
});
