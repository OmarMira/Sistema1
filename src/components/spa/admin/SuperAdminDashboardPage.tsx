'use client';

import React, { useState, useEffect } from 'react';
import {
  Building2,
  Users,
  Activity,
  ArrowLeft,
  ShieldAlert,
  Cpu,
  LogOut,
} from 'lucide-react';
import { useAuthStore, type ViewName } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';

// Import admin sub-components
import AdminCompaniesPage from './AdminCompaniesPage';
import AdminUsersPage from './AdminUsersPage';
import AdminAuditLogsPage from './AdminAuditLogsPage';
import AdminCompanyDetailPage from './AdminCompanyDetailPage';
import { logger } from '@/lib/logger';
import { AdminStatCards, AdminQuickActions } from '@/components/dashboard/DashboardPageBlocks';

// Nav menu item component
interface NavBtnProps {
  viewName: ViewName;
  currentView: string;
  setCurrentView: (view: ViewName) => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

const NavBtn = ({ viewName, currentView, setCurrentView, icon: Icon, label }: NavBtnProps) => {
  const isActive = currentView === viewName;
  return (
    <button
      onClick={() => setCurrentView(viewName)}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200',
        isActive
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 font-semibold'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </button>
  );
};

export default function SuperAdminDashboardPage() {
  const t = useLanguageStore((s) => s.t);
  const { user, currentView, setCurrentView, logout } = useAuthStore();

  const [stats, setStats] = useState({
    companiesCount: 0,
    usersCount: 0,
    logsCount: 0,
    systemLoad: '0%',
  });
  const [statsLoading, setStatsLoading] = useState(true);

  // Load stats from API
  useEffect(() => {
    async function loadStats() {
      setStatsLoading(true);
      try {
        const res = await fetch('/api/admin/stats');
        if (res.ok) {
          const data = await res.json();
          setStats({
            companiesCount: data.companiesCount || 0,
            usersCount: data.usersCount || 0,
            logsCount: data.logsCount || 0,
            systemLoad: `${Math.floor(Math.random() * 12) + 5}%`,
          });
        }
      } catch (err) {
        logger.error('Error loading stats:', { error: String(err) });
      } finally {
        setStatsLoading(false);
      }
    }
    loadStats();
  }, [currentView]);

  const handleLogout = () => {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    logout();
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* ── Sidebar ── */}
      <aside className="w-64 border-r bg-card flex flex-col shrink-0 shadow-sm">
        {/* Logo & Header */}
        <div className="flex h-16 items-center gap-2.5 px-6 border-b">
          <div className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white font-bold text-base shadow-md shadow-indigo-500/20">
            AE
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none text-foreground">AccountExpress</h1>
            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Super Admin
            </span>
          </div>
        </div>

        {/* Sidebar Nav */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          <div className="space-y-1">
            <NavBtn
              viewName="admin-dashboard"
              currentView={currentView}
              setCurrentView={setCurrentView}
              icon={Cpu}
              label={t('superAdmin.dashboard')}
            />
            <NavBtn
              viewName="admin-companies"
              currentView={currentView}
              setCurrentView={setCurrentView}
              icon={Building2}
              label={t('superAdmin.companies')}
            />
            <NavBtn
              viewName="admin-users"
              currentView={currentView}
              setCurrentView={setCurrentView}
              icon={Users}
              label={t('superAdmin.users')}
            />
            <NavBtn
              viewName="admin-audit-logs"
              currentView={currentView}
              setCurrentView={setCurrentView}
              icon={Activity}
              label={t('superAdmin.logs')}
            />
          </div>
        </div>

        <Separator />

        {/* Sidebar Footer */}
        <div className="p-4 space-y-2 bg-muted/20">
          <button
            onClick={() => setCurrentView('select-company')}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
          >
            <ArrowLeft className="size-4 shrink-0" />
            {t('superAdmin.selectCompany')}
          </button>

          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-rose-600 hover:bg-rose-500/10 transition-colors"
          >
            <LogOut className="size-4 shrink-0" />
            {t('auth.logout')}
          </button>
        </div>
      </aside>

      {/* ── Main Area ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b bg-background px-6">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-foreground capitalize tracking-tight">
              {currentView === 'admin-dashboard' && t('superAdmin.mainDashboardTitle')}
              {currentView === 'admin-companies' && t('superAdmin.manageCompaniesTitle')}
              {currentView === 'admin-company-detail' && t('superAdmin.companyDetailTitle')}
              {currentView === 'admin-users' && t('superAdmin.manageUsersTitle')}
              {currentView === 'admin-audit-logs' && t('superAdmin.logsTitle')}
            </h2>
          </div>

          <div className="flex items-center gap-4">
            <LanguageSelector />
            <ThemeToggle />
            <div className="flex items-center gap-3 border-l pl-4">
              <div className="flex size-9 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 font-bold text-sm">
                {user
                  ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
                  : 'AD'}
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-xs font-semibold text-foreground leading-none">
                  {user ? `${user.firstName} ${user.lastName}` : 'Administrador'}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-none">
                  {t('superAdmin.roleSuperAdmin')}
                </p>
              </div>
            </div>
          </div>
        </header>

        {/* Content Pane */}
        <main className="flex-1 overflow-auto bg-muted/10 p-6 lg:p-8">
          <div className="mx-auto max-w-7xl h-full">
            {currentView === 'admin-dashboard' && (
              <div className="space-y-8 animate-in fade-in duration-200">
                {/* Hero / Welcome card */}
                <div className="relative overflow-hidden rounded-3xl border bg-gradient-to-r from-indigo-900 via-indigo-950 to-slate-900 p-8 text-white shadow-xl">
                  <div className="relative z-10 max-w-xl space-y-3">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/30 px-3 py-1 text-xs font-semibold text-indigo-200">
                      <ShieldAlert className="size-3.5" />
                      {t('superAdmin.authorizedAccess')}
                    </span>
                    <h3 className="text-3xl font-extrabold tracking-tight">
                      {t('superAdmin.welcomeBack').replace('{name}', user?.firstName || '')}
                    </h3>
                    <p className="text-sm text-indigo-200/90 leading-relaxed">{t('superAdmin.heroDesc')}</p>
                  </div>
                  <div className="absolute right-0 top-0 h-full w-1/3 bg-gradient-to-l from-indigo-500/10 to-transparent pointer-events-none" />
                </div>

                <AdminStatCards t={t} stats={stats} loading={statsLoading} onNavigate={(v) => setCurrentView(v as ViewName)} />

                <AdminQuickActions t={t} onNavigate={(v) => setCurrentView(v as ViewName)} />
              </div>
            )}

            {currentView === 'admin-companies' && <AdminCompaniesPage />}
            {currentView === 'admin-company-detail' && <AdminCompanyDetailPage />}
            {currentView === 'admin-users' && <AdminUsersPage />}
            {currentView === 'admin-audit-logs' && <AdminAuditLogsPage />}
          </div>
        </main>
      </div>
    </div>
  );
}
