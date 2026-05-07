'use client';

import { useState } from 'react';
import {
  Database,
  Download,
  Upload,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Clock,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Types ───────────────────────────────────────────────────── */

interface BackupRecord {
  id: string;
  date: string;
  size: string;
  type: 'manual' | 'automatic';
}

/* ─── BackupTab ───────────────────────────────────────────────── */

export function BackupTab() {
  const t = useLanguageStore((s) => s.t);

  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);

  // Mock backup history
  const [backups] = useState<BackupRecord[]>([
    {
      id: '1',
      date: new Date(Date.now() - 3600000 * 2).toISOString(),
      size: '156KB',
      type: 'manual',
    },
    {
      id: '2',
      date: new Date(Date.now() - 86400000).toISOString(),
      size: '148KB',
      type: 'automatic',
    },
    {
      id: '3',
      date: new Date(Date.now() - 86400000 * 3).toISOString(),
      size: '142KB',
      type: 'manual',
    },
  ]);

  async function handleCreateBackup() {
    setCreating(true);
    setCreateProgress(0);

    // Simulate progress
    const interval = setInterval(() => {
      setCreateProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          return 100;
        }
        return prev + Math.random() * 30;
      });
    }, 300);

    try {
      const res = await fetch('/api/backup', { method: 'POST' });
      if (res.ok) {
        toast.success(t('settings.backup.backupCreated'));
      } else {
        toast.error(t('settings.backup.backupFailed'));
      }
    } catch {
      toast.error(t('settings.backup.backupFailed'));
    }

    clearInterval(interval);
    setCreateProgress(100);
    setTimeout(() => {
      setCreating(false);
      setCreateProgress(0);
    }, 800);
  }

  async function handleRestore() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.db,.sql';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setRestoring(true);
      setRestoreProgress(0);

      const interval = setInterval(() => {
        setRestoreProgress((prev) => {
          if (prev >= 100) {
            clearInterval(interval);
            return 100;
          }
          return prev + Math.random() * 20;
        });
      }, 400);

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/backup/restore', {
          method: 'POST',
          body: formData,
        });
        if (res.ok) {
          toast.success(t('settings.backup.restoreSuccess'));
        } else {
          toast.error(t('settings.backup.restoreFailed'));
        }
      } catch {
        toast.error(t('settings.backup.restoreFailed'));
      }

      clearInterval(interval);
      setRestoreProgress(100);
      setTimeout(() => {
        setRestoring(false);
        setRestoreProgress(0);
      }, 800);
    };
    input.click();
  }

  function handleDownload(backup: BackupRecord) {
    toast.info(t('settings.backup.download'));
  }

  function formatDate(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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
          <span className="text-xs text-muted-foreground">{t('settings.backup.persistentDesc')}</span>
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
          <CardContent className="space-y-4">
            <Button onClick={handleCreateBackup} disabled={creating}>
              {creating ? (
                <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.backup.creating')}</>
              ) : (
                <><Database className="size-4 mr-1" /> {t('settings.backup.createBackup')}</>
              )}
            </Button>
            {creating && (
              <div className="space-y-2">
                <Progress value={Math.min(createProgress, 100)} className="h-2" />
                <p className="text-xs text-muted-foreground">{t('settings.backup.creating')}</p>
              </div>
            )}
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
              <p className="text-sm text-amber-700 dark:text-amber-300">{t('settings.backup.restoreWarning')}</p>
            </div>
            <Button variant="outline" onClick={handleRestore} disabled={restoring}>
              {restoring ? (
                <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.backup.restoring')}</>
              ) : (
                <><Upload className="size-4 mr-1" /> {t('settings.backup.selectFile')}</>
              )}
            </Button>
            {restoring && (
              <div className="space-y-2">
                <Progress value={Math.min(restoreProgress, 100)} className="h-2" />
                <p className="text-xs text-muted-foreground">{t('settings.backup.restoring')}</p>
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
            {backups.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {t('settings.backup.noBackups')}
              </p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="font-semibold">{t('settings.backup.date')}</TableHead>
                      <TableHead className="font-semibold">{t('settings.backup.size')}</TableHead>
                      <TableHead className="font-semibold">{t('settings.backup.type')}</TableHead>
                      <TableHead className="font-semibold w-24"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {backups.map((backup) => (
                      <TableRow key={backup.id}>
                        <TableCell className="text-sm">{formatDate(backup.date)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{backup.size}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {backup.type === 'automatic'
                              ? t('settings.backup.automatic')
                              : t('settings.backup.manual')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownload(backup)}
                            className="text-xs"
                          >
                            <Download className="size-3.5 mr-1" />
                            {t('settings.backup.download')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
