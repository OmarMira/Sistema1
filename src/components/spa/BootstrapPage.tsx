'use client';

import { useState } from 'react';
import { Upload, UserPlus, Loader2, AlertTriangle, CheckCircle2, HardDrive, KeyRound } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type User } from '@/store/auth-store';
import { toast, Toaster as SonnerToaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { formatFileSize } from '@/lib/types/backup';
import { translateApiError } from '@/i18n/errors';
import { InstallationWizard } from '@/components/onboarding/InstallationWizard';

/** Product-wide new-password policy (same rule the backend enforces). */
const MIN_RECOVERY_PASSWORD = 8;

export function BootstrapPage({ hasUsers }: { hasUsers?: boolean }) {
  const t = useLanguageStore((s) => s.t);
  const { login, setCurrentView } = useAuthStore();

  const [mode, setMode] = useState<'choose' | 'restore' | 'restoring' | 'setup'>('choose');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  // S1/S2: restoring — even from zero — must prove that the operator knows the
  // password of the super admin who CREATED the backup, so a stolen file cannot
  // install itself on an empty installation. Component state only: never
  // persisted, never logged, cleared as soon as the restore succeeds.
  const [ownerPassword, setOwnerPassword] = useState('');
  // Inline, always-visible error: this page is rendered OUTSIDE the AppShell, so
  // a toast alone could be the only feedback — and it must never be the only one.
  const [restoreError, setRestoreError] = useState<string | null>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.backup')) {
      toast.error(t('bootstrap.invalidFile'));
      return;
    }
    setRestoreFile(file);
    setRestoreError(null);
  }

  async function handleRestore() {
    if (!restoreFile) return;
    if (recoveryPassword.trim().length < MIN_RECOVERY_PASSWORD) {
      setRestoreError(t('bootstrap.recoveryPasswordTooShort'));
      toast.error(t('bootstrap.recoveryPasswordTooShort'));
      return;
    }
    if (ownerPassword.trim().length === 0) {
      const message = t('errors.RESTORE_OWNERSHIP');
      setRestoreError(message);
      toast.error(message);
      return;
    }

    setRestoreError(null);
    setMode('restoring');
    setRestoreProgress(10);

    try {
      setRestoreProgress(30);
      const formData = new FormData();
      formData.append('file', restoreFile);
      formData.append('recoveryPassword', recoveryPassword);
      // The creating super-admin's credential: verified by the route BEFORE the
      // bootstrap shell exists, so a stolen file never installs anything.
      formData.append('ownerPassword', ownerPassword);

      setRestoreProgress(50);
      // No setup token: the empty-database gate is the endpoint's authorization.
      const res = await fetch('/api/bootstrap/restore', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      setRestoreProgress(80);
      const data = await res.json().catch(() => null);

      if (res.ok) {
        setRestoreProgress(100);
        setOwnerPassword('');
        const totalRecords = (Object.values(data.restoredCounts || {}) as number[]).reduce(
          (a: number, b) => a + Number(b || 0),
          0,
        );
        toast.success(t('bootstrap.restoreSuccess'), {
          description: `${totalRecords} ${t('bootstrap.restoredRecords')}`,
        });

        const user: User = data.user;
        const companies = data.companies || [];

        login(user);

        if (companies.length > 0) {
          useAuthStore.getState().setActiveCompany(companies[0]);
        }
        setCurrentView('dashboard');
      } else if (res.status === 409) {
        const message = t('bootstrap.dbNotEmpty');
        setRestoreError(message);
        toast.error(message);
        setMode('choose');
      } else {
        // translateApiError: locale-native message for a known code, otherwise
        // the server's own detail — never a raw key and never a silent failure.
        const message = translateApiError(data, t, t('bootstrap.restoreFailed'));
        setRestoreError(message);
        toast.error(t('bootstrap.restoreFailed'), { description: message });
        setMode('restore');
      }
    } catch {
      const message = t('bootstrap.restoreFailed');
      setRestoreError(message);
      toast.error(message);
      setMode('restore');
    }
    setRestoreProgress(0);
  }

  if (mode === 'setup') return <InstallationWizard onBack={() => setMode('choose')} />;

  return (
    <div className="flex min-h-screen flex-col">
      {/* This view renders outside the AppShell, which is what mounts the toaster;
          without it every toast on the first-install page (including the restore
          error) is invisible. */}
      <SonnerToaster position="top-center" richColors closeButton />
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
              AE
            </div>
            <span className="text-lg font-semibold tracking-tight">{t('common.appName')}</span>
          </div>
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        {mode === 'choose' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-2xl space-y-6"
          >
            <div className="text-center space-y-2">
              <HardDrive className="size-12 mx-auto text-muted-foreground" />
              <h1 className="text-2xl font-bold tracking-tight">{t('bootstrap.title')}</h1>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                {t('bootstrap.subtitle')}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {hasUsers ? (
                <Card
                  className="cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 border-primary/20"
                  onClick={() => setCurrentView('login')}
                >
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <UserPlus className="size-4 text-primary" />
                      {t('auth.login')}
                    </CardTitle>
                    <CardDescription>{t('bootstrap.startFreshDesc')}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button className="w-full" variant="outline" onClick={() => setCurrentView('login')}>
                      {t('auth.login')}
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <Card
                  className="cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 border-primary/20"
                  onClick={() => setMode('setup')}
                >
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <UserPlus className="size-4 text-primary" />
                      {t('bootstrap.startFresh')}
                    </CardTitle>
                    <CardDescription>{t('bootstrap.startFreshDesc')}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button className="w-full" variant="outline" onClick={() => setMode('setup')}>
                      {t('auth.register')}
                    </Button>
                  </CardContent>
                </Card>
              )}

              <Card
                className="cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 border-amber-200/50"
                onClick={() => setMode('restore')}
              >
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Upload className="size-4 text-amber-600" />
                    {t('bootstrap.restoreBackup')}
                  </CardTitle>
                  <CardDescription>{t('bootstrap.restoreBackupDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" variant="outline">
                    <Upload className="size-4 mr-1" />
                    {t('bootstrap.selectFile')}
                  </Button>
                </CardContent>
              </Card>
            </div>
          </motion.div>
        )}

        {mode === 'restore' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-md space-y-6"
          >
            <Card className="border-amber-200 dark:border-amber-900">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Upload className="size-4 text-amber-600" />
                  {t('bootstrap.restoreBackup')}
                </CardTitle>
                <CardDescription>{t('bootstrap.restoreBackupDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    {t('bootstrap.overwriteWarning')}
                  </p>
                </div>

                {restoreError && (
                  <div
                    role="alert"
                    data-testid="bootstrap-restore-error"
                    className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3"
                  >
                    <AlertTriangle className="size-4 text-destructive mt-0.5 shrink-0" />
                    <p className="text-xs text-destructive break-words">{restoreError}</p>
                  </div>
                )}

                <div className="space-y-3">
                  <Button
                    variant="outline"
                    className="w-full max-w-full overflow-hidden"
                    onClick={() => document.getElementById('bootstrap-file-input')?.click()}
                  >
                    <Upload className="size-4 mr-2 shrink-0" />
                    <span className="truncate">{t('bootstrap.selectFile')}</span>
                  </Button>
                  <input
                    id="bootstrap-file-input"
                    type="file"
                    accept=".json,.backup"
                    className="hidden"
                    onChange={handleFileSelect}
                  />

                  {restoreFile && (
                    <div className="rounded-lg border bg-muted/50 p-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                        <p className="text-sm font-medium truncate flex-1 min-w-0">{restoreFile.name}</p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatFileSize(restoreFile.size)}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-4 text-muted-foreground shrink-0" />
                      <Label htmlFor="bootstrap-recovery-password">
                        {t('bootstrap.recoveryPasswordLabel')}
                      </Label>
                    </div>
                    <Input
                      id="bootstrap-recovery-password"
                      type="password"
                      value={recoveryPassword}
                      minLength={MIN_RECOVERY_PASSWORD}
                      autoComplete="new-password"
                      placeholder={t('bootstrap.recoveryPasswordPlaceholder')}
                      onChange={(e) => {
                        setRecoveryPassword(e.target.value);
                        setRestoreError(null);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('bootstrap.recoveryPasswordHint')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-4 text-muted-foreground shrink-0" />
                      <Label htmlFor="bootstrap-owner-password">
                        Contraseña del administrador que creó el backup
                      </Label>
                    </div>
                    <Input
                      id="bootstrap-owner-password"
                      type="password"
                      required
                      value={ownerPassword}
                      autoComplete="current-password"
                      onChange={(e) => {
                        setOwnerPassword(e.target.value);
                        setRestoreError(null);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      La restauración exige la contraseña del super administrador que creó este respaldo, no la
                      de cualquier otra cuenta. Sin ella el archivo no se restaura.
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      className="flex-1"
                      onClick={() => {
                        setRestoreError(null);
                        setMode('choose');
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={
                        !restoreFile ||
                        recoveryPassword.trim().length < MIN_RECOVERY_PASSWORD ||
                        ownerPassword.trim().length === 0
                      }
                      onClick={handleRestore}
                    >
                      {t('bootstrap.restoreBackup')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {mode === 'restoring' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          >
            <Card className="w-full max-w-md mx-4">
              <CardContent className="p-6 flex flex-col items-center gap-4">
                <Loader2 className="size-12 animate-spin text-primary" />
                <div className="text-center">
                  <p className="text-lg font-semibold">{t('bootstrap.restoring')}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('bootstrap.restoreBackupDesc')}
                  </p>
                </div>
                <Progress value={restoreProgress} className="w-full" />
              </CardContent>
            </Card>
          </motion.div>
        )}
      </main>
    </div>
  );
}
