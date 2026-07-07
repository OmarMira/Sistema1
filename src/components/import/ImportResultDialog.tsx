'use client';

import React from 'react';
import {
  CheckCircle2,
  Landmark,
  AlertCircle,
  Sparkles,
  ArrowLeftRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguageStore } from '@/store/language-store';
import type { ImportResult } from '@/lib/types/import-page';

interface ImportResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: ImportResult | null;
  onClassifyEntities: () => void;
  onGoToReconciliation: () => void;
}

export function ImportResultDialog({
  open,
  onOpenChange,
  result,
  onClassifyEntities,
  onGoToReconciliation,
}: ImportResultDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 leading-normal">
            <div className="flex size-8 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
              <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            {t('banks.importSuccess')}
          </DialogTitle>
          <DialogDescription>{t('banks.importSuccessMessage')}</DialogDescription>
        </DialogHeader>

        {result && (
          <div className="space-y-4 py-2">
            {/* Summary cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-2xl font-bold font-mono text-teal-600 dark:text-teal-400">
                  {result.transactionCount}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('banks.transactionsImported')}
                </p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {result.transactionCount > 0
                    ? Math.round(
                        (result.autoCategorizedCount / result.transactionCount) * 100,
                      )
                    : 0}
                  %
                </p>
                <p className="text-xs text-muted-foreground mt-1">{t('banks.autoCategorized')}</p>
              </div>
            </div>

            {/* Details */}
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('banks.autoCategorized')}</span>
                <span className="font-medium shrink-0">
                  {result.autoCategorizedCount} / {result.transactionCount}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm gap-2">
                <span className="text-muted-foreground shrink-0">{t('banks.title')}</span>
                <span className="font-medium truncate text-right max-w-[280px]">
                  {result.bankAccountName}
                </span>
              </div>
              {result.newAccountCreated && (
                <div className="flex items-center gap-2 rounded-md bg-teal-50 dark:bg-teal-950/30 p-2 text-sm">
                  <Landmark className="size-4 text-teal-600 dark:text-teal-400" />
                  <span className="text-teal-700 dark:text-teal-300">
                    {t('banks.newAccountCreated')}
                  </span>
                </div>
              )}
              {result.duplicatesSkipped > 0 && (
                <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 p-2 text-sm">
                  <AlertCircle className="size-4 text-amber-600 dark:text-amber-400" />
                  <span className="text-amber-700 dark:text-amber-300">
                    {result.duplicatesSkipped} {t('reconciliation.duplicatesSkipped')}
                  </span>
                </div>
              )}
              {result.skippedNote && (
                <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 p-2 text-sm">
                  <AlertCircle className="size-4 text-blue-600 dark:text-blue-400" />
                  <span className="text-blue-700 dark:text-blue-300">
                    {result.skippedNote}
                  </span>
                </div>
              )}
            </div>

            {/* Categorization bar */}
            {result.transactionCount > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {t('banks.categorizationProgress')}
                </p>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{
                      width: `${
                        result.transactionCount > 0
                          ? (result.autoCategorizedCount / result.transactionCount) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                {result.autoCategorizedCount < result.transactionCount && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {result.transactionCount - result.autoCategorizedCount}{' '}
                    {t('banks.transactions').toLowerCase()} {t('banks.uncategorizedNote')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="w-full sm:flex-1"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={onClassifyEntities}
            className="w-full sm:flex-1"
          >
            <Sparkles className="size-4 mr-1 shrink-0" />
            <span className="truncate">{t('learning.classifyEntities')}</span>
          </Button>
          <Button
            onClick={onGoToReconciliation}
            className="w-full sm:w-auto"
          >
            <ArrowLeftRight className="size-4 mr-1" />
            {t('banks.goToReconciliation')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
