'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Menu,
  LogOut,
  Settings,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { AIAssistantModal } from '@/components/spa/AIAssistantModal';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarNav } from '@/components/app/SidebarNav';
import { DesktopSidebar } from '@/components/app/DesktopSidebar';
import { PlaceholderView } from '@/components/app/PlaceholderView';
import { ViewErrorBoundary } from '@/components/app/ViewErrorBoundary';
import { navItems, settingsItem } from '@/lib/constants/app-navigation';









/* ─── Main AppShell ─── */
export function AppShell({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const t = useLanguageStore((s) => s.t);
  const pathname = usePathname();
  const { user, activeCompany, logout, sidebarOpen, setSidebarOpen, setCurrentView } =
    useAuthStore();
  const currentView = useAuthStore((s) => s.currentView);

  const initials = user
    ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
    : '??';

  const handleLogout = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    logout();
  }, [logout]);

  const handleChangeCompany = useCallback(() => {
    useAuthStore.getState().setActiveCompany(null);
    useAuthStore.getState().setCurrentView('select-company');
    router.push('/');
  }, [router]);

  const handleOpenCompanyStructure = useCallback(() => {
    setCurrentView('company-structure');
  }, [setCurrentView]);

  // Only the installation owner actually switches between companies; the hint is
  // therefore shown to that account alone.
  const canChangeCompany = user?.role === 'super_admin';
  const isProcessing = useAuthStore((s) => s.isProcessing);
  const processingMessage = useAuthStore((s) => s.processingMessage);

  // Close mobile sidebar on nav change
  useEffect(() => {
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, [currentView, setSidebarOpen]);

  const pageTitle = t(
    `${navItems.find((i) => i.view === currentView)?.labelKey ?? settingsItem.labelKey}`,
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* S11 — keyboard and screen-reader users land on the shell chrome first;
          the skip link jumps straight into the view content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[10000] focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
      >
        Saltar al contenido principal
      </a>
      {/* Global Processing Loader Overlay */}
      {isProcessing && (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/40 backdrop-blur-sm transition-all duration-300 animate-in fade-in"
        >
          <div className="flex flex-col items-center gap-5 rounded-2xl border bg-card/85 p-8 shadow-2xl backdrop-blur-xl border-border/50 max-w-sm text-center">
            <div className="relative flex items-center justify-center size-20">
              {/* Outer glow ring */}
              <div className="absolute inset-0 rounded-full border-t-2 border-r-2 border-primary animate-spin" />
              {/* Inner glow ring running counter-clockwise */}
              <div className="absolute inset-2 rounded-full border-b-2 border-l-2 border-indigo-500 animate-spin [animation-direction:reverse]" />
              {/* Inner core spinner icon */}
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <Loader2 aria-hidden="true" className="size-5 animate-spin text-primary" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="font-semibold text-sm tracking-tight text-foreground">
                {processingMessage === 'Procesando...' ? t('common.processing') : processingMessage}
              </h3>
              <p className="text-xs text-muted-foreground">{t('common.pleaseWait')}</p>
            </div>
          </div>
        </div>
      )}

      {/* AI Assistant Modal */}
      <AIAssistantModal />

      {/* Desktop sidebar */}
      <DesktopSidebar
        collapsed={!sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onOpenWorkflow={() => {
          if (pathname !== '/') {
            router.push('/');
          }
          setCurrentView('workflow');
        }}
      />

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* ── Top Header ── */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 lg:px-6">
          {/* Mobile hamburger */}
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Abrir menú de navegación"
              >
                <Menu aria-hidden="true" className="size-5" />
                <span className="sr-only">Menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <SidebarNav
                onNavigate={() => setMobileNavOpen(false)}
                onOpenWorkflow={() => {
                  if (pathname !== '/') {
                    router.push('/');
                  }
                  setCurrentView('workflow');
                  setMobileNavOpen(false);
                }}
              />
            </SheetContent>
          </Sheet>

          {/* Company badge */}
          {activeCompany && (
            <div className="hidden md:flex items-center gap-2 rounded-md border px-2.5 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                {t('common.companyActive')}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleOpenCompanyStructure}
                    className="text-sm font-medium truncate max-w-[140px] hover:text-primary transition-colors"
                    aria-label={`${activeCompany.legalName}: ${t('common.viewCompanyStructureDetail')}`}
                  >
                    {activeCompany.legalName}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <div className="space-y-1">
                    <p className="font-medium">{t('common.viewCompanyStructure')}</p>
                    <p>{t('common.viewCompanyStructureDetail')}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
              {canChangeCompany ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleChangeCompany}
                      className="text-xs text-primary hover:underline font-medium"
                      aria-label={`${t('common.change')}: ${t('common.changeCompanyHint')}`}
                    >
                      {t('common.change')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('common.changeCompanyHint')}</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  onClick={handleChangeCompany}
                  className="text-xs text-primary hover:underline font-medium"
                >
                  {t('common.change')}
                </button>
              )}
            </div>
          )}

          <div className="flex-1" />

          {/* AES Encryption Badge */}
          <div className="hidden lg:flex items-center gap-1.5 rounded-md border px-2.5 py-1">
            <ShieldCheck aria-hidden="true" className="size-3.5 text-emerald-600" />
            <span className="text-[11px] font-medium text-muted-foreground">AES</span>
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <ThemeToggle />

            {/* User menu */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      aria-label={`${t('common.userMenu')}: ${t('common.accountMenuHint')}`}
                    >
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('common.accountMenuHint')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">
                      {user?.firstName} {user?.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">{user?.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={() => useAuthStore.getState().setCurrentView('settings')}
                  className="gap-2"
                >
                  <Settings aria-hidden="true" className="size-4" />
                  {t('settings.title')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} variant="destructive" className="gap-2">
                  <LogOut aria-hidden="true" className="size-4" />
                  {t('auth.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* ── Main Content Area ── */}
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-4 lg:p-6">
          <div className="mx-auto max-w-7xl">
            {children ? children : (
              <ViewErrorBoundary key={currentView}>
                <PlaceholderView view={currentView} />
              </ViewErrorBoundary>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}


