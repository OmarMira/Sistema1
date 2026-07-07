'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useLanguageStore } from '@/store/language-store';

export function StatusBadge({ status }: { status: string }) {
  const t = useLanguageStore((s) => s.t);
  const config: Record<string, { className: string; label: string }> = {
    draft: {
      className:
        'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700',
      label: t('journal.draft'),
    },
    posted: {
      className:
        'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
      label: t('journal.posted'),
    },
    void: {
      className:
        'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800',
      label: t('journal.void'),
    },
  };

  const c = config[status] ?? config.draft;
  return (
    <Badge variant="outline" className={cn('text-xs font-medium', c.className)}>
      {c.label}
    </Badge>
  );
}
