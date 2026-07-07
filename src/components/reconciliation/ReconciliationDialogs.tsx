'use client';

import { AlertTriangle, Check, FileText, History as HistoryIcon, Loader2, Play, PlusCircle, Undo2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { useLanguageStore } from '@/store/language-store';
import type { Transaction, ReconPeriod, AdjustForm } from '@/lib/types/reconciliation';

/* ─── Split Transaction Dialog ─── */

interface SplitTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  splittingTx: Transaction | null;
  currentSplits: { glAccountId: string; amount: number; description: string }[];
  setCurrentSplits: (splits: { glAccountId: string; amount: number; description: string }[]) => void;
  accounts: GlAccountOption[];
  onSave: () => void;
}

export function SplitTransactionDialog({
  open,
  onOpenChange,
  splittingTx,
  currentSplits,
  setCurrentSplits,
  accounts,
  onSave,
}: SplitTransactionDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('reconciliation.splitTransaction')}</DialogTitle>
          <DialogDescription>
            {t('reconciliation.splitTransactionDesc').replace(
              '{amount}',
              formatCurrency(splittingTx?.amount || 0),
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="max-h-[300px] overflow-y-auto space-y-3 pr-2">
            {currentSplits.map((split, index) => (
              <div
                key={index}
                className="flex items-start gap-3 p-3 rounded-xl border bg-muted/30"
              >
                <div className="flex-1 space-y-2">
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground">
                    Cuenta Contable
                  </Label>
                  <AccountSelector
                    accounts={accounts}
                    value={split.glAccountId}
                    onChange={(id) => {
                      const next = [...currentSplits];
                      next[index].glAccountId = id || '';
                      setCurrentSplits(next);
                    }}
                  />
                </div>
                <div className="w-32 space-y-2">
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground">
                    Monto
                  </Label>
                  <Input
                    type="number"
                    value={split.amount}
                    onChange={(e) => {
                      const next = [...currentSplits];
                      next[index].amount = parseFloat(e.target.value) || 0;
                      setCurrentSplits(next);
                    }}
                    className="h-10 text-right font-mono"
                  />
                </div>
                <div className="flex-1 space-y-2">
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground">
                    Descripción
                  </Label>
                  <Input
                    value={split.description}
                    onChange={(e) => {
                      const next = [...currentSplits];
                      next[index].description = e.target.value;
                      setCurrentSplits(next);
                    }}
                    className="h-10"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mt-6 text-rose-500 hover:text-rose-600 hover:bg-rose-50"
                  onClick={() => {
                    if (currentSplits.length > 1) {
                      setCurrentSplits(currentSplits.filter((_, i) => i !== index));
                    }
                  }}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2 border-dashed"
            onClick={() => {
              setCurrentSplits([
                ...currentSplits,
                { glAccountId: '', amount: 0, description: splittingTx?.description || '' },
              ]);
            }}
          >
            <PlusCircle className="size-4" />
            {t('reconciliation.addSplit')}
          </Button>

          <div className="flex items-center justify-between p-4 rounded-xl bg-primary/5 border border-primary/10">
            <div className="text-sm">
              <p className="text-muted-foreground">{t('reconciliation.totalSplit')}</p>
              <p className="font-bold text-lg">
                {formatCurrency(currentSplits.reduce((sum, s) => sum + s.amount, 0))}
              </p>
            </div>
            <div className="text-right text-sm">
              <p className="text-muted-foreground">{t('reconciliation.pendingDifference')}</p>
              <p
                className={cn(
                  'font-bold text-lg',
                  Math.abs(
                    Math.abs(splittingTx?.amount || 0) -
                      currentSplits.reduce((sum, s) => sum + s.amount, 0),
                  ) < 0.01
                    ? 'text-emerald-600'
                    : 'text-rose-600',
                )}
              >
                {formatCurrency(
                  Math.abs(splittingTx?.amount || 0) -
                    currentSplits.reduce((sum, s) => sum + s.amount, 0),
                )}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={onSave}
            disabled={
              Math.abs(
                Math.abs(splittingTx?.amount || 0) -
                  currentSplits.reduce((sum, s) => sum + s.amount, 0),
              ) > 0.01
            }
          >
            {t('reconciliation.confirmSplit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Auto-Match Dialog ─── */

interface AutoMatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autoMatching: boolean;
  autoMatchResult: {
    matched: number;
    total: number;
    matchedByRule: number;
    matchedByAmount: number;
  } | null;
  createJournalEntries: boolean;
  onConfirm: () => void;
}

export function AutoMatchDialog({
  open,
  onOpenChange,
  autoMatching,
  autoMatchResult,
  createJournalEntries,
  onConfirm,
}: AutoMatchDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('reconciliation.autoMatchTitle')}</DialogTitle>
          <DialogDescription>{t('reconciliation.autoMatchDesc')}</DialogDescription>
        </DialogHeader>
        {createJournalEntries && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="size-4 text-amber-600" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('reconciliation.createJournalEntriesDesc')}
            </p>
          </div>
        )}
        {autoMatchResult ? (
          <div className="space-y-4">
            <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                  {autoMatchResult.matched}
                </p>
                <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">
                  {t('reconciliation.transactionsMatched')}
                </p>
                <div className="flex justify-center gap-4 mt-2">
                  <span className="text-xs text-muted-foreground">
                    {t('reconciliation.matchedByRule')}: {autoMatchResult.matchedByRule}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('reconciliation.matchedByAmount')}: {autoMatchResult.matchedByAmount}
                  </span>
                </div>
                {autoMatchResult.total > autoMatchResult.matched && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {autoMatchResult.total - autoMatchResult.matched}{' '}
                    {t('reconciliation.stillUnmatched')}
                  </p>
                )}
              </CardContent>
            </Card>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('common.confirm')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={onConfirm} disabled={autoMatching} className="gap-2">
              {autoMatching && <Loader2 className="size-4 animate-spin" />}
              <Play className="size-4" />
              {t('reconciliation.autoMatch')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Reconcile Confirmation Dialog ─── */

interface ReconcileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconciling: boolean;
  reconcileResult: number | null;
  selectedCount: number;
  createJournalEntries: boolean;
  onConfirm: () => void;
}

export function ReconcileDialog({
  open,
  onOpenChange,
  reconciling,
  reconcileResult,
  selectedCount,
  createJournalEntries,
  onConfirm,
}: ReconcileDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('reconciliation.confirmReconcile')}</DialogTitle>
          <DialogDescription>
            {t('reconciliation.confirmReconcileDesc').replace(
              '{count}',
              String(selectedCount),
            )}
          </DialogDescription>
        </DialogHeader>
        {createJournalEntries && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="size-4 text-amber-600" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('reconciliation.createJournalEntriesDesc')}
            </p>
          </div>
        )}
        {reconcileResult !== null ? (
          <div className="space-y-4">
            <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                  {reconcileResult}
                </p>
                <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">
                  {t('reconciliation.transactionsReconciled')}
                </p>
              </CardContent>
            </Card>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('common.confirm')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={onConfirm} disabled={reconciling} className="gap-2">
              {reconciling && <Loader2 className="size-4 animate-spin" />}
              <Check className="size-4" />
              {t('reconciliation.reconcileSelected')} ({selectedCount})
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Unreconcile Confirmation Dialog ─── */

interface UnreconcileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unreconciling: boolean;
  unreconcileResult: number | null;
  selectedCount: number;
  onConfirm: () => void;
}

export function UnreconcileDialog({
  open,
  onOpenChange,
  unreconciling,
  unreconcileResult,
  selectedCount,
  onConfirm,
}: UnreconcileDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('reconciliation.confirmUnreconcile')}</DialogTitle>
          <DialogDescription>
            {t('reconciliation.confirmUnreconcileDesc').replace(
              '{count}',
              String(selectedCount),
            )}
          </DialogDescription>
        </DialogHeader>
        {unreconcileResult !== null ? (
          <div className="space-y-4">
            <Card className="bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800">
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                  {unreconcileResult}
                </p>
                <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
                  {t('reconciliation.transactionsUnreconciled')}
                </p>
              </CardContent>
            </Card>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {t('common.confirm')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={onConfirm}
              disabled={unreconciling}
              className="gap-2"
              variant="destructive"
            >
              {unreconciling && <Loader2 className="size-4 animate-spin" />}
              <Undo2 className="size-4" />
              {t('reconciliation.unreconcileSelected')} ({selectedCount})
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Adjustment Dialog ─── */

interface AdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adjusting: boolean;
  adjustForm: AdjustForm;
  onFormChange: (form: AdjustForm) => void;
  accounts: GlAccountOption[];
  onSave: () => void;
}

export function AdjustmentDialog({
  open,
  onOpenChange,
  adjusting,
  adjustForm,
  onFormChange,
  accounts,
  onSave,
}: AdjustmentDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusCircle className="size-5" />
            {t('reconciliation.adjustmentTitle')}
          </DialogTitle>
          <DialogDescription>{t('reconciliation.adjustmentDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">{t('reconciliation.adjustmentDate')}</Label>
              <Input
                type="date"
                value={adjustForm.date}
                onChange={(e) => onFormChange({ ...adjustForm, date: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">{t('reconciliation.adjustmentAmount')}</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={adjustForm.amount}
                onChange={(e) => onFormChange({ ...adjustForm, amount: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">{t('reconciliation.adjustmentDescription')}</Label>
            <Input
              placeholder="e.g., Bank fee adjustment"
              value={adjustForm.description}
              onChange={(e) => onFormChange({ ...adjustForm, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">{t('reconciliation.adjustmentDebitAccount')}</Label>
              <AccountSelector
                accounts={accounts}
                value={adjustForm.debitAccountId}
                onChange={(id) => onFormChange({ ...adjustForm, debitAccountId: id ?? '' })}
                placeholder="Select debit account"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">{t('reconciliation.adjustmentCreditAccount')}</Label>
              <AccountSelector
                accounts={accounts}
                value={adjustForm.creditAccountId}
                onChange={(id) => onFormChange({ ...adjustForm, creditAccountId: id ?? '' })}
                placeholder="Select credit account"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">{t('reconciliation.adjustmentNotes')}</Label>
            <Textarea
              placeholder={t('reconciliation.adjustmentNotes')}
              value={adjustForm.notes}
              onChange={(e) => onFormChange({ ...adjustForm, notes: e.target.value })}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={onSave}
            disabled={
              adjusting ||
              !adjustForm.description ||
              !adjustForm.debitAccountId ||
              !adjustForm.creditAccountId ||
              !adjustForm.amount
            }
            className="gap-2"
          >
            {adjusting && <Loader2 className="size-4 animate-spin" />}
            <PlusCircle className="size-4" />
            {t('reconciliation.createAdjustment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── History Dialog ─── */

interface HistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  historyPeriods: ReconPeriod[];
}

export function HistoryDialog({
  open,
  onOpenChange,
  historyPeriods,
}: HistoryDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="size-5" />
            {t('reconciliation.historyTitle')}
          </DialogTitle>
        </DialogHeader>
        {historyPeriods.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="size-12 text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground">{t('reconciliation.noHistory')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {historyPeriods.map((p) => (
              <div key={p.id} className="p-4 rounded-lg border space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        p.status === 'completed'
                          ? 'default'
                          : p.status === 'open'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {p.status === 'completed'
                        ? t('reconciliation.periodCompletedStatus')
                        : p.status === 'open'
                          ? t('reconciliation.periodOpen')
                          : t('reconciliation.periodCancelled')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {t('reconciliation.startedBy')}:{' '}
                      {p.user ? `${p.user.firstName} ${p.user.lastName}` : '—'}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDate(p.startedAt)}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Stmt: </span>
                    <span className="font-mono">{formatCurrency(p.statementBalance)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Book: </span>
                    <span className="font-mono">{formatCurrency(p.bookBalance)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Diff: </span>
                    <span
                      className={cn(
                        'font-mono',
                        Math.abs(p.difference) < 0.005 ? 'text-emerald-600' : 'text-rose-600',
                      )}
                    >
                      {formatCurrency(p.difference)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {p.transactionCount} {t('reconciliation.transactionsReconciled')}
                  </span>
                  {p.completedAt && <span>{formatDate(p.completedAt)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
