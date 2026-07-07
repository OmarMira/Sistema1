'use client';

import { Filter } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import { useLanguageStore } from '@/store/language-store';
import {
  accountTypeColor,
  itemVariants,
  type MovementSummaryResponse,
} from '@/lib/types/movement-summary';

interface ByAccountTableProps {
  data: MovementSummaryResponse | null;
  loading: boolean;
}

export function ByAccountTable({ data, loading }: ByAccountTableProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <motion.div variants={itemVariants}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('movementSummary.byAccount')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : data && data.byAccount.length > 0 ? (
            <div className="rounded-md border overflow-auto max-h-96">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">{t('accounts.accountCode')}</TableHead>
                    <TableHead>{t('accounts.accountName')}</TableHead>
                    <TableHead className="w-[110px]">{t('accounts.accountType')}</TableHead>
                    <TableHead className="text-right w-[120px]">
                      {t('movementSummary.debit')}
                    </TableHead>
                    <TableHead className="text-right w-[120px]">
                      {t('movementSummary.credit')}
                    </TableHead>
                    <TableHead className="text-right w-[120px]">
                      {t('movementSummary.netMovement')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byAccount.map((acc) => (
                    <TableRow key={acc.accountId}>
                      <TableCell className="font-mono text-teal-600 dark:text-teal-400">
                        {acc.accountCode}
                      </TableCell>
                      <TableCell className="font-medium">{acc.accountName}</TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={accountTypeColor(acc.accountType)}
                        >
                          {t(`accounts.${acc.accountType}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {acc.debits > 0 ? formatCurrency(acc.debits) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {acc.credits > 0 ? formatCurrency(acc.credits) : '—'}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono font-semibold ${
                          acc.net >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {formatCurrency(acc.net)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-teal-50/50 dark:bg-teal-950/20">
                    <TableCell colSpan={3} className="font-bold">
                      {t('common.total')}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      {formatCurrency(data?.summary.totalDebits ?? 0)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      {formatCurrency(data?.summary.totalCredits ?? 0)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      {formatCurrency(data?.summary.netMovement ?? 0)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
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
    </motion.div>
  );
}
