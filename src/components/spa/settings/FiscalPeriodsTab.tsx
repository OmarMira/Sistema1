'use client';

import { useState, useEffect } from 'react';
import {
  Calendar,
  Plus,
  Lock,
  Unlock,
  Loader2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { toast } from 'sonner';
import { formatDate } from '@/lib/format';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Types ───────────────────────────────────────────────────── */

interface FiscalPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isLocked: boolean;
}

/* ─── FiscalPeriodsTab ────────────────────────────────────────── */

export function FiscalPeriodsTab() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newPeriod, setNewPeriod] = useState({
    name: '',
    startDate: '',
    endDate: '',
  });

  const [lockTarget, setLockTarget] = useState<FiscalPeriod | null>(null);
  const [toggling, setToggling] = useState(false);

  // Fetch periods
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings?companyId=${companyId}`, { credentials: 'include' });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setPeriods(data.periods || []);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  async function handleAddPeriod() {
    if (!companyId || !newPeriod.name || !newPeriod.startDate || !newPeriod.endDate) return;
    setAdding(true);
    try {
      const res = await fetch('/api/fiscal-periods', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, ...newPeriod }),
      });
      if (res.ok) {
        const data = await res.json();
        setPeriods((prev) => [...prev, data.period]);
        setNewPeriod({ name: '', startDate: '', endDate: '' });
        setAddOpen(false);
        toast.success(t('settings.periods.periodCreated'));
      } else {
        const data = await res.json();
        toast.error(data.error || t('common.error'));
      }
    } catch {
      toast.error(t('common.error'));
    }
    setAdding(false);
  }

  async function handleToggleLock(period: FiscalPeriod) {
    if (!companyId) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/fiscal-periods/${period.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, isLocked: !period.isLocked }),
      });
      if (res.ok) {
        setPeriods((prev) =>
          prev.map((p) => (p.id === period.id ? { ...p, isLocked: !p.isLocked } : p))
        );
      }
    } catch { /* ignore */ }
    setToggling(false);
    setLockTarget(null);
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Calendar className="size-4" />
                  {t('settings.fiscalPeriodsTab')}
                </CardTitle>
                <CardDescription className="mt-1">
                  {t('settings.fiscalYear')}
                </CardDescription>
              </div>
              <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="size-3.5 mr-1" />
                    {t('settings.periods.addPeriod')}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t('settings.periods.addPeriod')}</DialogTitle>
                    <DialogDescription>{t('settings.fiscalYear')}</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-1.5">
                      <Label>{t('settings.periods.periodName')}</Label>
                      <Input
                        value={newPeriod.name}
                        onChange={(e) => setNewPeriod((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Ej., Enero 2025"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label>{t('settings.periods.startDate')}</Label>
                        <Input
                          type="date"
                          value={newPeriod.startDate}
                          onChange={(e) => setNewPeriod((p) => ({ ...p, startDate: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('settings.periods.endDate')}</Label>
                        <Input
                          type="date"
                          value={newPeriod.endDate}
                          onChange={(e) => setNewPeriod((p) => ({ ...p, endDate: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setAddOpen(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      onClick={handleAddPeriod}
                      disabled={adding || !newPeriod.name || !newPeriod.startDate || !newPeriod.endDate}
                    >
                      {adding ? (
                        <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}</>
                      ) : (
                        <><Plus className="size-4 mr-1" /> {t('common.create')}</>
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : periods.length === 0 ? (
              <div className="text-center py-12">
                <Calendar className="size-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">{t('settings.periods.noPeriods')}</p>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="font-semibold">{t('settings.periods.periodName')}</TableHead>
                      <TableHead className="font-semibold">{t('settings.periods.startDate')}</TableHead>
                      <TableHead className="font-semibold">{t('settings.periods.endDate')}</TableHead>
                      <TableHead className="font-semibold">{t('settings.periods.locked')}/{t('settings.periods.unlocked')}</TableHead>
                      <TableHead className="font-semibold">{t('settings.companies.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {periods.map((period) => (
                      <TableRow key={period.id}>
                        <TableCell className="font-medium">{period.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(period.startDate)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(period.endDate)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={period.isLocked ? 'secondary' : 'default'}
                            className={`text-xs ${!period.isLocked ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}`}
                          >
                            {period.isLocked
                              ? t('settings.periods.locked')
                              : t('settings.periods.unlocked')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLockTarget(period)}
                            disabled={toggling}
                            className="text-xs"
                          >
                            {period.isLocked ? (
                              <><Unlock className="size-3.5 mr-1" /> {t('settings.periods.unlockPeriod')}</>
                            ) : (
                              <><Lock className="size-3.5 mr-1" /> {t('settings.periods.lockPeriod')}</>
                            )}
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

      {/* Lock/Unlock confirmation */}
      <AlertDialog open={!!lockTarget} onOpenChange={() => setLockTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lockTarget?.isLocked ? t('settings.periods.unlockPeriod') : t('settings.periods.confirmLock')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lockTarget?.isLocked
                ? `¿Abrir el período "${lockTarget.name}"? Se podrán crear y modificar pólizas.`
                : t('settings.periods.confirmLockDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => lockTarget && handleToggleLock(lockTarget)}>
              {lockTarget?.isLocked ? t('settings.periods.unlockPeriod') : t('settings.periods.lockPeriod')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
