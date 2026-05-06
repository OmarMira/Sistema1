'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { LandingPage } from '@/components/spa/LandingPage';
import { LoginPage } from '@/components/spa/LoginPage';
import { RegisterPage } from '@/components/spa/RegisterPage';
import { SelectCompanyPage } from '@/components/spa/SelectCompanyPage';
import { AppShell } from '@/components/spa/AppShell';

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
  const { isAuthenticated, activeCompany, currentView, hydrate } =
    useAuthStore();
  const [hydrating, setHydrating] = useState(true);

  useEffect(() => {
    hydrate().finally(() => setHydrating(false));
  }, [hydrate]);

  if (hydrating) {
    return <LoadingScreen />;
  }

  // Not authenticated → show public pages
  if (!isAuthenticated) {
    return <UnauthView view={currentView} />;
  }

  // Authenticated but no company selected
  if (!activeCompany) {
    if (currentView === 'select-company') {
      return <SelectCompanyPage />;
    }
    // Force to select-company if no active company
    return <SelectCompanyPage />;
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
