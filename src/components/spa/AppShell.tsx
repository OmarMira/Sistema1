'use client';

import { useCallback, useEffect } from 'react';
import {
  LayoutDashboard,
  BookOpen,
  FileText,
  Landmark,
  Upload,
  Scale,
  ArrowLeftRight,
  BarChart3,
  Download,
  Settings,
  Menu,
  LogOut,
  ChevronLeft,
  Building2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { DashboardPage } from '@/components/spa/DashboardPage';
import { AccountsPage } from '@/components/spa/AccountsPage';
import { JournalPage } from '@/components/spa/JournalPage';
import { BanksPage } from '@/components/spa/BanksPage';
import { ImportPage } from '@/components/spa/ImportPage';
import { BankRulesPage } from '@/components/spa/BankRulesPage';
import { ReconciliationPage } from '@/components/spa/ReconciliationPage';
import { ReportsPage } from '@/components/spa/ReportsPage';
import { ExportPage } from '@/components/spa/ExportPage';
import { SettingsPage } from '@/components/spa/SettingsPage';
import { UsersPage } from '@/components/spa/UsersPage';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type ViewName } from '@/store/auth-store';

/* ─── Navigation Items ─── */
interface NavItem {
  view: ViewName;
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
}

const navItems: NavItem[] = [
  { view: 'dashboard', icon: LayoutDashboard, labelKey: 'dashboard.title' },
  { view: 'accounts', icon: BookOpen, labelKey: 'accounts.title' },
  { view: 'journal', icon: FileText, labelKey: 'journal.title' },
  { view: 'banks', icon: Landmark, labelKey: 'banks.title' },
  { view: 'bank-rules', icon: Scale, labelKey: 'bankRules.title' },
  { view: 'reconciliation', icon: ArrowLeftRight, labelKey: 'reconciliation.title' },
  { view: 'reports', icon: BarChart3, labelKey: 'reports.title' },
  { view: 'export', icon: Download, labelKey: 'exportData.title' },
];

const settingsItem: NavItem = { view: 'settings', icon: Settings, labelKey: 'settings.title' };

