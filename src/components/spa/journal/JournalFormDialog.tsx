'use client';

import { Plus, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLanguageStore } from '@/store/language-store';
import { AccountSelector, type GlAccountOption } from './AccountSelector';
import { BalanceIndicator } from './BalanceIndicator';
import { fmt } from './journal-utils';

export interface JournalLineData {
  id: string;
  glAccountId: string | null;
  description: string;
  debit: number;
  credit: number;
}

interface JournalFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingEntryId: string | null;
  formDate: string;
  onFormDateChange: (val: string) => void;
  formDescription: string;
  onFormDescriptionChange: (val: string) => void;
  formReference: string;
  onFormReferenceChange: (val: string) => void;
  formLines: JournalLineData[];
  accounts: GlAccountOption[];
  onAddLine: () => void;
  onRemoveLine: (lineId: string) => void;
  onUpdateLine: (lineId: string, field: keyof JournalLineData, value: unknown) => void;
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
  saving: boolean;
  onSave: (status: 'draft' | 'posted') => void;
}

export function JournalFormDialog({
  open,
  onOpenChange,
  editingEntryId,
  formDate,
  onFormDateChange,
  formDescription,
  onFormDescriptionChange,
  formReference,
  onFormReferenceChange,
  formLines,
  accounts,
  onAddLine,
  onRemoveLine,
  onUpdateLine,
  totalDebits,
  totalCredits,
  isBalanced,
  saving,
  onSave,
}: JournalFormDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        onOpenChange(val);
      }}
    >
      <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto p-0">
        <div className="p-6 space-y-4">
          <DialogHeader>
            <DialogTitle>
              {editingEntryId ? t('journal.editEntry') : t('journal.newEntry')}
            </DialogTitle>
            <DialogDescription>
              {editingEntryId ? t('journal.editEntryDesc') : t('journal.newEntryDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('journal.entryDate')}</label>
              <Input type="date" value={formDate} onChange={(e) => onFormDateChange(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('journal.entryReference')}</label>
              <Input
                placeholder="e.g. INV-001"
                value={formReference}
                onChange={(e) => onFormReferenceChange(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2 sm:col-start-1">
              <label className="text-sm font-medium">{t('journal.entryDescription')}</label>
              <Input
                placeholder={t('journal.entryDescription')}
                value={formDescription}
                onChange={(e) => onFormDescriptionChange(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[45%]">{t('journal.account')}</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t('common.description')}
                  </TableHead>
                  <TableHead className="w-[120px] text-right">{t('accounts.debit')}</TableHead>
                  <TableHead className="w-[120px] text-right">{t('accounts.credit')}</TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {formLines.map((line, idx) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <AccountSelector
                        accounts={accounts}
                        value={line.glAccountId}
                        onChange={(v) => onUpdateLine(line.id, 'glAccountId', v)}
                        placeholder={`${t('journal.selectAccount')} ${idx + 1}`}
                      />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Input
                        value={line.description}
                        onChange={(e) => onUpdateLine(line.id, 'description', e.target.value)}
                        placeholder="—"
                        className="h-9"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.debit || ''}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          onUpdateLine(line.id, 'debit', val);
                        }}
                        placeholder="0.00"
                        className="h-9 text-right font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.credit || ''}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          onUpdateLine(line.id, 'credit', val);
                        }}
                        placeholder="0.00"
                        className="h-9 text-right font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-red-600"
                        onClick={() => onRemoveLine(line.id)}
                        disabled={formLines.length <= 2}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>
                    <div className="flex items-center justify-between">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onAddLine}
                        className="h-7 text-xs"
                      >
                        <Plus className="size-3 mr-1" />
                        {t('journal.addLine')}
                      </Button>
                      <BalanceIndicator balanced={isBalanced} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {fmt(totalDebits)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {fmt(totalCredits)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => onSave('draft')}
              disabled={saving || formLines.length < 2}
            >
              {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t('journal.saveDraft')}
            </Button>
            <Button
              onClick={() => onSave('posted')}
              disabled={saving || formLines.length < 2 || !isBalanced}
            >
              {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t('journal.saveAndPost')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
