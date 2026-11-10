'use client';

import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react';
import {
  Database,
  Download,
  Upload,
  HardDrive,
  AlertTriangle,
  Loader2,
  Clock,
  RotateCcw,
  Mail,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { toast } from 'sonner';
import { downloadBackup } from '@/lib/backup-download';
import { translateApiError } from '@/i18n/errors';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

/**
 * Outer-envelope format string of the portable owner-verified container.
 *
 * Duplicated from `PORTABLE_FORMAT` on purpose: that module imports
 * `node:crypto` and cannot be bundled into a client component. The isolated
 * suite pins this literal against the server constant, so the two can never
 * drift silently. Detection reads the OUTER envelope only: nothing is decrypted
 * in the browser and the server re-validates the whole container.
 */
export const PORTABLE_RECOVERY_FORMAT = 'accountexpress-portable-recovery';

export function isPortableRecoveryFile(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { format?: unknown } | null;
    return !!parsed && typeof parsed === 'object' && parsed.format === PORTABLE_RECOVERY_FORMAT;
  } catch {
    return false;
  }
}

/**
 * Server code -> locale key for the portable door (S23/S24). The codes describe
 * a situation the operator can act on, so each one names it instead of showing a
 * generic failure.
 */
const PORTABLE_DOOR_MESSAGES: Record<string, string> = {
  RECOVERY_SESSION_IDENTITY_MISMATCH: 'settings.backup.portableIdentityMismatch',
  RECOVERY_ACTIVE_COMPANY_MISMATCH: 'settings.backup.portableActiveCompanyMismatch',
  RECOVERY_COMPANY_EXISTS: 'settings.backup.portableCompanyExists',
  RECOVERY_COMPANY_NOT_FOUND: 'settings.backup.portableCompanyNotFound',
  RECOVERY_FILE_UNSUPPORTED: 'settings.backup.portableDetected',
  RECOVERY_FORMAT_UNSUPPORTED: 'settings.backup.portableDetected',
};

export function portableDoorMessage(data: unknown, t: (key: string) => string): string {
  const code = (data as { code?: unknown } | null)?.code;
  const key = typeof code === 'string' ? PORTABLE_DOOR_MESSAGES[code] : undefined;
  if (key) return t(key);
  return translateApiError(data as { error?: unknown; code?: unknown }, t);
}

