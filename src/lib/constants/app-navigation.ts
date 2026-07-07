import {
  LayoutDashboard,
  TrendingUp,
  BookOpen,
  FileText,
  Landmark,
  Scale,
  ArrowLeftRight,
  BarChart3,
  Download,
  Settings,
  Activity,
} from 'lucide-react';
import { type ViewName } from '@/store/auth-store';

export type { ViewName };

export interface NavItem {
  view: ViewName;
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
  tooltipKey: string;
}

export const navItems: NavItem[] = [
  {
    view: 'dashboard',
    icon: LayoutDashboard,
    labelKey: 'dashboard.title',
    tooltipKey: 'sidebar.dashboard',
  },
  {
    view: 'financial-dashboard',
    icon: TrendingUp,
    labelKey: 'financialDashboard.title',
    tooltipKey: 'sidebar.financialDashboard',
  },
  {
    view: 'accounts',
    icon: BookOpen,
    labelKey: 'accounts.title',
    tooltipKey: 'sidebar.accounts',
  },
  {
    view: 'journal',
    icon: FileText,
    labelKey: 'journal.title',
    tooltipKey: 'sidebar.journal',
  },
  {
    view: 'banks',
    icon: Landmark,
    labelKey: 'banks.title',
    tooltipKey: 'sidebar.banks',
  },
  {
    view: 'bank-rules',
    icon: Scale,
    labelKey: 'bankRules.title',
    tooltipKey: 'sidebar.bankRules',
  },
  {
    view: 'reconciliation',
    icon: ArrowLeftRight,
    labelKey: 'reconciliation.title',
    tooltipKey: 'sidebar.reconciliation',
  },
  {
    view: 'movement-summary',
    icon: Activity,
    labelKey: 'movementSummary.title',
    tooltipKey: 'sidebar.movementSummary',
  },
  {
    view: 'reports',
    icon: BarChart3,
    labelKey: 'reports.title',
    tooltipKey: 'sidebar.reports',
  },
  {
    view: 'export',
    icon: Download,
    labelKey: 'exportData.title',
    tooltipKey: 'sidebar.export',
  },
];

export const settingsItem: NavItem = {
  view: 'settings',
  icon: Settings,
  labelKey: 'settings.title',
  tooltipKey: 'sidebar.settings',
};
