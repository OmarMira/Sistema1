'use client';

import { motion } from 'framer-motion';
import { BarChart3, FileText, ArrowLeftRight } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TrialBalanceTab } from '@/components/reports/TrialBalanceTab';
import { TransactionListingTab } from '@/components/reports/TransactionListingTab';
import { ReconciliationTab } from '@/components/reports/ReconciliationTab';
import { containerVariants, itemVariants } from '@/lib/types/reports';

export function ReportsPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-6">
      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('reports.title')}</h1>
        </div>
      </motion.div>

      <Tabs defaultValue="trial-balance" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 lg:w-auto lg:inline-grid lg:grid-cols-3">
          <TabsTrigger value="trial-balance" className="gap-1.5">
            <BarChart3 className="size-4" />
            <span className="hidden sm:inline">{t('reports.trialBalance')}</span>
          </TabsTrigger>
          <TabsTrigger value="transactions" className="gap-1.5">
            <FileText className="size-4" />
            <span className="hidden sm:inline">{t('reports.transactionListing')}</span>
          </TabsTrigger>
          <TabsTrigger value="reconciliation" className="gap-1.5">
            <ArrowLeftRight className="size-4" />
            <span className="hidden sm:inline">{t('reports.reconciliationSummary')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="trial-balance">
          <TrialBalanceTab companyId={activeCompany?.id} />
        </TabsContent>
        <TabsContent value="transactions">
          <TransactionListingTab companyId={activeCompany?.id} />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationTab companyId={activeCompany?.id} />
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}