export function BackupTab() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const sessionUser = useAuthStore((s) => s.user);
  const companyId = activeCompany?.id;

  const [creating, setCreating] = useState(false);
  // The backup is protected with the SOURCE owner password (S3): without it the
  // file cannot be recovered on a new machine, so it is required here.
  const [ownerPassword, setOwnerPassword] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  // Files of this company that exist on disk but could not be read. They are
  // preserved untouched; the list must show them instead of failing or hiding
  // the loss behind an empty history.
  const [unreadable, setUnreadable] = useState<Array<{ filename: string; error: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [restoringFromList, setRestoringFromList] = useState<string | null>(null);
  const [showRestoreHistoryConfirm, setShowRestoreHistoryConfirm] = useState<BackupRecord | null>(null);
  // Portable owner-verified container (S24).
  const [portable, setPortable] = useState<{ fileName: string; text: string } | null>(null);
  const [portableEmail, setPortableEmail] = useState('');
  const [portableCompany, setPortableCompany] = useState('');
  const [portablePassword, setPortablePassword] = useState('');
  const [portableToken, setPortableToken] = useState('');
  const [portableStage, setPortableStage] = useState<'form' | 'token'>('form');
  const [portableBusy, setPortableBusy] = useState(false);
  const [portableNotice, setPortableNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);

  const fetchBackups = useCallback(async () => {
    if (!companyId || !mountedRef.current) return;
    try {
      const res = await fetch(`/api/backup?companyId=${companyId}`);
      if (res.ok && mountedRef.current) {
        const data = await res.json();
        setBackups(data.backups || []);
        setUnreadable(Array.isArray(data.unreadable) ? data.unreadable : []);
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
        body: JSON.stringify({ companyId, password: ownerPassword }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('settings.backup.backupCreated'), {
          description: `${formatFileSize(data.size)} — ${(Object.values(data.recordCounts) as number[]).reduce((a, b) => a + b, 0)} ${t('settings.backup.records')}`,
        });
        if (data.data) {
          downloadBackup(data.data, data.recoveryFilename || data.filename);
        }
        // The snapshot is stored, but the inventory could not be verified, so the
        // catalog/retention maintenance was skipped. Say it out loud instead of
        // reporting a silent partial success.
        if (data.catalogWarning) {
          toast.warning(t('settings.backup.catalogUnverifiedTitle'), {
            description: t('settings.backup.catalogUnverifiedDesc'),
          });
        }
        await fetchBackups();
      } else {
        const data = await res.json();
        toast.error(t('settings.backup.backupFailed'), { description: translateApiError(data, t) });
      }
    } catch {
      toast.error(t('settings.backup.backupFailed'));
    }
    setCreating(false);
  }

  async function handleDownload(backup: BackupRecord) {
    if (!companyId) return;
    if (ownerPassword.trim().length === 0) {
      toast.error(t('settings.backup.recoveryPasswordRequired'));
      return;
    }
    try {
      const res = await fetch(`/api/backup/${encodeURIComponent(backup.filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, password: ownerPassword }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) {
          downloadBackup(data.data, data.filename || backup.filename);
        }
      } else {
        const data = await res.json().catch(() => null);
        toast.error(t('common.error'), { description: translateApiError(data, t) });
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
      // S11: the snapshot text stays on the server. The browser only names the
      // stored file; the restore route resolves it after tenant validation.
      const restoreRes = await fetch(`/api/backup/restore?companyId=${companyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: backup.filename }),
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
          description: translateApiError(result, t),
        });
      }
    } catch {
      toast.error(t('settings.backup.restoreFailed'));
    }
    setRestoringFromList(null);
  }

  function handleRestore() {
    if (!companyId) return;
    fileInputRef.current?.click();
  }

  /**
   * One file chooser for both formats: the outer envelope says whether this is a
   * portable owner container (S24: password + owner email + company name +
   * emailed code) or an internal snapshot (unchanged path).
   */
  async function handleRestoreFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later.
    event.target.value = '';
    if (!file || !companyId) return;

    const text = await file.text().catch(() => '');
    if (isPortableRecoveryFile(text)) {
      setPortable({ fileName: file.name, text });
      setPortableEmail(sessionUser?.email ?? '');
      // The active company name is the likely answer; the server verifies it
      // against the authenticated payload before anything is sent.
      setPortableCompany(activeCompany?.legalName ?? '');
      setPortablePassword(ownerPassword);
      setPortableToken('');
      setPortableStage('form');
      setPortableNotice(null);
      return;
    }

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
        toast.error(t('settings.backup.restoreFailed'), { description: translateApiError(data, t) });
      }
    } catch {
      toast.error(t('settings.backup.restoreFailed'));
    }
    setRestoring(false);
  }

  /**
   * Portable door (S24): the session already proved who the operator is, so the
   * first stage asks for the file inputs and the owner token, and the second
   * consumes the token and replaces THIS company's data.
   */
  async function submitPortable(stage: 'challenge' | 'complete') {
    if (!portable || !companyId) return;
    setPortableBusy(true);
    setPortableNotice(null);
    try {
      const formData = new FormData();
      formData.append('file', new File([portable.text], portable.fileName, { type: 'application/json' }));
      formData.append('password', portablePassword);
      formData.append('ownerEmail', portableEmail);
      formData.append('companyName', portableCompany);
      if (stage === 'complete') formData.append('token', portableToken);

      const res = await fetch(
        `/api/backup/restore?mode=portable&door=settings&companyId=${encodeURIComponent(companyId)}`,
        { method: 'POST', body: formData },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Single notice: one inline banner for a form-visible failure, never a
        // toast plus banner for the same refusal.
        setPortableNotice(portableDoorMessage(data, t));
        return;
      }
      if (stage === 'challenge') {
        setPortableStage('token');
        return;
      }
      const totalRecords = (Object.values(data?.restoredCounts ?? {}) as number[]).reduce((a, b) => a + b, 0);
      toast.success(t('settings.backup.portableRestoreSuccess'), {
        description: `${totalRecords} ${t('settings.backup.records')}`,
      });
      setPortable(null);
      setPortableStage('form');
      setPortableToken('');
      await fetchBackups();
    } catch {
      setPortableNotice(t('settings.backup.portableRestoreFailed'));
    } finally {
      setPortableBusy(false);
    }
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
          <CardContent className="space-y-3">
            <Input
              type="password"
              value={ownerPassword}
              autoComplete="current-password"
              placeholder={t('settings.backup.recoveryPasswordLabel')}
              onChange={(e) => setOwnerPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.backup.recoveryPasswordHint')}
            </p>
            <Button onClick={handleCreateBackup} disabled={creating || !companyId || ownerPassword.trim().length === 0}>
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
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.backup"
              className="hidden"
              data-testid="restore-file-input"
              onChange={(event) => void handleRestoreFile(event)}
            />

            {/* Portable owner-verified container (S24): replaces THIS company only. */}
            {portable && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t('settings.backup.portableDetected')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.backup.portableDesc')}</p>
                  </div>
                </div>

                {/* Pre-stage-1 notice: which company this door replaces. */}
                <p className="rounded-md bg-background p-2 text-xs text-muted-foreground">
                  {t('settings.backup.portableActiveCompanyNotice')}{' '}
                  <span className="font-medium text-foreground">{activeCompany?.legalName ?? ''}</span>
                </p>

                <Input
                  type="email"
                  autoComplete="email"
                  value={portableEmail}
                  aria-label={t('settings.backup.portableOwnerEmailLabel')}
                  placeholder={t('settings.backup.portableOwnerEmailLabel')}
                  onChange={(e) => setPortableEmail(e.target.value)}
                />
                <Input
                  value={portableCompany}
                  aria-label={t('settings.backup.portableCompanyNameLabel')}
                  placeholder={t('settings.backup.portableCompanyNameLabel')}
                  onChange={(e) => setPortableCompany(e.target.value)}
                />
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={portablePassword}
                  aria-label={t('settings.backup.portableOwnerPasswordLabel')}
                  placeholder={t('settings.backup.portableOwnerPasswordLabel')}
                  onChange={(e) => setPortablePassword(e.target.value)}
                />

                {portableStage === 'token' && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{t('settings.backup.portableCodeSent')}</p>
                    <Input
                      value={portableToken}
                      aria-label={t('settings.backup.portableCodeLabel')}
                      placeholder={t('settings.backup.portableCodeLabel')}
                      onChange={(e) => setPortableToken(e.target.value)}
                    />
                  </div>
                )}

                {portableNotice && (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
                  >
                    {portableNotice}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void submitPortable(portableStage === 'token' ? 'complete' : 'challenge')}
                    disabled={
                      portableBusy ||
                      portableEmail.trim().length === 0 ||
                      portableCompany.trim().length === 0 ||
                      portablePassword.trim().length === 0 ||
                      (portableStage === 'token' && portableToken.trim().length === 0)
                    }
                  >
                    {portableBusy ? (
                      <>
                        <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.backup.restoring')}
                      </>
                    ) : portableStage === 'token' ? (
                      <>
                        <RotateCcw className="size-4 mr-1" /> {t('settings.backup.portableRestore')}
                      </>
                    ) : (
                      <>
                        <Mail className="size-4 mr-1" /> {t('settings.backup.portableSendCode')}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPortable(null);
                      setPortableNotice(null);
                      setPortableStage('form');
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
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
            {unreadable.length > 0 && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 flex items-start gap-2">
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {t('settings.backup.unreadableBackupsTitle')}
                  </p>
                  <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                    {t('settings.backup.unreadableBackupsDesc')}
                  </p>
                  <ul className="space-y-0.5">
                    {unreadable.map((file) => (
                      <li key={file.filename} className="text-xs text-amber-800 dark:text-amber-300">
                        <span className="font-mono break-all">{file.filename}</span>
                        <span className="block text-amber-700/70 dark:text-amber-400/70 break-words">
                          {file.error}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
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
