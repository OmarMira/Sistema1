'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DatabaseBackup,
  Download,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  HardDrive,
  Clock,
  FileJson,
  ShieldCheck,
  ArrowDownToLine,
  Calendar,
  HardDriveDownload,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
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

/* ─── Types ───────────────────────────────────────────────────────── */

interface BackupRecord {
  id: string;
  filename: string;
  size: number;
  createdAt: string;
  companyInfo: {
    id: string;
    legalName: string;
  };
  recordCounts: {
    company: number;
    glAccounts: number;
    bankAccounts: number;
    bankStatements: number;
    bankTransactions: number;
    bankRules: number;
    journalEntries: number;
    journalLines: number;
    fiscalPeriods: number;
    companyMembers: number;
    users: number;
  };
}

/* ─── Animation Variants ──────────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching data on mount
    void fetchBackups();
    return () => { mountedRef.current = false; };
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
          description: `${formatFileSize(data.size)} — ${Object.values(data.recordCounts).reduce((a: number, b: number) => a + b, 0)} ${t('settings.backup.records')}`,
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
        `/api/backup/${encodeURIComponent(backup.filename)}?companyId=${companyId}`
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
        const totalRecords = Object.values(data.restoredCounts).reduce(
          (a: number, b: number) => a + b,
          0
        );
        toast.success(t('settings.backup.restoreSuccess'), {
          description: `${totalRecords} ${t('settings.backup.records')}`,
        });
        setRestoreFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
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

  // Drag & Drop handlers
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.add('border-primary', 'bg-primary/5');
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.remove('border-primary', 'bg-primary/5');
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.remove('border-primary', 'bg-primary/5');
    }
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) {
      setRestoreFile(file);
    } else {
      toast.error(t('settings.backup.errorInvalidFile'));
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setRestoreFile(file);
    }
  }

  // Restore progress overlay
  const showRestoreOverlay = restoring;

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
                <p className="text-lg font-semibold">
                  {t('settings.backup.restoring')}
                </p>
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
        <h1 className="text-2xl font-bold tracking-tight">
          {t('settings.systemBackup')}
        </h1>
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
              <CardDescription>
                {t('settings.backup.createBackupDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleCreateBackup}
                disabled={creating}
                className="w-full sm:w-auto"
              >
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
              <CardDescription>
                {t('settings.backup.restoreBackupDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Warning */}
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {t('settings.backup.restoreWarning')}
                </p>
              </div>

              {/* Drop zone */}
              <div
                ref={dropRef}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors
                  ${restoreFile
                    ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20'
                    : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
                  }
                `}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                {restoreFile ? (
                  <>
                    <div className="flex size-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
                      <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium">{restoreFile.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(restoreFile.size)}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                      <Upload className="size-5 text-muted-foreground" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium">
                        {t('settings.backup.selectFile')}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('settings.backup.dragDrop')}
                      </p>
                    </div>
                  </>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {t('settings.backup.supportedFormats')}
              </p>

              {restoreFile && (
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setRestoreFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    variant="outline"
                    size="sm"
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    onClick={() => setShowRestoreConfirm(true)}
                    variant="destructive"
                    size="sm"
                  >
                    <ArrowDownToLine className="size-4 mr-1" />
                    {t('settings.backup.restoreBackup')}
                  </Button>
                </div>
              )}
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
                  <p className="text-sm text-muted-foreground">
                    {t('settings.backup.noBackups')}
                  </p>
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1 custom-scrollbar">
                  {backups.map((backup) => (
                    <BackupItem
                      key={backup.id}
                      backup={backup}
                      downloading={downloading === backup.id}
                      onDownload={() => handleDownload(backup)}
                      onDelete={() => setShowDeleteConfirm(backup.filename)}
                      t={t}
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
              <p className="text-xs text-muted-foreground">
                {formatFileSize(restoreFile.size)}
              </p>
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

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!showDeleteConfirm}
        onOpenChange={(open) => !open && setShowDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.backup.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {showDeleteConfirm}
            </AlertDialogDescription>
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

/* ─── Backup Item Component ───────────────────────────────────────── */

function BackupItem({
  backup,
  downloading,
  onDownload,
  onDelete,
  t,
}: {
  backup: BackupRecord;
  downloading: boolean;
  onDownload: () => void;
  onDelete: () => void;
  t: (key: string) => string;
}) {
  const totalRecords = Object.values(backup.recordCounts).reduce(
    (a: number, b: number) => a + b,
    0
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
          <span>{totalRecords} {t('settings.backup.records')}</span>
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
