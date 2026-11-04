'use client';

import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import type { StatementOption, Transaction } from '@/lib/types/reconciliation';
import { useLanguageStore } from '@/store/language-store';

// Statement dates are calendar dates in UTC, independent of the browser timezone.
export function formatStatementDate(value: string, language: string) {
  return new Intl.DateTimeFormat(language === 'es' ? 'es-ES' : 'en-US', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(value));
}

export function BalanceCutoff({ date, showTime = false }: { date?: string; showTime?: boolean }) {
  const { t, language } = useLanguageStore();
  const caption = date ? formatStatementDate(date, language) : t('reconciliation.report.noCutoff');
  return (
    <p className="text-xs text-muted-foreground mt-1">
      {t('reconciliation.report.cutoff', { date: caption })}
      {date && showTime && ` · ${new Date(date).toISOString().slice(11, 23)} UTC`}
    </p>
  );
}

export function PreparationContext({ statements, transactions, totalTransactions, currency }: {
  statements: StatementOption[];
  transactions: Transaction[];
  totalTransactions: number;
  currency: string;
}) {
  const { t, language } = useLanguageStore();
  const ordered = [...statements].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const first = ordered[0];
  const last = [...ordered].sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
  const unclassified = transactions.filter(tx => tx.glAccountId === null).length;
  // Older/incomplete responses cannot establish that a transaction has no journal link.
  const linksKnown = transactions.every(tx => tx.journalEntryId !== undefined && tx.journalLineId !== undefined);
  const unposted = transactions.filter(tx => tx.journalEntryId === null && tx.journalLineId === null).length;

  return (
    <section aria-labelledby="preparation-title">
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="preparation-title" className="text-sm font-semibold">{t('reconciliation.report.title')}</h3>
            <span className="text-xs text-muted-foreground">{currency}</span>
          </div>
          {first && last ? (
            <p className="font-medium">
              {t('reconciliation.report.statementPeriod')}: {formatStatementDate(first.startDate, language)} — {formatStatementDate(last.endDate, language)}
            </p>
          ) : <p className="text-sm">{t('reconciliation.report.noStatements')}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {first && <p>{t('reconciliation.report.opening')}: <strong>{formatCurrency(Number(first.openingBalance))}</strong></p>}
            <p>{t('reconciliation.report.statementCount', { count: statements.length })}</p>
            <p>{t('reconciliation.report.importedCount', { count: totalTransactions })}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('reconciliation.report.importDateHelp')}</p>
          <div className="border-t pt-2 text-sm space-y-1">
            <p className="font-medium">{t('reconciliation.report.listScope', { count: transactions.length })}</p>
            <p>{t('reconciliation.report.unclassified', { count: unclassified })}{linksKnown && ` · ${t('reconciliation.report.unposted', { count: unposted })}`}</p>
            <p className="text-xs text-muted-foreground">{t('reconciliation.report.reviewHelp')}</p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
