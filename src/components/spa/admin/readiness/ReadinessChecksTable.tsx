'use client';

import { CheckCircle, XCircle } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ReadinessCheckResult } from '@/lib/services/canonical-readiness-service';
import { cn } from '@/lib/utils';

interface ReadinessChecksTableProps {
  checks: ReadinessCheckResult[];
  failedChecks?: ReadinessCheckResult[];
  t: (key: string) => string;
}

function formatActual(value: number | null): string {
  return value !== null ? String(value) : '—';
}

export default function ReadinessChecksTable({ checks, failedChecks, t }: ReadinessChecksTableProps) {
  const failedCodes = new Set(failedChecks?.map((c) => c.code) ?? []);

  return (
    <div className="rounded-2xl border shadow-sm bg-card text-card-foreground overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin.readiness.check')}</TableHead>
            <TableHead>{t('admin.readiness.status')}</TableHead>
            <TableHead>{t('admin.readiness.operator')}</TableHead>
            <TableHead>{t('admin.readiness.actual')}</TableHead>
            <TableHead>{t('admin.readiness.expected')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {checks.map((check) => {
            const isFailed = failedCodes.has(check.code);
            return (
              <TableRow
                key={check.code}
                className={cn(
                  isFailed && 'bg-red-50 dark:bg-red-950/20',
                )}
              >
                <TableCell className="font-mono text-xs">{check.code}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {check.passed ? (
                      <>
                        <CheckCircle className="size-4 text-green-600 dark:text-green-400" />
                        <span className="text-green-700 dark:text-green-300">{t('admin.readiness.passed')}</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="size-4 text-red-600 dark:text-red-400" />
                        <span className="text-red-700 dark:text-red-300">{t('admin.readiness.failed')}</span>
                      </>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{check.operator}</TableCell>
                <TableCell className="font-mono text-xs">{formatActual(check.actual)}</TableCell>
                <TableCell className="font-mono text-xs">{check.expected}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
