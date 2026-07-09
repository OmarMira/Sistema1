'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { LandingPage } from '@/components/spa/LandingPage';
import { LoginPage } from '@/components/spa/LoginPage';
import { RegisterPage } from '@/components/spa/RegisterPage';
import { SelectCompanyPage } from '@/components/spa/SelectCompanyPage';
import { AppShell } from '@/components/spa/AppShell';
import SuperAdminDashboardPage from '@/components/spa/admin/SuperAdminDashboardPage';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { BootstrapPage } from '@/components/spa/BootstrapPage';

/* ── Loading Spinner ── */
function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

/* ── Unauthenticated Views ── */
const UnauthView = ({ view }: { view: string }) => {
  switch (view) {
    case 'login':
      return <LoginPage />;
    case 'register':
      return <RegisterPage />;
    case 'landing':
    default:
      return <LandingPage />;
  }
};

/* ── Main SPA Router ── */
function AppContent() {
  const { isAuthenticated, activeCompany, currentView, hydrate } = useAuthStore();
  const [hydrating, setHydrating] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [dbEmpty, setDbEmpty] = useState<boolean | null>(null);

  useEffect(() => {
    setMounted(true);
    hydrate().finally(() => setHydrating(false));
  }, [hydrate]);

  useEffect(() => {
    if (!mounted) return;
    if (!isAuthenticated) {
      fetch('/api/bootstrap/check')
        .then((r) => r.json())
        .then((data) => setDbEmpty(data.empty))
        .catch(() => setDbEmpty(false));
    } else {
      setDbEmpty(false);
    }
  }, [isAuthenticated, mounted]);

  if (!mounted || hydrating || dbEmpty === null) {
    return <LoadingScreen />;
  }

  // DB is empty → show bootstrap choice
  if (!isAuthenticated && dbEmpty) {
    return <BootstrapPage />;
  }

  // Not authenticated → show public pages
  if (!isAuthenticated) {
    return <UnauthView view={currentView} />;
  }

  // Authenticated but no company selected, or switching companies
  const isAdminView = [
    'admin-companies',
    'admin-company-detail',
    'admin-users',
    'admin-audit-logs',
    'admin-dashboard',
  ].includes(currentView);

  if (isAdminView) {
    return <SuperAdminDashboardPage />;
  }

  if ((currentView === 'select-company' || !activeCompany) && !isAdminView) {
    return <SelectCompanyPage />;
  }

  // Intercept if onboarding is incomplete
  if (activeCompany && !activeCompany.isOnboardingComplete && !isAdminView) {
    return <OnboardingWizard />;
  }

  // Fully authenticated → show app shell
  return <AppShell />;
}

const MemoizedAppContent = (props: { children?: ReactNode }) => {
  void props;
  return <AppContent />;
};
MemoizedAppContent.displayName = 'MemoizedAppContent';

export default function Home() {
  return <MemoizedAppContent />;
}
