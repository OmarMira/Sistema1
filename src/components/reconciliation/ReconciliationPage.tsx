'use client';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert, Link2 } from 'lucide-react';
import { useReconciliationUI } from '@/hooks/use-reconciliation-ui';
import { Skeleton } from '@/components/ui/skeleton';
import { DualPaneView } from './DualPaneView';
import { useLanguageStore } from '@/store/language-store';

export function ReconciliationPage({
  companyId,
  bankAccountId,
}: {
  companyId: string;
  bankAccountId: string;
}) {
  const t = useLanguageStore((s) => s.t);
  const {
    config,
    data,
    isLoading,
    selectedBankTx,
    selectedJournalEntry,
    setSelectedBankTx,
    setSelectedJournalEntry,
    linkMutation,
    canExecuteAction,
  } = useReconciliationUI(companyId, bankAccountId);

  if (isLoading)
    return (
      <div className="p-6">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (!config || !data)
    return <div className="p-6 text-destructive">{t('reconciliation.errorLoadingData')}</div>;

  const { layout, ui } = config;
  const splitWidth = `${layout.splitViewRatio * 100}%`;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4 p-4">
      {/* Disclaimer Obligatorio */}
      <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <ShieldAlert className="size-4 mt-0.5" />
        <p>{ui.disclaimerText}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>{t('reconciliation.title')}</CardTitle>
              <CardDescription>
                {t('reconciliation.bankBalance', {
                  name: data.bankAccount?.accountName ?? '',
                  balance: data.summary?.statementBalance.toFixed(2) ?? '0.00',
                })}
              </CardDescription>
            </div>
            <Badge variant={data.openPeriod ? 'default' : 'secondary'}>
              {data.openPeriod ? t('reconciliation.openPeriod') : t('reconciliation.closedPeriod')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <DualPaneView
            data={data}
            config={config}
            selectedBankTx={selectedBankTx}
            setSelectedBankTx={setSelectedBankTx}
            selectedJournalEntry={selectedJournalEntry}
            setSelectedJournalEntry={setSelectedJournalEntry}
            splitWidth={splitWidth}
          />
        </CardContent>
      </Card>

      {/* Toolbar de Acciones */}
      <div className="flex justify-between items-center p-2 bg-muted/30 rounded-md">
        <span className="text-sm text-muted-foreground">
          {t('reconciliation.selectedStatus', {
            txCount: selectedBankTx.length,
            jeCount: selectedJournalEntry ? '1' : '0',
          })}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!canExecuteAction('link') || linkMutation.isPending}
            onClick={() =>
              linkMutation.mutate({
                bankTxIds: selectedBankTx,
                journalEntryId: selectedJournalEntry!,
              })
            }
          >
            <Link2 className="size-4 mr-2" />{' '}
            {linkMutation.isPending ? t('reconciliation.linking') : t('reconciliation.linkButton')}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
