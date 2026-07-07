'use client';

import { Badge } from '@/components/ui/badge';
import { useLanguageStore } from '@/store/language-store';

const BALANCE_STYLES: Record<string, string> = {
  debit:
    'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  credit:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
};

const BALANCE_KEYS: Record<string, string> = {
  debit: 'accounts.debit',
  credit: 'accounts.credit',
};

interface BalanceBadgeProps {
  normalBalance: string;
  className?: string;
}

export function BalanceBadge({ normalBalance, className }: BalanceBadgeProps) {
  const t = useLanguageStore((s) => s.t);
  const label = t(BALANCE_KEYS[normalBalance] ?? normalBalance);
  const style =
    BALANCE_STYLES[normalBalance] ??
    'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';

  return (
    <Badge variant="outline" className={`font-medium ${style} ${className ?? ''}`}>
      {label}
    </Badge>
  );
}
