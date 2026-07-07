'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Calendar,
  Plus,
  Lock,
  Unlock,
  Loader2,
  Sparkles,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

interface FiscalPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isLocked: boolean;
}

export function FiscalPeriodsTab() {
  const t = useLanguageStore((s) => s.t);
  const language = useLanguageStore((s) => s.language) || 'es';
  const isEn = language === 'en';

  const dt = {
    fiscalPeriods: isEn ? 'Fiscal Periods' : 'Periodos Fiscales',
    fiscalYear: isEn ? 'Fiscal Year' : 'Año Fiscal',
    autoGeneration: isEn ? 'Automatic Generation' : 'Generación Automática',
    generatePeriods: isEn ? 'Generate Periods' : 'Generación de Períodos',
    autoGenDesc: isEn
      ? 'Intelligently and automatically create the entire fiscal year with dynamic patterns.'
      : 'Crea de forma inteligente y automatizada el año fiscal completo con patrones dinámicos.',
    closingAccount: isEn ? 'Closing Account' : 'Cuenta de Cierre',
    calculationStrategy: isEn ? 'Calculation Strategy' : 'Estrategia de Cálculo',
    calendarStandard: isEn ? 'Standard Calendar (Jan - Dec)' : 'Calendario Estándar (Ene - Dic)',
    customMonths: isEn ? 'Custom Months' : 'Meses Personalizados',
    week5253: isEn ? '52/53 Week Rule' : 'Regla 52/53 Semanas',
    startMonth: isEn ? 'Start Month (1-12)' : 'Mes de Inicio (1-12)',
    generateFiscalYear: isEn ? 'Generate Fiscal Year' : 'Generar Año Fiscal',
    yearEndClose: isEn ? 'Year End Closing' : 'Cierre de Ejercicio',
    yearEndCloseTitle: isEn ? 'Accounting Year-End Closing' : 'Cierre de Ejercicio Contable',
    yearEndCloseDesc: isEn
      ? 'This action is immutable and atomic. It will generate the closing journal entry for P&L and lock the periods.'
      : 'Esta acción es inmutable y atómica. Generará el asiento contable de cierre del PyG y bloqueará los períodos.',
    yearToClose: isEn ? 'Year to Close' : 'Año a Cerrar',
    accountingWarning: isEn ? '⚠️ Accounting Warning:' : '⚠️ Advertencia Contable:',
    warning1: isEn
      ? '1. All periods of the year to close must be previously locked.'
      : '1. Todos los períodos del año a cerrar deben estar previamente bloqueados (Locks).',
    warning2: isEn
      ? '2. All journal entries must be in "Posted" status and completely balanced.'
      : '2. Todos los asientos deben estar en estado "Posted" y completamente balanceados.',
    executeClose: isEn ? 'Execute Accounting Close' : 'Ejecutar Cierre Contable',
    status: isEn ? 'Status' : 'Estado',
    closed: isEn ? '🔒 Closed' : '🔒 Cerrado',
    open: isEn ? '🟢 Open' : '🟢 Abierto',
    unlock: isEn ? 'Unlock' : 'Desbloquear',
    lock: isEn ? 'Lock' : 'Bloquear',
    unlockPeriodDesc: (name: string) =>
      isEn
        ? `Open period "${name}"? You will be able to create and modify journal entries.`
        : `¿Abrir el período "${name}"? Se podrán crear y modificar asientos.`,
    confirmUnlock: isEn ? 'Confirm Unlock' : 'Confirmar Desbloqueo',
    confirmLock: isEn ? 'Confirm Lock' : 'Confirmar Bloqueo',
    conflictWarning: isEn
      ? 'Period conflict or duplicate name detected.'
      : 'Conflicto de período o nombre duplicado detectado.',
    generationSuccess: isEn
      ? 'Fiscal periods generated successfully!'
      : '¡Períodos fiscales generados exitosamente!',
    generationError: isEn ? 'Error generating periods' : 'Error al generar períodos',
    networkError: isEn
      ? 'Network error connecting to server'
      : 'Error de red al conectar con el servidor',
    closeSuccess: isEn
      ? 'Accounting year-end closed successfully!'
      : '¡Cierre de ejercicio contable ejecutado con éxito!',
    closeError: isEn ? 'Error performing year-end close' : 'Error al realizar el cierre',
    operationError: isEn ? 'Error performing the operation' : 'Error al realizar la operación',
    periodUnlocked: isEn ? 'Period unlocked' : 'Período desbloqueado',
    periodLocked: isEn ? 'Period locked' : 'Período bloqueado',
    lockError: isEn ? 'Error changing lock status' : 'Error al cambiar estado de bloqueo',
  };

  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [loading, setLoading] = useState(true);

  // Manual Period Dialog
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newPeriod, setNewPeriod] = useState({
    name: '',
    startDate: '',
    endDate: '',
  });

  // Automatic Generation Dialog
  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genYear, setGenYear] = useState(new Date().getFullYear());
  const [genType, setGenType] = useState<'CALENDAR' | 'CUSTOM_MONTHS' | 'WEEK_52_53'>('CALENDAR');
  const [startMonth, setStartMonth] = useState(1);
  const [closingAccountCode, setClosingAccountCode] = useState('3000');

  // Year End Closing Dialog
  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeYear, setCloseYear] = useState(new Date().getFullYear());

  // Lock/Unlock AlertDialog
  const [lockTarget, setLockTarget] = useState<FiscalPeriod | null>(null);
  const [toggling, setToggling] = useState(false);

  // Fetch periods function
  const fetchPeriods = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await fetch(`/api/settings?companyId=${companyId}`);
      if (res.ok) {
        const data = await res.json();
        setPeriods(data.periods || []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchPeriods();
  }, [fetchPeriods]);

  async function handleAddPeriod() {
    if (!companyId || !newPeriod.name || !newPeriod.startDate || !newPeriod.endDate) return;
    setAdding(true);
    try {
      const res = await fetch('/api/fiscal-periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, ...newPeriod }),
      });
      if (res.ok) {
        toast.success(t('settings.periods.periodCreated'));
        setNewPeriod({ name: '', startDate: '', endDate: '' });
        setAddOpen(false);
        await fetchPeriods();
      } else {
        const data = await res.json();
        toast.error(data.error || t('common.error'));
      }
    } catch {
      toast.error(t('common.error'));
    } finally {
      setAdding(false);
    }
  }

  async function handleGeneratePeriods() {
    if (!companyId) return;
    setGenerating(true);
    try {
      const config = {
        type: genType,
        startMonth: Number(startMonth),
        closingAccountCode,
        allowShortPeriods: false,
        periodsPerYear: 12,
      };

      const res = await fetch('/api/fiscal-periods/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, year: Number(genYear), config }),
      });

      if (res.status === 409) {
        toast.warning(dt.conflictWarning);
        await fetchPeriods();
        setGenOpen(false);
        return;
      }

      if (res.ok) {
        toast.success(dt.generationSuccess);
        setGenOpen(false);
        await fetchPeriods();
      } else {
        const data = await res.json();
        toast.error(data.error || dt.generationError);
      }
    } catch {
      toast.error(dt.networkError);
    } finally {
      setGenerating(false);
    }
  }

  async function handleYearEndClose() {
    if (!companyId) return;
    setClosing(true);
    try {
      const config = {
        type: 'CALENDAR', // Usamos CALENDAR por defecto para el cierre rápido
        startMonth: 1,
        closingAccountCode: '3000',
        allowShortPeriods: false,
        periodsPerYear: 12,
      };

      const res = await fetch('/api/fiscal-periods/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, year: Number(closeYear), config }),
      });

      if (res.ok) {
        toast.success(dt.closeSuccess);
        setCloseOpen(false);
        await fetchPeriods();
      } else {
        const data = await res.json();
        toast.error(data.error || dt.closeError);
      }
    } catch {
      toast.error(dt.operationError);
    } finally {
      setClosing(false);
    }
  }

  async function handleLockPeriod(period: FiscalPeriod) {
    if (!companyId) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/fiscal-periods/${period.id}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      if (res.ok) {
        toast.success(dt.periodLocked);
        await fetchPeriods();
      } else {
        const data = await res.json();
        toast.error(data.error || dt.lockError);
      }
    } catch {
      toast.error(dt.networkError);
    } finally {
      setToggling(false);
      setLockTarget(null);
    }
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      <motion.div variants={itemVariants}>
        <Card className="overflow-hidden border border-border/80">
          <CardHeader className="bg-muted/30 border-b border-border/40 py-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2 font-semibold">
                  <Calendar className="size-5 text-indigo-500" />
                  {t('settings.fiscalPeriodsTab')}
                </CardTitle>
                <CardDescription className="mt-1">{t('settings.fiscalYear')}</CardDescription>
              </div>
              <div className="flex items-center flex-wrap gap-2">
                {/* Auto Generate Button */}
                <Dialog open={genOpen} onOpenChange={setGenOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-indigo-200 hover:border-indigo-300 dark:border-indigo-900/50"
                    >
                      <Sparkles className="size-3.5 mr-1.5 text-indigo-500 animate-pulse" />
                      {dt.autoGeneration}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="size-5 text-indigo-500" />
                        {dt.generatePeriods}
                      </DialogTitle>
                      <DialogDescription>{dt.autoGenDesc}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label>{dt.fiscalYear}</Label>
                          <Input
                            type="number"
                            value={genYear}
                            onChange={(e) => setGenYear(Number(e.target.value))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>{dt.closingAccount}</Label>
                          <Input
                            value={closingAccountCode}
                            onChange={(e) => setClosingAccountCode(e.target.value)}
                            placeholder="Ej. 3000"
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label>{dt.calculationStrategy}</Label>
                        <Select value={genType} onValueChange={(v) => setGenType(v as 'CALENDAR' | 'CUSTOM_MONTHS' | 'WEEK_52_53')}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CALENDAR">{dt.calendarStandard}</SelectItem>
                            <SelectItem value="CUSTOM_MONTHS">{dt.customMonths}</SelectItem>
                            <SelectItem value="WEEK_52_53">{dt.week5253}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {genType === 'CUSTOM_MONTHS' && (
                        <div className="space-y-1.5">
                          <Label>{dt.startMonth}</Label>
                          <Input
                            type="number"
                            min={1}
                            max={12}
                            value={startMonth}
                            onChange={(e) => setStartMonth(Number(e.target.value))}
                          />
                        </div>
                      )}
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setGenOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button
                        onClick={handleGeneratePeriods}
                        disabled={generating}
                        className="bg-indigo-600 hover:bg-indigo-700"
                      >
                        {generating ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
                        {dt.generateFiscalYear}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Year End Close Button */}
                <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="bg-amber-600 hover:bg-amber-700 text-white border-none"
                    >
                      <Lock className="size-3.5 mr-1.5" />
                      {dt.yearEndClose}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2 text-amber-600">
                        <AlertTriangle className="size-5 text-amber-500 animate-bounce" />
                        {dt.yearEndCloseTitle}
                      </DialogTitle>
                      <DialogDescription>{dt.yearEndCloseDesc}</DialogDescription>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                      <div className="space-y-1.5">
                        <Label>{dt.yearToClose}</Label>
                        <Input
                          type="number"
                          value={closeYear}
                          onChange={(e) => setCloseYear(Number(e.target.value))}
                        />
                      </div>
                      <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 p-3 border border-amber-200/40 text-amber-800 dark:text-amber-300 text-xs leading-relaxed space-y-1">
                        <p className="font-semibold">{dt.accountingWarning}</p>
                        <p>{dt.warning1}</p>
                        <p>{dt.warning2}</p>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setCloseOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button
                        onClick={handleYearEndClose}
                        disabled={closing}
                        className="bg-amber-600 hover:bg-amber-700 text-white"
                      >
                        {closing ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
                        {dt.executeClose}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Add Manual Button */}
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
                            onChange={(e) =>
                              setNewPeriod((p) => ({ ...p, startDate: e.target.value }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>{t('settings.periods.endDate')}</Label>
                          <Input
                            type="date"
                            value={newPeriod.endDate}
                            onChange={(e) =>
                              setNewPeriod((p) => ({ ...p, endDate: e.target.value }))
                            }
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
                        disabled={
                          adding || !newPeriod.name || !newPeriod.startDate || !newPeriod.endDate
                        }
                      >
                        {adding ? (
                          <>
                            <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}
                          </>
                        ) : (
                          <>
                            <Plus className="size-4 mr-1" /> {t('common.create')}
                          </>
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-6 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : periods.length === 0 ? (
              <div className="text-center py-16">
                <Calendar className="size-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">{t('settings.periods.noPeriods')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader className="bg-muted/20">
                  <TableRow>
                    <TableHead className="font-semibold px-6">
                      {t('settings.periods.periodName')}
                    </TableHead>
                    <TableHead className="font-semibold">
                      {t('settings.periods.startDate')}
                    </TableHead>
                    <TableHead className="font-semibold">{t('settings.periods.endDate')}</TableHead>
                    <TableHead className="font-semibold">{dt.status}</TableHead>
                    <TableHead className="font-semibold text-right px-6">
                      {t('settings.companies.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((period) => (
                    <TableRow key={period.id}>
                      <TableCell className="font-semibold px-6 text-sm">{period.name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(period.startDate)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(period.endDate)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={period.isLocked ? 'outline' : 'outline'}
                          className={`text-xs ${
                            period.isLocked
                              ? 'border-amber-200/50 bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400'
                              : 'border-emerald-200/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-400'
                          }`}
                        >
                          {period.isLocked ? dt.closed : dt.open}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right px-6">
                        {!period.isLocked ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLockTarget(period)}
                            disabled={toggling}
                            className="text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50/50"
                          >
                            <Lock className="size-3.5 mr-1.5" />
                            {dt.lock}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground italic flex items-center justify-end gap-1 select-none py-1.5 px-3">
                            <Lock className="size-3.5 text-muted-foreground" />
                            {isEn ? 'Locked' : 'Bloqueado'}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Lock confirmation */}
      <AlertDialog open={!!lockTarget} onOpenChange={() => setLockTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Lock className="size-5 text-amber-500" />
              {t('settings.periods.confirmLock')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span>
                {t('settings.periods.confirmLockDesc')}
              </span>
              <span className="block mt-2 font-semibold text-destructive flex items-center gap-1.5">
                <AlertTriangle className="size-4 text-destructive" />
                {isEn
                  ? 'WARNING: This action is irreversible. You will not be able to unlock this period.'
                  : 'ADVERTENCIA: Esta acción es irreversible. No se podrá volver a abrir este período.'}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => lockTarget && handleLockPeriod(lockTarget)}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {dt.confirmLock}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
