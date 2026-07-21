'use client';

import { cn } from '@/lib/utils';

interface ReadinessRecommendationBannerProps {
  status: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  t: (key: string) => string;
}

const STATUS_STYLES: Record<string, string> = {
  READY: 'border-green-500/30 bg-green-50 dark:bg-green-950/20 text-green-800 dark:text-green-300',
  NOT_READY: 'border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300',
  INSUFFICIENT_DATA: 'border-gray-500/30 bg-gray-50 dark:bg-gray-950/20 text-gray-700 dark:text-gray-300',
};

function getRecommendationKey(status: string): string {
  switch (status) {
    case 'READY': return 'admin.readiness.recommendation.ready';
    case 'NOT_READY': return 'admin.readiness.recommendation.notReady';
    case 'INSUFFICIENT_DATA': return 'admin.readiness.recommendation.insufficientData';
    default: return '';
  }
}

export default function ReadinessRecommendationBanner({ status, t }: ReadinessRecommendationBannerProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-4 text-sm font-medium',
        STATUS_STYLES[status] || STATUS_STYLES.INSUFFICIENT_DATA,
      )}
    >
      {t(getRecommendationKey(status))}
    </div>
  );
}
