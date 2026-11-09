'use client';

import { useState } from 'react';
import {
  Upload, UserPlus, Loader2, AlertTriangle, CheckCircle2, HardDrive, KeyRound, Building2, Mail,
} from 'lucide-react';
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
import { translateApiError, type ErrorTranslator } from '@/i18n/errors';
import { InstallationWizard } from '@/components/onboarding/InstallationWizard';

/** Product-wide new-password policy (same rule the backend enforces). */
const MIN_RECOVERY_PASSWORD = 8;
/** Same email shape the backend accepts for the owner address. */
const OWNER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Legacy API code for "this portable file cannot be opened" (kept for API
 * compatibility).
 *
 * It is NOT specific to this screen: the source-owner export flow returns the
 * same code for a genuinely password-only mismatch. The truthful multi-input
 * guidance (owner password, owner email, exact company name, file integrity) is
 * therefore a recovery-form context copy mapped HERE — never a global
 * `errors.<CODE>` entry, so every other surface keeps the shared translator's
 * fallback to the server message.
 */
const RECOVERY_CREDENTIAL_CODE = 'RECOVERY_PASSWORD_MISMATCH';

/**
 * Locale message for a failed recovery request: the recovery-form guidance for
 * that one known code, otherwise `translateApiError` exactly as before (so an
 * unrelated code or a code-less body still shows the server's own detail).
 */
function recoveryErrorMessage(data: unknown, t: ErrorTranslator, fallback: string): string {
  const payload = (data ?? null) as { code?: unknown; details?: unknown } | null;
  const details = payload?.details;
  const detailsCode = details !== null && typeof details === 'object'
    ? (details as { code?: unknown }).code
    : undefined;
  // A specific reason carried in details.code wins, exactly like translateApiError.
  const hasMoreSpecificCode = typeof detailsCode === 'string' && detailsCode !== RECOVERY_CREDENTIAL_CODE;
  if (!hasMoreSpecificCode && payload?.code === RECOVERY_CREDENTIAL_CODE) {
    return t('bootstrap.recoveryCredentialMismatch');
  }
  return translateApiError(payload, t, fallback);
}

