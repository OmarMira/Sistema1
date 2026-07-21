'use client';

import { CheckCircle, AlertTriangle, MinusCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ReadinessStatusCardProps {
  status: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  reasons?: string[];
  t: (key: string) => string;
}

const STATUS_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  READY: { icon: CheckCircle, color: 'text-green-600 dark:text-green-400' },
  NOT_READY: { icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400' },
  INSUFFICIENT_DATA: { icon: MinusCircle, color: 'text-gray-500 dark:text-gray-400' },
};

function getStatusLabelKey(status: string): string {
  switch (status) {
    case 'READY': return 'admin.readiness.status.ready';
    case 'NOT_READY': return 'admin.readiness.status.notReady';
    case 'INSUFFICIENT_DATA': return 'admin.readiness.status.insufficientData';
    default: return status;
  }
}

export default function ReadinessStatusCard({ status, reasons, t }: ReadinessStatusCardProps) {
  const config = STATUS_CONFIG[status];
  if (!config) return null;

  const Icon = config.icon;

  return (
    <div className="rounded-2xl border shadow-sm bg-card text-card-foreground p-6">
      <div className="flex items-center gap-3">
        <Icon className={cn('size-8', config.color)} />
        <div>
          <p className="text-lg font-bold">{t(getStatusLabelKey(status))}</p>
          {reasons && reasons.length > 0 && (
            <ul className="mt-2 space-y-1">
              {reasons.map((reason, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  — {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
