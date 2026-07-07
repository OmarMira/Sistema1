'use client';

import { TrendingUp, TrendingDown, ArrowUpDown, Receipt } from 'lucide-react';
import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/format';
import { useLanguageStore } from '@/store/language-store';
import { itemVariants, type MovementSummaryResponse } from '@/lib/types/movement-summary';

interface MovementSummaryCardsProps {
  data: MovementSummaryResponse | null;
  loading: boolean;
}

export function MovementSummaryCards({ data, loading }: MovementSummaryCardsProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <motion.div
      variants={itemVariants}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {/* Total Debits */}
      <Card className="border-emerald-200 dark:border-emerald-800">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
              <TrendingUp className="size-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-xs text-muted-foreground">{t('movementSummary.totalDebits')}</p>
          </div>
          {loading ? (
            <Skeleton className="h-8 w-32 mt-1" />
          ) : (
            <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {formatCurrency(data?.summary.totalDebits ?? 0)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Total Credits */}
      <Card className="border-amber-200 dark:border-amber-800">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex size-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
              <TrendingDown className="size-4 text-amber-600 dark:text-amber-400" />
            </div>
            <p className="text-xs text-muted-foreground">{t('movementSummary.totalCredits')}</p>
          </div>
          {loading ? (
            <Skeleton className="h-8 w-32 mt-1" />
          ) : (
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {formatCurrency(data?.summary.totalCredits ?? 0)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Net Movement */}
      <Card className="border-teal-200 dark:border-teal-800">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex size-8 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/30">
              <ArrowUpDown className="size-4 text-teal-600 dark:text-teal-400" />
            </div>
            <p className="text-xs text-muted-foreground">{t('movementSummary.netMovement')}</p>
          </div>
          {loading ? (
            <Skeleton className="h-8 w-32 mt-1" />
          ) : (
            <p
              className={`text-2xl font-bold ${
                (data?.summary.netMovement ?? 0) >= 0
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
            >
              {formatCurrency(data?.summary.netMovement ?? 0)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Total Transactions */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex size-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
              <Receipt className="size-4 text-gray-600 dark:text-gray-400" />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('movementSummary.totalTransactions')}
            </p>
          </div>
          {loading ? (
            <Skeleton className="h-8 w-32 mt-1" />
          ) : (
            <p className="text-2xl font-bold">{data?.summary.transactionCount ?? 0}</p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
