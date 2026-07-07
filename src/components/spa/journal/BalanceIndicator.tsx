'use client';

import { CheckCircle2, XCircle } from 'lucide-react';

export function BalanceIndicator({ balanced }: { balanced: boolean }) {
  if (balanced) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-4" />
        Balanced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-red-600 dark:text-red-400">
      <XCircle className="size-4" />
      Out of Balance
    </span>
  );
}
