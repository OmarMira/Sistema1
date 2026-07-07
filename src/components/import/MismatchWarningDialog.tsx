'use client';

import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLanguageStore } from '@/store/language-store';

interface MismatchWarningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mismatches: { fileName: string; extractedHolder: string; score: number }[];
  isStrict: boolean;
  companyName: string;
  onReject: () => void;
  onAccept: () => void;
}

export function MismatchWarningDialog({
  open,
  onOpenChange,
  mismatches,
  isStrict,
  companyName,
  onReject,
  onAccept,
}: MismatchWarningDialogProps) {
  const t = useLanguageStore((s) => s.t);

  const uniqueHolders = mismatches
    .map((f) => f.extractedHolder)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle
            className={cn(
              'flex items-center gap-2',
              isStrict ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400',
            )}
          >
            <AlertCircle className="size-5 shrink-0" />
            <span>
              {isStrict
                ? t('importPage.strictValidationTitle')
                : t('importPage.holderMismatchTitle')}
            </span>
          </DialogTitle>
          <DialogDescription>
            {isStrict
              ? t('importPage.strictBlockedDesc')
              : t('importPage.holderMismatchDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border overflow-hidden max-h-[160px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('importPage.tableFile')}</TableHead>
                  <TableHead>{t('importPage.tablePdfHolder')}</TableHead>
                  <TableHead className="text-right">{t('importPage.tableSimilarity')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mismatches.map((f, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-medium text-xs truncate max-w-[150px]">
                      {f.fileName}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-xs font-semibold',
                        isStrict
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-amber-700 dark:text-amber-400',
                      )}
                    >
                      {f.extractedHolder}
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">{f.score}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {isStrict ? (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3 text-xs text-red-800 dark:text-red-300 leading-relaxed space-y-2">
              <p className="font-semibold">🚫 {t('importPage.strictErrorTitle')}</p>
              <p>
                {t('importPage.strictErrorDesc')
                  .replace('{company}', companyName)
                  .replace('{holders}', uniqueHolders)}
              </p>
              <p className="font-medium">
                {t('importPage.strictErrorAction')}
              </p>
            </div>
          ) : (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 p-3 text-xs text-amber-800 dark:text-amber-300 leading-relaxed space-y-2">
              <p className="font-semibold">⚠️ {t('importPage.integrityWarningTitle')}</p>
              <p>
                {t('importPage.integrityWarningDesc')
                  .replace('{company}', companyName)
                  .replace('{holders}', uniqueHolders)}
              </p>
              <p className="font-medium">
                {t('importPage.integrityWarningAction')}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          {isStrict ? (
            <Button className="w-full" variant="outline" onClick={onReject}>
              {t('importPage.close')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onReject}>
                {t('importPage.rejectAndCancel')}
              </Button>
              <Button
                onClick={onAccept}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {t('importPage.acceptAndImport')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
