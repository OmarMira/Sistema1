'use client';

import { Badge } from '@/components/ui/badge';
import { useLanguageStore } from '@/store/language-store';

const ACCOUNT_TYPE_STYLES: Record<string, string> = {
  asset: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  liability: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  equity: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  revenue: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  expense: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

const ACCOUNT_TYPE_KEYS: Record<string, string> = {
  asset: 'accounts.asset',
  liability: 'accounts.liability',
  equity: 'accounts.equity',
  revenue: 'accounts.revenue',
  expense: 'accounts.expense',
};

interface AccountTypeBadgeProps {
  accountType: string;
  className?: string;
}

export function AccountTypeBadge({ accountType, className }: AccountTypeBadgeProps) {
  const t = useLanguageStore((s) => s.t);
  const label = t(ACCOUNT_TYPE_KEYS[accountType] ?? accountType);
  const style = ACCOUNT_TYPE_STYLES[accountType] ?? 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';

  return (
    <Badge variant="outline" className={`font-medium ${style} ${className ?? ''}`}>
      {label}
    </Badge>
  );
}