/* ─── Sidebar Content (shared between desktop + mobile) ─── */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useLanguageStore((s) => s.t);
  const currentView = useAuthStore((s) => s.currentView);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  function handleNav(view: ViewName) {
    setCurrentView(view);
    onNavigate?.();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
          AE
        </div>
        <span className="text-lg font-semibold tracking-tight">
          {t('common.appName')}
        </span>
      </div>

      <Separator />

      {/* Nav links */}
      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-1 px-3">
          {navItems.map((item) => {
            const isActive = currentView === item.view;
            return (
              <button
                key={item.view}
                onClick={() => handleNav(item.view)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
      </ScrollArea>

      <Separator />

      {/* Settings + Logout */}
      <div className="p-3 space-y-1">
        <button
          onClick={() => handleNav('settings')}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            currentView === 'settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <settingsItem.icon className="size-4 shrink-0" />
          {t(settingsItem.labelKey)}
        </button>
      </div>
    </div>
  );
}

/* ─── Desktop Sidebar ─── */
function DesktopSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col border-r bg-card transition-all duration-300 shrink-0',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className={cn('flex h-14 items-center', collapsed ? 'justify-center px-2' : 'gap-2 px-4')}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
          AE
        </div>
        {!collapsed && (
          <span className="text-lg font-semibold tracking-tight truncate">
            AccountExpress
          </span>
        )}
      </div>

      <Separator />

      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-1 px-2">
          <DesktopNavItems collapsed={collapsed} />
        </nav>
      </ScrollArea>

      <Separator />

      <div className="p-2">
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-center rounded-lg py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft
            className={cn(
              'size-4 transition-transform',
              collapsed && 'rotate-180'
            )}
          />
        </button>
      </div>
    </aside>
  );
}

function DesktopNavItems({ collapsed }: { collapsed: boolean }) {
  const t = useLanguageStore((s) => s.t);
  const currentView = useAuthStore((s) => s.currentView);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  const allItems = [...navItems, settingsItem];

  return (
    <>
      {allItems.map((item) => {
        const isActive = currentView === item.view;
        return (
          <button
            key={item.view}
            onClick={() => setCurrentView(item.view)}
            title={collapsed ? t(item.labelKey) : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              collapsed ? 'justify-center' : 'w-full',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {!collapsed && t(item.labelKey)}
          </button>
        );
      })}
    </>
  );
}

/* ─── Main AppShell ─── */
export function AppShell() {
  const t = useLanguageStore((s) => s.t);
  const { user, activeCompany, logout, sidebarOpen, setSidebarOpen } =
    useAuthStore();
  const currentView = useAuthStore((s) => s.currentView);

  const initials = user
    ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
    : '??';

  const handleLogout = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    logout();
  }, [logout]);

  // Close mobile sidebar on nav change
  useEffect(() => {
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, [currentView, setSidebarOpen]);

  const pageTitle = t(
    `${navItems.find((i) => i.view === currentView)?.labelKey ?? settingsItem.labelKey}`
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <DesktopSidebar collapsed={!sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* ── Top Header ── */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 lg:px-6">
          {/* Mobile hamburger */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden">
                <Menu className="size-5" />
                <span className="sr-only">Menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <SidebarNav />
            </SheetContent>
          </Sheet>

          {/* Page title */}
          <h1 className="text-sm font-semibold truncate hidden sm:block">
            {pageTitle}
          </h1>

          <div className="flex-1" />

          {/* Right controls */}
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <ThemeToggle />

            {/* User menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full">
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
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
                {activeCompany && (
                  <>
                    <DropdownMenuItem disabled className="gap-2">
                      <Building2 className="size-4" />
                      <span className="truncate">{activeCompany.legalName}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem
                  onClick={() => useAuthStore.getState().setCurrentView('settings')}
                  className="gap-2"
                >
                  <Settings className="size-4" />
                  {t('settings.title')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleLogout}
                  variant="destructive"
                  className="gap-2"
                >
                  <LogOut className="size-4" />
                  {t('auth.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* ── Main Content Area ── */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          <div className="mx-auto max-w-7xl">
            <PlaceholderView view={currentView} />
          </div>
        </main>
      </div>
    </div>
  );
}

/* ─── Placeholder for sub-views ─── */
function PlaceholderView({ view }: { view: ViewName }) {
  const t = useLanguageStore((s) => s.t);

  // Real pages
  if (view === 'dashboard') {
    return <DashboardPage />;
  }
  if (view === 'accounts') {
    return <AccountsPage />;
  }
  if (view === 'journal') {
    return <JournalPage />;
  }
  if (view === 'banks') {
    return <BanksPage />;
  }
  if (view === 'import') {
    return <ImportPage />;
  }
  if (view === 'bank-rules') {
    return <BankRulesPage />;
  }
  if (view === 'reconciliation') {
    return <ReconciliationPage />;
  }
  if (view === 'reports') {
    return <ReportsPage />;
  }
  if (view === 'export') {
    return <ExportPage />;
  }
  if (view === 'settings') {
    return <SettingsPage />;
  }
  if (view === 'users') {
    return <UsersPage />;
  }

  // Map views to their title keys
  const viewKeyMap: Partial<Record<ViewName, string>> = {
    dashboard: 'dashboard.title',
    accounts: 'accounts.title',
    journal: 'journal.title',
    banks: 'banks.title',
    'bank-rules': 'bankRules.title',
    import: 'banks.uploadStatement',
    reconciliation: 'reconciliation.title',
    reports: 'reports.title',
    export: 'exportData.title',
    settings: 'settings.title',
    users: 'users.title',
    onboarding: 'onboarding.title',
  };

  const title = t(viewKeyMap[view] ?? 'dashboard.title');

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
        <LayoutDashboard className="size-8 text-primary" />
      </div>
      <div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('landing.comingSoon')}
        </p>
      </div>
    </div>
  );
}
