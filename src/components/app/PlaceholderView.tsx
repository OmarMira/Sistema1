'use client';

import { LayoutDashboard } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { type ViewName } from '@/store/auth-store';
import { DashboardPage } from '@/components/spa/DashboardPage';
import { AccountsPage } from '@/components/spa/AccountsPage';
import { JournalPage } from '@/components/spa/JournalPage';
import { BanksPage } from '@/components/spa/BanksPage';
import { ImportPage } from '@/components/spa/ImportPage';
import { BankRulesPage } from '@/components/spa/BankRulesPage';
import { ReconciliationPage } from '@/components/spa/ReconciliationPage';
import { ReportsPage } from '@/components/spa/ReportsPage';
import { ExportPage } from '@/components/spa/ExportPage';
import { MovementSummaryPage } from '@/components/spa/MovementSummaryPage';
import { SettingsPage } from '@/components/spa/SettingsPage';
import { UsersPage } from '@/components/spa/UsersPage';
import { SelectCompanyPage } from '@/components/spa/SelectCompanyPage';
import { FinancialDashboardPage } from '@/components/spa/FinancialDashboardPage';
import { EntityManagementPage } from '@/components/spa/EntityManagementPage';
import { CompanyStructureView } from '@/components/spa/CompanyStructureView';
import { WorkflowPanel } from '@/components/workflow/WorkflowPanel';

export function PlaceholderView({ view }: { view: ViewName }) {
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
  if (view === 'movement-summary') {
    return <MovementSummaryPage />;
  }
  if (view === 'settings') {
    return <SettingsPage />;
  }
  if (view === 'users') {
    return <UsersPage />;
  }
  if (view === 'select-company') {
    return <SelectCompanyPage />;
  }
  if (view === 'financial-dashboard') {
    return <FinancialDashboardPage />;
  }
  if (view === 'workflow') {
    return <WorkflowPanel />;
  }
  if (view === 'entity-management') {
    return <EntityManagementPage />;
  }
  if (view === 'company-structure') {
    return <CompanyStructureView />;
  }

  // Map views to their title keys
  const viewKeyMap: Partial<Record<ViewName, string>> = {
    dashboard: 'dashboard.title',
    'financial-dashboard': 'financialDashboard.title',
    accounts: 'accounts.title',
    journal: 'journal.title',
    banks: 'banks.title',
    'bank-rules': 'bankRules.title',
    import: 'banks.uploadStatement',
    reconciliation: 'reconciliation.title',
    reports: 'reports.title',
    export: 'exportData.title',
    'movement-summary': 'movementSummary.title',
    settings: 'settings.title',
    users: 'users.title',
    onboarding: 'onboarding.title',
    'entity-management': 'sidebar.entityManagement',
    'company-structure': 'companyStructure.title',
  };

  const title = t(viewKeyMap[view] ?? 'dashboard.title');

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
        <LayoutDashboard className="size-8 text-primary" />
      </div>
      <div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('landing.comingSoon')}</p>
      </div>
    </div>
  );
}
