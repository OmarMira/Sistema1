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
import { downloadBackup } from '@/lib/backup-download';
import { previewCompanyRestore } from '@/lib/backup-restore';
import { translateApiError } from '@/i18n/errors';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BackupItem } from '@/components/backup/BackupItem';
import { RestoreDropZone } from '@/components/backup/RestoreDropZone';

/* ─── Backup Page ─────────────────────────────────────────────────── */

export function BackupPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const user = useAuthStore((s) => s.user);
  const companyId = activeCompany?.id;
  // S4 (T5): restoring an archive as a NEW company is a platform operation, so
  // the optional destination selector exists only for a global super_admin.
  const isSuperAdmin = user?.role === 'super_admin';

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
  const [restorePreview, setRestorePreview] = useState<{ checksum: string; counts: BackupRecord; ids: object; blockers: string[] } | null>(null);
  // S7/S1: creating a backup and restoring one both require the administrator's
  // own password (sudo style). Kept in component state only: never persisted,
  // never logged, and cleared as soon as the operation finishes.
  const [createPassword, setCreatePassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  // S4 (T5) — optional destination of a super_admin restore. Empty means "the
  // caller's own company", which is the unchanged default contract.
  const [restoreTargets, setRestoreTargets] = useState<{ id: string; legalName: string }[]>([]);
  const [restoreTargetCompanyId, setRestoreTargetCompanyId] = useState('');
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

  // S4: the destination list comes from the same admin endpoint the admin
  // screens use. A non-super_admin never asks for it and never sees the option.
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/companies');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setRestoreTargets(
            (data.companies ?? []).map((row: { id: string; legalName: string }) => ({
              id: row.id,
              legalName: row.legalName,
            })),
          );
        }
      } catch {
        /* the selector simply stays on the current company */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  /** Sent only when a super_admin picked a company other than the current one. */
  const selectedTargetCompanyId =
    isSuperAdmin && restoreTargetCompanyId && restoreTargetCompanyId !== companyId
      ? restoreTargetCompanyId
      : undefined;

  // Create backup
  async function handleCreateBackup() {
    if (!companyId) return;
    if (createPassword.length === 0) {
      toast.error('Ingresá tu contraseña para crear el respaldo.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, password: createPassword }),
      });

      if (res.ok) {
        const data = await res.json();
        setCreatePassword('');
        toast.success(t('settings.backup.backupCreated'), {
          description: `${formatFileSize(data.size)} — ${(Object.values(data.recordCounts) as number[]).reduce((a, b) => a + b, 0)} ${t('settings.backup.records')}`,
        });

        // Auto-download the backup
        if (data.data) {
          downloadBackup(data.data, data.filename);
        }

        await fetchBackups();
      } else {
        const data = await res.json();
        toast.error(t('settings.backup.backupFailed'), {
          description: translateApiError(data, t),
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
          downloadBackup(data.data, backup.filename);
        }
      } else {
        toast.error(t('common.error'));
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
    if (restorePassword.length === 0) {
      toast.error('Ingresá la contraseña del super administrador que creó este respaldo.');
      return;
    }

    try {
      setRestoring(true);
      setRestoreProgress(10);
      setShowRestoreConfirm(false);

      const fileBuffer = await restoreFile.arrayBuffer();
      const jsonString = new TextDecoder().decode(fileBuffer);
      const parsed = JSON.parse(jsonString);
      const previewData = JSON.stringify({ data: parsed.data ?? parsed });

      // S4: a destination other than the current company is certified by the
      // restore route itself, not by this preview (which is bound to the
      // caller's company). Go straight to the confirmation.
      if (selectedTargetCompanyId) {
        setRestoring(false);
        setRestoreProgress(0);
        setShowRestoreConfirm(true);
        return;
      }

      setRestoreProgress(30);
      const previewRes = await fetch('/api/backup/restore/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: previewData,
      });

      if (!previewRes.ok) {
        const err = await previewRes.json();
        toast.error(t('settings.backup.restoreFailed'), { description: err.error });
        setRestoring(false);
        setRestoreProgress(0);
        return;
      }

      const preview = await previewRes.json();
      setRestorePreview({
        checksum: preview.checksum,
        counts: preview.counts,
        ids: preview.ids,
        blockers: preview.blockers,
      });

      setShowRestoreConfirm(true);
    } catch {
      toast.error(t('settings.backup.restoreFailed'));
    }
  }

  async function executeRestore() {
    if (!companyId || !restoreFile) return;
    if (restorePassword.length === 0) {
      toast.error('Ingresá la contraseña del super administrador que creó este respaldo.');
      return;
    }
    setShowRestoreConfirm(false);
    setRestorePreview(null);

    try {
      setRestoring(true);
      setRestoreProgress(30);

      const fileBuffer = await restoreFile.arrayBuffer();
      const jsonString = new TextDecoder().decode(fileBuffer);
      const parsed = JSON.parse(jsonString);
      const data = parsed.data ?? parsed;

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data,
          ownerPassword: restorePassword,
          ...(selectedTargetCompanyId ? { targetCompanyId: selectedTargetCompanyId } : {}),
        }),
      });

      setRestoreProgress(80);
      const result = await res.json();

      if (res.ok) {
        setRestoreProgress(100);
        setRestorePassword('');
        setRestoreTargetCompanyId('');
        const totalRecords = (Object.values(result.counts ?? {} ) as number[]).reduce(
          (a, b) => a + b,
          0,
        );
        toast.success(t('settings.backup.restoreSuccess'), {
          description: `${totalRecords} ${t('settings.backup.records')}`,
        });
        setRestoreFile(null);
        await fetchBackups();
        window.location.href = '/';
      } else {
        toast.error(t('settings.backup.restoreFailed'), {
          description: translateApiError(result, t),
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
    if (restorePassword.length === 0) {
      toast.error('Ingresá la contraseña del super administrador que creó este respaldo.');
      return;
    }

    try {
      setRestoringFromList(backup.id);
      setRestoreProgress(10);
      setShowRestoreHistoryConfirm(null);

      setRestoreProgress(30);
      const res = await fetch(
        `/api/backup/${encodeURIComponent(backup.filename)}?companyId=${companyId}`,
      );
      if (!res.ok) throw new Error('Failed to fetch backup');

      setRestoreProgress(50);
      const data = await res.json();
      if (!data.data) throw new Error('No backup data');

      setRestoreProgress(60);
      const previewRes = await fetch('/api/backup/restore/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: data.data }),
      });

      if (!previewRes.ok) {
        const err = await previewRes.json();
        toast.error(t('settings.backup.restoreFailed'), { description: err.error });
        setRestoringFromList(null);
        setRestoreProgress(0);
        return;
      }

      const preview = await previewRes.json();
      setRestorePreview({
        checksum: preview.checksum,
        counts: preview.counts,
        ids: preview.ids,
        blockers: preview.blockers,
      });

      setShowRestoreHistoryConfirm(backup);
    } catch {
      toast.error(t('settings.backup.restoreFailed'));
    }
  }

  // Note: history restore preview stored in restorePreview; executeRestore handles both
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
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="backup-create-password">Tu contraseña de administrador</Label>
                <Input
                  id="backup-create-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={createPassword}
                  onChange={(event) => setCreatePassword(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  El respaldo queda protegido con tu contraseña: sin ella nadie puede restaurarlo.
                </p>
              </div>
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

              <div className="space-y-2">
                <Label htmlFor="backup-restore-password">
                  Contraseña del super administrador que creó el respaldo
                </Label>
                <Input
                  id="backup-restore-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={restorePassword}
                  onChange={(event) => setRestorePassword(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  La restauración exige la contraseña del super administrador que creó este respaldo, no la
                  de cualquier otra cuenta.
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
          <div className="space-y-2">
            <Label htmlFor="backup-confirm-password">Contraseña del super administrador que creó el respaldo</Label>
            <Input
              id="backup-confirm-password"
              type="password"
              autoComplete="current-password"
              required
              value={restorePassword}
              onChange={(event) => setRestorePassword(event.target.value)}
            />
          </div>
          {isSuperAdmin && (
            <div className="space-y-2">
              <Label htmlFor="backup-confirm-target-company">
                {t('settings.backup.restoreAsNewCompany')}
              </Label>
              <select
                id="backup-confirm-target-company"
                value={restoreTargetCompanyId}
                onChange={(event) => setRestoreTargetCompanyId(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">{t('settings.backup.restoreTargetCurrent')}</option>
                {restoreTargets
                  .filter((target) => target.id !== companyId)
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.legalName}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t('settings.backup.restoreAsNewCompanyHint')}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeRestore}
              disabled={restoring}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {restoring ? (t('settings.backup.restoring')) : (t('settings.backup.restoreBackup'))}
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
          <div className="space-y-2">
            <Label htmlFor="backup-history-password">Contraseña del super administrador que creó el respaldo</Label>
            <Input
              id="backup-history-password"
              type="password"
              autoComplete="current-password"
              required
              value={restorePassword}
              onChange={(event) => setRestorePassword(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeRestore}
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

      {/* Preview info in dialog */}
      <AlertDialog open={!!restorePreview} onOpenChange={(open) => !open && setRestorePreview(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore Preview</AlertDialogTitle>
          </AlertDialogHeader>
          {restorePreview && (
            <div className="text-xs space-y-1">
              <p>Checksum: {restorePreview.checksum}</p>
              <p>Counts: {JSON.stringify(restorePreview.counts)}</p>
              {restorePreview.blockers.length > 0 && (
                <p className="text-red-600">Blockers: {restorePreview.blockers.join(', ')}</p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRestorePreview(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setRestorePreview(null); setShowRestoreConfirm(true); }}>Confirm</AlertDialogAction>
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