export function BootstrapPage({ hasUsers }: { hasUsers?: boolean }) {
  const t = useLanguageStore((s) => s.t);
  const { login, setCurrentView } = useAuthStore();

  const [mode, setMode] = useState<'choose' | 'restore' | 'restoring' | 'setup'>('choose');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [recoveryToken, setRecoveryToken] = useState('');
  // Two explicit stages. The owner password, the owner email and the company
  // name are all inputs of the file's key derivation (the password alone cannot
  // open a portable backup), and only the token emailed to the owner completes it.
  const [stage, setStage] = useState<'authorize' | 'token'>('authorize');
  // Inline, always-visible error: this page is rendered OUTSIDE the AppShell, so
  // a toast alone could be the only feedback — and it must never be the only one.
  // It is also the ONLY notice for a failure that stays on this form: raising the
  // same message as a toast too showed the operator the identical notice twice for
  // one attempt (see `reportRestoreFailure`).
  const [restoreError, setRestoreError] = useState<string | null>(null);

  /**
   * Report ONE failed attempt exactly once.
   *
   * `role="alert"` banner = the primary notice: it persists after a toast would
   * have disappeared, screen readers announce it, and it keeps the message next to
   * the inputs that have to change. The duplicate toast carried no extra
   * information, so the failure is rendered inline only.
   *
   * A failure the page can NOT render inline (it leaves the restore form, e.g. the
   * installation already contains companies) must still be surfaced — that one
   * still toasts, so exactly one notice is always visible and none is ever lost.
   */
  function reportRestoreFailure(
    message: string,
    options: { inline: boolean } = { inline: true },
  ) {
    if (options.inline) {
      setRestoreError(message);
      return;
    }
    // Nothing stays on screen to show it, so the toast IS the single notice.
    setRestoreError(null);
    toast.error(message);
  }

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

  function buildForm(includeToken: boolean) {
    const formData = new FormData();
    if (restoreFile) formData.append('file', restoreFile);
    formData.append('password', recoveryPassword);
    // Key-derivation inputs: the server cannot recover them from the file.
    formData.append('ownerEmail', ownerEmail.trim());
    formData.append('companyName', companyName);
    if (includeToken) formData.append('token', recoveryToken);
    return formData;
  }

  /** Stage 1 — verify the portable envelope and request the owner email token. */
  async function handleRequestToken() {
    if (!restoreFile) return;
    if (recoveryPassword.trim().length < MIN_RECOVERY_PASSWORD) {
      reportRestoreFailure(t('bootstrap.recoveryPasswordTooShort'));
      return;
    }
    if (companyName.trim().length === 0) {
      setRestoreError(t('bootstrap.companyNameRequired'));
      return;
    }
    if (!OWNER_EMAIL_PATTERN.test(ownerEmail.trim())) {
      setRestoreError(t('bootstrap.ownerEmailRequired'));
      return;
    }
    setRestoreError(null);
    setMode('restoring');
    setRestoreProgress(40);
    try {
      setRestoreProgress(70);
      const res = await fetch('/api/bootstrap/restore', {
        method: 'POST',
        credentials: 'include',
        body: buildForm(false),
      });
      const data = await res.json().catch(() => null);
      setRestoreProgress(0);
      if (res.ok && data?.stage === 'challenge_sent') {
        setStage('token');
        setMode('restore');
        toast.success(t('bootstrap.tokenSent'), { description: t('bootstrap.tokenSentDesc') });
        return;
      }
      reportRestoreFailure(recoveryErrorMessage(data, t, t('bootstrap.restoreFailed')));
      setMode('restore');
    } catch {
      reportRestoreFailure(t('bootstrap.restoreFailed'));
      setMode('restore');
      setRestoreProgress(0);
    }
  }

  /** Stage 2 — the token is single use; the restore happens exactly once. */
  async function handleCompleteRestore() {
    if (!restoreFile) return;
    if (recoveryToken.trim().length === 0) {
      setRestoreError(t('bootstrap.tokenRequired'));
      return;
    }
    setRestoreError(null);
    setMode('restoring');
    setRestoreProgress(60);
    try {
      setRestoreProgress(85);
      const res = await fetch('/api/bootstrap/restore', {
        method: 'POST',
        credentials: 'include',
        body: buildForm(true),
      });
      const data = await res.json().catch(() => null);

      if (res.ok) {
        setRestoreProgress(100);
        const totalRecords = (Object.values(data.restoredCounts || {}) as number[]).reduce(
          (a: number, b: number) => a + Number(b || 0),
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
        // The page returns to the chooser, so no inline banner survives: the toast
        // is this failure's single notice.
        reportRestoreFailure(translateApiError(data, t, t('bootstrap.dbNotEmpty')), { inline: false });
        setMode('choose');
      } else {
        // recoveryErrorMessage: the recovery-form guidance for the one known
        // portable-file code, otherwise translateApiError — locale-native for a
        // known code, the server's own detail otherwise. Never a raw key and
        // never a silent failure.
        reportRestoreFailure(recoveryErrorMessage(data, t, t('bootstrap.restoreFailed')));
        setMode('restore');
      }
    } catch {
      reportRestoreFailure(t('bootstrap.restoreFailed'));
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
                      <Mail className="size-4 text-muted-foreground shrink-0" />
                      <Label htmlFor="bootstrap-owner-email">
                        {t('bootstrap.ownerEmailLabel')}
                      </Label>
                    </div>
                    <Input
                      id="bootstrap-owner-email"
                      type="email"
                      inputMode="email"
                      value={ownerEmail}
                      autoComplete="email"
                      disabled={stage === 'token'}
                      placeholder={t('bootstrap.ownerEmailPlaceholder')}
                      onChange={(e) => {
                        setOwnerEmail(e.target.value);
                        setRestoreError(null);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('bootstrap.ownerEmailHint')}</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-4 text-muted-foreground shrink-0" />
                      <Label htmlFor="bootstrap-recovery-password">
                        {t('bootstrap.ownerPasswordLabel')}
                      </Label>
                    </div>
                    <Input
                      id="bootstrap-recovery-password"
                      type="password"
                      value={recoveryPassword}
                      minLength={MIN_RECOVERY_PASSWORD}
                      autoComplete="current-password"
                      disabled={stage === 'token'}
                      placeholder={t('bootstrap.recoveryPasswordPlaceholder')}
                      onChange={(e) => {
                        setRecoveryPassword(e.target.value);
                        setRestoreError(null);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('bootstrap.ownerPasswordHint')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4 text-muted-foreground shrink-0" />
                      <Label htmlFor="bootstrap-company-name">
                        {t('bootstrap.companyNameLabel')}
                      </Label>
                    </div>
                    <Input
                      id="bootstrap-company-name"
                      value={companyName}
                      disabled={stage === 'token'}
                      placeholder={t('bootstrap.companyNamePlaceholder')}
                      onChange={(e) => {
                        setCompanyName(e.target.value);
                        setRestoreError(null);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('bootstrap.companyNameHint')}</p>
                  </div>

                  {stage === 'token' && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Mail className="size-4 text-muted-foreground shrink-0" />
                        <Label htmlFor="bootstrap-recovery-token">
                          {t('bootstrap.tokenLabel')}
                        </Label>
                      </div>
                      <Input
                        id="bootstrap-recovery-token"
                        value={recoveryToken}
                        autoComplete="one-time-code"
                        placeholder={t('bootstrap.tokenPlaceholder')}
                        onChange={(e) => {
                          setRecoveryToken(e.target.value);
                          setRestoreError(null);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">{t('bootstrap.tokenHint')}</p>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      className="flex-1"
                      onClick={() => {
                        setRestoreError(null);
                        setStage('authorize');
                        setRecoveryToken('');
                        setMode('choose');
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                    {stage === 'authorize' ? (
                      <Button
                        className="flex-1"
                        disabled={
                          !restoreFile ||
                          recoveryPassword.trim().length < MIN_RECOVERY_PASSWORD ||
                          !OWNER_EMAIL_PATTERN.test(ownerEmail.trim()) ||
                          companyName.trim().length === 0
                        }
                        onClick={handleRequestToken}
                      >
                        {t('bootstrap.sendToken')}
                      </Button>
                    ) : (
                      <Button
                        className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={!restoreFile || recoveryToken.trim().length === 0}
                        onClick={handleCompleteRestore}
                      >
                        {t('bootstrap.completeRestore')}
                      </Button>
                    )}
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
