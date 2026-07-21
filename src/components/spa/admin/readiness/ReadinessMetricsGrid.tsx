'use client';

import type { ShadowMetricsReport } from '@/lib/services/shadow-metrics-reader';

type NumericMetricKey = 'batches' | 'totalEvaluated' | 'validComparisons' | 'sameDecision' | 'divergentDecision' | 'ambiguous' | 'errors';

interface ReadinessMetricsGridProps {
  metrics: ShadowMetricsReport | null;
  loading: boolean;
  t: (key: string) => string;
}

interface MetricDef {
  key: NumericMetricKey;
  labelKey: string;
}

const METRICS: MetricDef[] = [
  { key: 'batches', labelKey: 'admin.readiness.batches' },
  { key: 'totalEvaluated', labelKey: 'admin.readiness.totalEvaluated' },
  { key: 'validComparisons', labelKey: 'admin.readiness.validComparisons' },
  { key: 'sameDecision', labelKey: 'admin.readiness.sameDecision' },
  { key: 'divergentDecision', labelKey: 'admin.readiness.divergentDecision' },
  { key: 'ambiguous', labelKey: 'admin.readiness.ambiguous' },
  { key: 'errors', labelKey: 'admin.readiness.errors' },
];

function MetricSkeleton() {
  return (
    <div className="rounded-2xl border shadow-sm bg-card text-card-foreground p-4 animate-pulse">
      <div className="h-3 w-20 bg-muted rounded mb-2" />
      <div className="h-6 w-12 bg-muted rounded" />
    </div>
  );
}

export default function ReadinessMetricsGrid({ metrics, loading, t }: ReadinessMetricsGridProps) {
  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {METRICS.map((m) => <MetricSkeleton key={m.key} />)}
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {METRICS.map((m) => (
        <div
          key={m.key}
          className="rounded-2xl border shadow-sm bg-card text-card-foreground p-4"
        >
          <p className="text-xs font-medium text-muted-foreground mb-1">{t(m.labelKey)}</p>
          <p className="text-2xl font-bold">{metrics[m.key]}</p>
        </div>
      ))}
    </div>
  );
}
