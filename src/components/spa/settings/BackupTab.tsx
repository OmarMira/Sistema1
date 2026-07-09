'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database,
  Download,
  Upload,
  HardDrive,
  AlertTriangle,
  Loader2,
  Clock,
  RotateCcw,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  containerVariants,
  itemVariants,
  formatFileSize,
  formatDate,
  type BackupRecord,
} from '@/lib/types/backup';

/* ─── BackupTab ───────────────────────────────────────────────── */

export function BackupTab() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringFromList, setRestoringFromList] = useState<string | null>(null);
  const [showRestoreHistoryConfirm, setShowRestoreHistoryConfirm] = useState<BackupRecord | null>(null);
  const mountedRef = useRef(true);

  const fetchBackups = useCallback(async () => {
    if (!companyId || !mountedRef.current) return;
    try {
      const res = await fetch(`/api/backup?companyId=${companyId}`);
      if (res.ok && mountedRef.current) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch {
      // ignore
    }
    if (mountedRef.current) setLoading(false);
  }, [companyId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchBackups();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchBackups]);

  async function handleCreateBackup() {
    if (!companyId) return;
    setCreating(true);
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('settings.backup.backupCreated'), {
          description: `${formatFileSize(data.size)} — ${(Object.values(data.recordCounts) as number[]).reduce((a, b) => a + b, 0)} ${t('settings.backup.records')}`,
        });
        if (data.data) {
          const jsonStr = atob(data.data);
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = data.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        await fetchBackups();
      } else {
        const data = await res.json();
        toast.error(t('settings.backup.backupFailed'), { description: data.error });
      }
    } catch {
      toast.error(t('settings.backup.backupFailed'));
    }
    setCreating(false);
  }

  async function handleDownload(backup: BackupRecord) {
    if (!companyId) return;
    try {
      const res = await fetch(
        `/api/backup/${encodeURIComponent(backup.filename)}?companyId=${companyId}`,
      );
      if (res.ok) {
        const data = await res.json();
        if (data.data) {
          const jsonStr = atob(data.data);
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = backup.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      toast.error(t('common.error'));
    }
  }

  async function handleRestoreFromHistory(backup: BackupRecord) {
    if (!companyId) return;
    setRestoringFromList(backup.id);
    setShowRestoreHistoryConfirm(null);

    try {
      const res = await fetch(
        `/api/backup/${encodeURIComponent(backup.filename)}?companyId=${companyId}`,
      );
      if (!res.ok) throw new Error('Failed to fetch backup');
      const data = await res.json();
      if (!data.data) throw new Error('No backup data');

      const restoreRes = await fetch(`/api/backup/restore?companyId=${companyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: data.data }),
      });

      const result = await restoreRes.json();

      if (restoreRes.ok) {
        const totalRecords = (Object.values(result.restoredCounts) as number[]).reduce(
          (a, b) => a + b,
          0,
        );
        toast.success(t('settings.backup.restoreSuccess'), {
          description: `${totalRecords} ${t('settings.backup.records')}`,
        });
        await fetchBackups();
      } else {
        toast.error(t('settings.backup.restoreFailed'), {
          description: result.error,
        });
      }
    } catch {
      toast.error(t('settings.backup.restoreFailed'));
    }
    setRestoringFromList(null);
  }

  function handleRestore() {
    if (!companyId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.backup';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setRestoring(true);
      try {
        const formData = new FormData();
        formData.append('companyId', companyId);
        formData.append('file', file);
        const res = await fetch('/api/backup/restore', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (res.ok) {
          const totalRecords = (Object.values(data.restoredCounts) as number[]).reduce(
            (a, b) => a + b,
            0,
          );
          toast.success(t('settings.backup.restoreSuccess'), {
            description: `${totalRecords} ${t('settings.backup.records')}`,
          });
          await fetchBackups();
        } else {
          toast.error(t('settings.backup.restoreFailed'), { description: data.error });
        }
      } catch {
        toast.error(t('settings.backup.restoreFailed'));
      }
      setRestoring(false);
    };
    input.click();
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Persistent DB Badge */}
      <motion.div variants={itemVariants}>
        <div className="flex items-center gap-2">
          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 border-0">
            <HardDrive className="size-3 mr-1" />
            {t('settings.backup.databasePersistent')}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t('settings.backup.persistentDesc')}
          </span>
        </div>
      </motion.div>

      {/* Create Backup */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="size-4" />
              {t('settings.backup.createBackup')}
            </CardTitle>
            <CardDescription>{t('settings.backup.createBackupDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleCreateBackup} disabled={creating || !companyId}>
              {creating ? (
                <>
                  <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.backup.creating')}
                </>
              ) : (
                <>
                  <Database className="size-4 mr-1" /> {t('settings.backup.createBackup')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Restore Backup */}
      <motion.div variants={itemVariants}>
        <Card className="border-amber-200 dark:border-amber-900/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="size-4" />
              {t('settings.backup.restoreBackup')}
            </CardTitle>
            <CardDescription>{t('settings.backup.restoreBackupDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 flex items-start gap-2">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t('settings.backup.restoreWarning')}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={handleRestore}
              disabled={restoring || !companyId}
            >
              {restoring ? (
                <>
                  <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.backup.restoring')}
                </>
              ) : (
                <>
                  <Upload className="size-4 mr-1" /> {t('settings.backup.selectFile')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Backup History */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="size-4" />
              {t('settings.backup.backupHistory')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : backups.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {t('settings.backup.noBackups')}
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {backups.map((backup) => (
                  <div
                    key={backup.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {backup.companyInfo.legalName}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatDate(backup.createdAt)}</span>
                        <span>·</span>
                        <span>{formatFileSize(backup.size)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        onClick={() => handleDownload(backup)}
                      >
                        <Download className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground hover:text-amber-600"
                        onClick={() => setShowRestoreHistoryConfirm(backup)}
                        disabled={restoringFromList === backup.id}
                      >
                        {restoringFromList === backup.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RotateCcw className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
      {/* Restore from history confirmation */}
      <AlertDialog
        open={!!showRestoreHistoryConfirm}
        onOpenChange={(open) => !open && setShowRestoreHistoryConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />
              {t('settings.backup.confirmRestore')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.backup.confirmRestoreDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {showRestoreHistoryConfirm && (
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="text-sm font-medium">
                {showRestoreHistoryConfirm.companyInfo.legalName}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(showRestoreHistoryConfirm.createdAt)} &middot;{' '}
                {formatFileSize(showRestoreHistoryConfirm.size)}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                showRestoreHistoryConfirm && handleRestoreFromHistory(showRestoreHistoryConfirm)
              }
              disabled={restoringFromList !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {restoringFromList !== null ? (
                <>
                  <Loader2 className="size-4 mr-1 animate-spin" />
                  {t('settings.backup.restoring')}
                </>
              ) : (
                t('settings.backup.restoreBackup')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
