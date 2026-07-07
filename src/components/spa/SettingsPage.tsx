'use client';

import { useState } from 'react';
import {
  Settings,
  Building2,
  Users,
  Shield,
  Calendar,
  Database,
  Zap,
  Activity,
  Bot,
  Sparkles,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { UserProfileTab } from './settings/UserProfileTab';
import { CompanyDataTab } from './settings/CompanyDataTab';
import { UsersTab } from './settings/UsersTab';
import { RolesTab } from './settings/RolesTab';
import { FiscalPeriodsTab } from './settings/FiscalPeriodsTab';
import { BackupTab } from './settings/BackupTab';
import { DiagnosticsTab } from './settings/DiagnosticsTab';
import AiConfigTab from './settings/AiConfigTab';
import { EntityManagementPage } from '@/components/spa/EntityManagementPage';

/* ─── Navigation Items ───────────────────────────────────────── */

interface NavItem {
  id: string;
  labelKey: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { id: 'user-profile', labelKey: 'settings.userProfile', icon: Users },
  { id: 'company', labelKey: 'settings.companyData', icon: Building2 },
  { id: 'users', labelKey: 'settings.userManagement', icon: Users },
  { id: 'roles', labelKey: 'settings.rolesPermissions', icon: Shield },
  { id: 'entity-management', labelKey: 'entityManagement.title', icon: Sparkles },
  { id: 'periods', labelKey: 'settings.fiscalPeriodsTab', icon: Calendar },
  { id: 'backup', labelKey: 'settings.systemBackup', icon: Database },
  { id: 'diagnostics', labelKey: 'settings.diagnosticsTab', icon: Activity },
  { id: 'ai-config', labelKey: 'settings.aiConfigTab', icon: Bot },
];

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
};
const contentVariants = {
  hidden: { opacity: 0, x: 10 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.2 } },
  exit: { opacity: 0, x: -10, transition: { duration: 0.15 } },
};

/* ─── Settings Page ───────────────────────────────────────────── */

export function SettingsPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const activeTab = useAuthStore((s) => s.settingsActiveTab);
  const setActiveTab = useAuthStore((s) => s.setSettingsActiveTab);

  const subtitle = activeCompany?.legalName
    ? t('settings.systemSubtitle').replace('{company}', activeCompany.legalName)
    : '';

  function renderContent() {
    switch (activeTab) {
      case 'user-profile':
        return <UserProfileTab />;
      case 'company':
        return <CompanyDataTab />;
      case 'users':
        return <UsersTab />;
      case 'roles':
        return <RolesTab />;
      case 'entity-management':
        return <EntityManagementPage />;
      case 'periods':
        return <FiscalPeriodsTab />;
      case 'backup':
        return <BackupTab />;
      case 'diagnostics':
        return <DiagnosticsTab />;
      case 'ai-config':
        return <AiConfigTab />;
      default:
        return <UserProfileTab />;
    }
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10">
            <Settings className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('settings.systemTitle')}</h1>
            {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
        </div>
      </motion.div>

      {/* Layout: Sidebar + Content */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left Sidebar */}
        <motion.div variants={itemVariants} className="lg:w-64 shrink-0">
          <nav className="rounded-xl border bg-card p-2 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={cn(
                    'flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-sm font-medium transition-all text-left',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', isActive && 'text-primary')} />
                  <span>{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </motion.div>

        {/* Right Content */}
        <div className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              variants={contentVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              {renderContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
