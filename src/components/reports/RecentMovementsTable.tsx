'use client';

import { Activity, Filter } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatDate } from '@/lib/format';
import { useLanguageStore } from '@/store/language-store';
import { type MovementSummaryResponse } from '@/lib/types/movement-summary';

interface RecentMovementsTableProps {
  data: MovementSummaryResponse | null;
  loading: boolean;
}

export function RecentMovementsTable({ data, loading }: RecentMovementsTableProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="size-4" />
          {t('movementSummary.recentMovements')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : data && data.recentMovements.length > 0 ? (
          <div className="rounded-md border overflow-auto max-h-96">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">{t('common.date')}</TableHead>
                  <TableHead>{t('common.description')}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t('movementSummary.account')}
                  </TableHead>
                  <TableHead className="text-right w-[110px]">
                    {t('movementSummary.debit')}
                  </TableHead>
                  <TableHead className="text-right w-[110px]">
                    {t('movementSummary.credit')}
                  </TableHead>
                  <TableHead className="hidden sm:table-cell w-[100px]">
                    {t('common.reference')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentMovements.map((mv) => (
                  <TableRow key={`${mv.id}-${mv.account}`}>
                    <TableCell className="whitespace-nowrap">{formatDate(mv.date)}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{mv.description}</TableCell>
                    <TableCell className="hidden md:table-cell font-mono text-teal-600 dark:text-teal-400 text-xs">
                      {mv.account}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {mv.debit > 0 ? formatCurrency(mv.debit) : ''}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {mv.credit > 0 ? formatCurrency(mv.credit) : ''}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">
                      {mv.reference || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Filter className="size-12 text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground">{t('movementSummary.noData')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
