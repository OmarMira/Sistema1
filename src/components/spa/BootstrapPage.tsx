'use client';

import { useState } from 'react';
import { Upload, UserPlus, Loader2, AlertTriangle, CheckCircle2, HardDrive } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type User } from '@/store/auth-store';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { formatFileSize } from '@/lib/types/backup';

export function BootstrapPage() {
  const t = useLanguageStore((s) => s.t);
  const { login, setCurrentView } = useAuthStore();

  const [mode, setMode] = useState<'choose' | 'restore' | 'restoring'>('choose');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreProgress, setRestoreProgress] = useState(0);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.backup')) {
      toast.error(t('bootstrap.invalidFile'));
      return;
    }
    setRestoreFile(file);
  }

  async function handleRestore() {
    if (!restoreFile) return;
    setMode('restoring');
    setRestoreProgress(10);

    try {
      setRestoreProgress(30);
      const formData = new FormData();
      formData.append('file', restoreFile);

      setRestoreProgress(50);
      const res = await fetch('/api/bootstrap/restore', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      setRestoreProgress(80);
      const data = await res.json();

      if (res.ok) {
        setRestoreProgress(100);
        const totalRecords = (Object.values(data.restoredCounts || {}) as number[]).reduce(
          (a, b) => a + b,
          0,
        );
        toast.success(t('bootstrap.restoreSuccess'), {
          description: `${totalRecords} registros`,
        });

        const user: User = data.user;
        const companies = data.companies || [];

        login(user);

        if (companies.length > 0) {
          useAuthStore.getState().setActiveCompany(companies[0]);
        }
        setCurrentView('dashboard');
      } else if (res.status === 409) {
        toast.error(t('bootstrap.dbNotEmpty'));
        setMode('choose');
      } else {
        toast.error(t('bootstrap.restoreFailed'), { description: data.error });
        setMode('restore');
      }
    } catch {
      toast.error(t('bootstrap.restoreFailed'));
      setMode('restore');
    }
    setRestoreProgress(0);
  }

  return (
    <div className="flex min-h-screen flex-col">
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
              <Card
                className="cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 border-primary/20"
                onClick={() => setCurrentView('register')}
              >
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <UserPlus className="size-4 text-primary" />
                    {t('bootstrap.startFresh')}
                  </CardTitle>
                  <CardDescription>{t('bootstrap.startFreshDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" variant="outline">
                    {t('auth.register')}
                  </Button>
                </CardContent>
              </Card>

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
                    Esto reemplazará permanentemente TODOS los datos actuales. Esta acción no se puede deshacer.
                  </p>
                </div>

                <div className="space-y-3">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => document.getElementById('bootstrap-file-input')?.click()}
                  >
                    <Upload className="size-4 mr-2" />
                    {restoreFile ? restoreFile.name : t('bootstrap.selectFile')}
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
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 text-emerald-600" />
                        <p className="text-sm font-medium truncate flex-1">{restoreFile.name}</p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatFileSize(restoreFile.size)}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button variant="ghost" className="flex-1" onClick={() => setMode('choose')}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={!restoreFile}
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
