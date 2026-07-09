'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DatabaseBackup,
  Loader2,
  AlertTriangle,
  Trash2,
  HardDrive,
  Clock,
  FileJson,
  ArrowDownToLine,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
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
import { containerVariants, itemVariants, formatFileSize, formatDate, type BackupRecord } from '@/lib/types/backup';
import { BackupItem } from '@/components/backup/BackupItem';
import { RestoreDropZone } from '@/components/backup/RestoreDropZone';

/* ─── Backup Page ─────────────────────────────────────────────────── */

export function BackupPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  // State
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [restoringFromList, setRestoringFromList] = useState<string | null>(null);
  const [showRestoreHistoryConfirm, setShowRestoreHistoryConfirm] = useState<BackupRecord | null>(null);
  const mountedRef = useRef(true);

  // Fetch backups
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

  // Create backup
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

        // Auto-download the backup
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
        toast.error(t('settings.backup.backupFailed'), {
          description: data.error,
        });
      }
    } catch {
      toast.error(t('settings.backup.backupFailed'));
    }
    setCreating(false);
  }

  // Download existing backup
  async function handleDownload(backup: BackupRecord) {
    if (!companyId) return;
    setDownloading(backup.id);
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
    setDownloading(null);
  }

  // Delete backup
  async function handleDelete(filename: string) {
    if (!companyId) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/backup', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, filename }),
      });
      if (res.ok) {
        toast.success(t('settings.backup.deleteSuccess'));
        await fetchBackups();
      } else {
        toast.error(t('settings.backup.deleteFailed'));
      }
    } catch {
      toast.error(t('settings.backup.deleteFailed'));
    }
    setDeleting(false);
    setShowDeleteConfirm(null);
  }

  // Restore from file
  async function handleRestore() {
    if (!companyId || !restoreFile) return;
    setRestoring(true);
    setRestoreProgress(10);
    setShowRestoreConfirm(false);

    try {
      setRestoreProgress(30);
      const formData = new FormData();
      formData.append('companyId', companyId);
      formData.append('file', restoreFile);

      setRestoreProgress(50);
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        body: formData,
      });

      setRestoreProgress(80);
      const data = await res.json();

      if (res.ok) {
        setRestoreProgress(100);
        const totalRecords = (Object.values(data.restoredCounts) as number[]).reduce(
          (a, b) => a + b,
          0,
        );
        toast.success(t('settings.backup.restoreSuccess'), {
          description: `${totalRecords} ${t('settings.backup.records')}`,
        });
        setRestoreFile(null);
        await fetchBackups();
      } else {
        toast.error(t('settings.backup.restoreFailed'), {
          description: data.error,
        });
      }
    } catch {
      toast.error(t('settings.backup.restoreFailed'));
    }
    setRestoring(false);
    setRestoreProgress(0);
  }

  // Restore from history
  async function handleRestoreFromHistory(backup: BackupRecord) {
    if (!companyId) return;
    setRestoringFromList(backup.id);
    setShowRestoreHistoryConfirm(null);
    setRestoreProgress(10);

    try {
      setRestoreProgress(30);
      const res = await fetch(
        `/api/backup/${encodeURIComponent(backup.filename)}?companyId=${companyId}`,
      );
      if (!res.ok) throw new Error('Failed to fetch backup');

      setRestoreProgress(50);
      const data = await res.json();
      if (!data.data) throw new Error('No backup data');

      setRestoreProgress(70);
      const restoreRes = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: data.data }),
      });

      setRestoreProgress(90);
      const result = await restoreRes.json();

      if (restoreRes.ok) {
        setRestoreProgress(100);
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
    setRestoreProgress(0);
  }

  // Restore progress overlay
  const showRestoreOverlay = restoring || restoringFromList !== null;

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Restore overlay */}
      {showRestoreOverlay && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        >
          <Card className="w-full max-w-md mx-4">
            <CardContent className="p-6 flex flex-col items-center gap-4">
              <Loader2 className="size-12 animate-spin text-primary" />
              <div className="text-center">
                <p className="text-lg font-semibold">{t('settings.backup.restoring')}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('settings.backup.restoreWarning')}
                </p>
              </div>
              <Progress value={restoreProgress} className="w-full" />
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Header */}
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.systemBackup')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('settings.backup.createBackupDesc')}
        </p>
      </motion.div>

      {/* Info Banner */}
      <motion.div variants={itemVariants}>
        <Card className="border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20">
          <CardContent className="flex items-center gap-3 p-4">
            <HardDrive className="size-5 text-teal-600 dark:text-teal-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-teal-800 dark:text-teal-300">
                {t('settings.backup.databasePersistent')}
              </p>
              <p className="text-xs text-teal-700/70 dark:text-teal-400/70">
                {t('settings.backup.persistentDesc')}
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Create & Download */}
        <motion.div variants={itemVariants} className="space-y-6">
          {/* Create Backup */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <DatabaseBackup className="size-4" />
                {t('settings.backup.createBackup')}
              </CardTitle>
              <CardDescription>{t('settings.backup.createBackupDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleCreateBackup} disabled={creating} className="w-full sm:w-auto">
                {creating ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    {t('settings.backup.creating')}
                  </>
                ) : (
                  <>
                    <DatabaseBackup className="size-4 mr-2" />
                    {t('settings.backup.createBackup')}
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Restore Backup */}
          <Card className="border-amber-200 dark:border-amber-900">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowDownToLine className="size-4 text-amber-600 dark:text-amber-400" />
                {t('settings.backup.restoreBackup')}
              </CardTitle>
              <CardDescription>{t('settings.backup.restoreBackupDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Warning */}
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {t('settings.backup.restoreWarning')}
                </p>
              </div>

              <RestoreDropZone
                restoreFile={restoreFile}
                onFileSelect={setRestoreFile}
                onRestoreClick={() => setShowRestoreConfirm(true)}
              />
            </CardContent>
          </Card>
        </motion.div>

        {/* Right: Backup History */}
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
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : backups.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                  <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                    <FileJson className="size-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">{t('settings.backup.noBackups')}</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1 custom-scrollbar">
                  {backups.map((backup) => (
                    <BackupItem
                      key={backup.id}
                      backup={backup}
                      downloading={downloading === backup.id}
                      restoring={restoringFromList === backup.id}
                      onDownload={() => handleDownload(backup)}
                      onRestore={() => setShowRestoreHistoryConfirm(backup)}
                      onDelete={() => setShowDeleteConfirm(backup.filename)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Restore confirmation dialog */}
      <AlertDialog open={showRestoreConfirm} onOpenChange={setShowRestoreConfirm}>
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
          {restoreFile && (
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="text-sm font-medium">{restoreFile.name}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(restoreFile.size)}</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestore}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('settings.backup.restoreBackup')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore from history confirmation dialog */}
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

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!showDeleteConfirm}
        onOpenChange={(open) => !open && setShowDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.backup.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>{showDeleteConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => showDeleteConfirm && handleDelete(showDeleteConfirm)}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="size-4 mr-1" />
              )}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}


