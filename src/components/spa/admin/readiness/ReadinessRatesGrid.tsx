'use client';

import { CheckCircle, XCircle, MinusCircle } from 'lucide-react';
import type { ShadowMetricsReport } from '@/lib/services/shadow-metrics-reader';
import type { ReadinessCheckResult } from '@/lib/services/canonical-readiness-service';
import { getRatePassed, type RateKey } from '@/lib/readiness/rate-check-mapper';
import { cn } from '@/lib/utils';

interface ReadinessRatesGridProps {
  metrics: ShadowMetricsReport | null;
  checks: ReadinessCheckResult[];
  loading: boolean;
  t: (key: string) => string;
}

interface RateDef {
  key: RateKey;
  labelKey: string;
}

const RATES: RateDef[] = [
  { key: 'agreementRate', labelKey: 'admin.readiness.agreementRate' },
  { key: 'divergenceRate', labelKey: 'admin.readiness.divergenceRate' },
  { key: 'ambiguityRate', labelKey: 'admin.readiness.ambiguityRate' },
  { key: 'errorRate', labelKey: 'admin.readiness.errorRate' },
];

function formatRate(value: number | null): string {
  return value !== null ? `${(value * 100).toFixed(1)}%` : '—';
}

function getPassedIcon(passed: boolean | undefined): { icon: React.ComponentType<{ className?: string }>; color: string } {
  if (passed === true) return { icon: CheckCircle, color: 'text-green-600 dark:text-green-400' };
  if (passed === false) return { icon: XCircle, color: 'text-red-600 dark:text-red-400' };
  return { icon: MinusCircle, color: 'text-gray-400 dark:text-gray-500' };
}

function RateSkeleton() {
  return (
    <div className="rounded-2xl border shadow-sm bg-card text-card-foreground p-4 animate-pulse">
      <div className="h-3 w-16 bg-muted rounded mb-2" />
      <div className="h-5 w-12 bg-muted rounded" />
    </div>
  );
}

export default function ReadinessRatesGrid({ metrics, checks, loading, t }: ReadinessRatesGridProps) {
  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {RATES.map((r) => <RateSkeleton key={r.key} />)}
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {RATES.map((rate) => {
        const rateValue = metrics[rate.key] as number | null;
        const passed = getRatePassed(checks, rate.key);
        const { icon: Icon, color } = getPassedIcon(passed);
        return (
          <div
            key={rate.key}
            className="rounded-2xl border shadow-sm bg-card text-card-foreground p-4"
          >
            <p className="text-xs font-medium text-muted-foreground mb-1">{t(rate.labelKey)}</p>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold">{formatRate(rateValue)}</span>
              <Icon className={cn('size-5', color)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
