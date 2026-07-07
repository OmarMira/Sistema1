import { Landmark, Shield, Wallet, TrendingUp, Receipt } from 'lucide-react';

export interface TypeSectionConfig {
  key: string;
  i18nKey: string;
  accent: string;
  accentBg: string;
  accentText: string;
  accentBorder: string;
  accentBorderLight: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
}

export const TYPE_SECTION_CONFIG: TypeSectionConfig[] = [
  {
    key: 'asset',
    i18nKey: 'accounts.asset',
    accent: 'teal',
    accentBg: 'bg-teal-600 dark:bg-teal-500',
    accentText: 'text-white',
    accentBorder: 'border-teal-200 dark:border-teal-800',
    accentBorderLight: 'border-teal-100 dark:border-teal-900/50',
    icon: Landmark,
    iconBg: 'bg-teal-50 dark:bg-teal-950/40',
    iconColor: 'text-teal-600 dark:text-teal-400',
  },
  {
    key: 'liability',
    i18nKey: 'accounts.liability',
    accent: 'amber',
    accentBg: 'bg-amber-500 dark:bg-amber-600',
    accentText: 'text-white',
    accentBorder: 'border-amber-200 dark:border-amber-800',
    accentBorderLight: 'border-amber-100 dark:border-amber-900/50',
    icon: Shield,
    iconBg: 'bg-amber-50 dark:bg-amber-950/40',
    iconColor: 'text-amber-600 dark:text-amber-400',
  },
  {
    key: 'equity',
    i18nKey: 'accounts.equity',
    accent: 'violet',
    accentBg: 'bg-violet-600 dark:bg-violet-500',
    accentText: 'text-white',
    accentBorder: 'border-violet-200 dark:border-violet-800',
    accentBorderLight: 'border-violet-100 dark:border-violet-900/50',
    icon: Wallet,
    iconBg: 'bg-violet-50 dark:bg-violet-950/40',
    iconColor: 'text-violet-600 dark:text-violet-400',
  },
  {
    key: 'revenue',
    i18nKey: 'accounts.revenue',
    accent: 'emerald',
    accentBg: 'bg-emerald-600 dark:bg-emerald-500',
    accentText: 'text-white',
    accentBorder: 'border-emerald-200 dark:border-emerald-800',
    accentBorderLight: 'border-emerald-100 dark:border-emerald-900/50',
    icon: TrendingUp,
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/40',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    key: 'expense',
    i18nKey: 'accounts.expense',
    accent: 'rose',
    accentBg: 'bg-rose-600 dark:bg-rose-500',
    accentText: 'text-white',
    accentBorder: 'border-rose-200 dark:border-rose-800',
    accentBorderLight: 'border-rose-100 dark:border-rose-900/50',
    icon: Receipt,
    iconBg: 'bg-rose-50 dark:bg-rose-950/40',
    iconColor: 'text-rose-600 dark:text-rose-400',
  },
];

export const CODE_COLORS: Record<string, string> = {
  asset: 'text-teal-700 dark:text-teal-400',
  liability: 'text-amber-700 dark:text-amber-400',
  equity: 'text-violet-700 dark:text-violet-400',
  revenue: 'text-emerald-700 dark:text-emerald-400',
  expense: 'text-rose-700 dark:text-rose-400',
};

export const LINE_COLORS: Record<string, string> = {
  asset: 'border-teal-300 dark:border-teal-700',
  liability: 'border-amber-300 dark:border-amber-700',
  equity: 'border-violet-300 dark:border-violet-700',
  revenue: 'border-emerald-300 dark:border-emerald-700',
  expense: 'border-rose-300 dark:border-rose-700',
};

export function fmtCurrency(amount: number): string {
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

export const sectionVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.4, ease: 'easeOut' as const },
  }),
};

export const rowVariants = {
  hidden: { opacity: 0, x: -8 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.025, duration: 0.25, ease: 'easeOut' as const },
  }),
  exit: { opacity: 0, x: -8, transition: { duration: 0.15 } },
};
