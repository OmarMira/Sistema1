'use client';

import { AlertTriangle } from 'lucide-react';
import type { TrustPolicyOption } from '@/lib/readiness/default-readiness-profile';

interface TrustPolicyWarningProps {
  trustPolicy: TrustPolicyOption;
  legacyUntrustedBatches: number;
  t: (key: string) => string;
}

export default function TrustPolicyWarning({ trustPolicy, legacyUntrustedBatches, t }: TrustPolicyWarningProps) {
  if (trustPolicy !== 'INCLUDE_UNTRUSTED_HISTORY' || legacyUntrustedBatches <= 0) return null;

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            {t('admin.readiness.untrustedWarning')}
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t('admin.readiness.untrustedWarningDesc')}
          </p>
        </div>
      </div>
    </div>
  );
}
