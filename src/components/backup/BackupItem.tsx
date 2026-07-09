'use client';

import { ShieldCheck, Calendar, HardDrive, Download, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLanguageStore } from '@/store/language-store';
import { type BackupRecord, formatDate, formatFileSize } from '@/lib/types/backup';

interface BackupItemProps {
  backup: BackupRecord;
  downloading: boolean;
  restoring: boolean;
  onDownload: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

export function BackupItem({ backup, downloading, restoring, onDownload, onRestore, onDelete }: BackupItemProps) {
  const t = useLanguageStore((s) => s.t);
  const totalRecords = (Object.values(backup.recordCounts) as number[]).reduce(
    (a, b) => a + b,
    0,
  );

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/30">
      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 shrink-0 mt-0.5">
        <ShieldCheck className="size-4 text-primary" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{backup.companyInfo.legalName}</p>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {t('settings.backup.manual')}
          </Badge>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="size-3" />
            {formatDate(backup.createdAt)}
          </span>
          <span className="flex items-center gap-1">
            <HardDrive className="size-3" />
            {formatFileSize(backup.size)}
          </span>
          <span>
            {totalRecords} {t('settings.backup.records')}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {backup.recordCounts.glAccounts > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {backup.recordCounts.glAccounts} accounts
            </Badge>
          )}
          {backup.recordCounts.journalEntries > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {backup.recordCounts.journalEntries} entries
            </Badge>
          )}
          {backup.recordCounts.bankTransactions > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {backup.recordCounts.bankTransactions} transactions
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onDownload}
          disabled={downloading}
        >
          {downloading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          <span className="sr-only">{t('settings.backup.download')}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-amber-600"
          onClick={onRestore}
          disabled={restoring}
        >
          {restoring ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          <span className="sr-only">{t('settings.backup.restoreBackup')}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
          <span className="sr-only">{t('common.delete')}</span>
        </Button>
      </div>
    </div>
  );
}
