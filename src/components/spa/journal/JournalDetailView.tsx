'use client';

import { ArrowLeft, Pencil, SendHorizontal, Ban, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import type { JournalEntry, JournalEntryLine } from '../JournalPage';
import { StatusBadge } from './StatusBadge';
import { BalanceIndicator } from './BalanceIndicator';
import { fmt, formatDate } from './journal-utils';

interface JournalDetailViewProps {
  entry: JournalEntry;
  onBack: () => void;
  onEdit: (entry: JournalEntry) => void;
  onPost: (id: string) => void;
  onVoid: (id: string) => void;
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
}

export function JournalDetailView({
  entry,
  onBack,
  onEdit,
  onPost,
  onVoid,
  totalDebits,
  totalCredits,
  balanced,
}: JournalDetailViewProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4 mr-1" />
          {t('common.back')}
        </Button>
      </div>

      <div className="rounded-lg border bg-card p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{entry.description}</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CalendarDays className="size-3.5" />
                {formatDate(entry.date)}
              </span>
              {entry.reference && (
                <span>
                  {t('common.reference')}: {entry.reference}
                </span>
              )}
              <StatusBadge status={entry.status} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {entry.status === 'draft' && (
              <>
                <Button variant="outline" size="sm" onClick={() => onEdit(entry)}>
                  <Pencil className="size-3.5 mr-1" />
                  {t('common.edit')}
                </Button>
                <Button size="sm" onClick={() => onPost(entry.id)}>
                  <SendHorizontal className="size-3.5 mr-1" />
                  {t('journal.postEntry')}
                </Button>
              </>
            )}
            {entry.status === 'posted' && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onVoid(entry.id)}
              >
                <Ban className="size-3.5 mr-1" />
                {t('journal.voidEntry')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('accounts.accountCode')}</TableHead>
              <TableHead>{t('accounts.accountName')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('common.description')}</TableHead>
              <TableHead className="text-right">{t('accounts.debit')}</TableHead>
              <TableHead className="text-right">{t('accounts.credit')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.lines.map((line: JournalEntryLine) => (
              <TableRow key={line.id}>
                <TableCell>
                  <span className="font-mono text-xs text-teal-600 dark:text-teal-400">
                    {line.glAccount.code}
                  </span>
                </TableCell>
                <TableCell className="font-medium">{line.glAccount.name}</TableCell>
                <TableCell className="hidden sm:table-cell text-muted-foreground">
                  {line.description || '—'}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {line.debit > 0 ? fmt(line.debit) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {line.credit > 0 ? fmt(line.credit) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>
                <BalanceIndicator balanced={balanced} />
              </TableCell>
              <TableCell className="text-right font-mono font-semibold">
                {fmt(totalDebits)}
              </TableCell>
              <TableCell className="text-right font-mono font-semibold">
                {fmt(totalCredits)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
