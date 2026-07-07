'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Download,
  FileSpreadsheet,
  FileText,
  BarChart3,
  ArrowLeftRight,
  Database,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { formatDate } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

/* ─── Types ───────────────────────────────────────────────────── */

interface RecentExport {
  id: string;
  type: string;
  format: string;
  createdAt: string;
}

interface BankAccount {
  id: string;
  accountName: string;
  bankName: string;
}

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Export Type Config ──────────────────────────────────────── */

interface ExportOption {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: string;
  descKey: string;
  hasDateRange: boolean;
  hasAsOfDate: boolean;
  hasBankAccount: boolean;
  color: string;
}

const exportOptions: ExportOption[] = [
  {
    key: 'trial_balance',
    icon: BarChart3,
    titleKey: 'exportData.trialBalance',
    descKey: 'exportData.trialBalanceDesc',
    hasDateRange: false,
    hasAsOfDate: true,
    hasBankAccount: false,
    color: 'text-teal-600 dark:text-teal-400',
  },
  {
    key: 'general_ledger',
    icon: BookOpenIcon,
    titleKey: 'exportData.generalLedger',
    descKey: 'exportData.generalLedgerDesc',
    hasDateRange: true,
    hasAsOfDate: false,
    hasBankAccount: false,
    color: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    key: 'transactions',
    icon: FileText,
    titleKey: 'exportData.transactionDetail',
    descKey: 'exportData.transactionDetailDesc',
    hasDateRange: true,
    hasAsOfDate: false,
    hasBankAccount: false,
    color: 'text-amber-600 dark:text-amber-400',
  },
  {
    key: 'reconciliation',
    icon: ArrowLeftRight,
    titleKey: 'exportData.reconciliationReport',
    descKey: 'exportData.reconciliationReportDesc',
    hasDateRange: false,
    hasAsOfDate: false,
    hasBankAccount: true,
    color: 'text-violet-600 dark:text-violet-400',
  },
  {
    key: 'all_data',
    icon: Database,
    titleKey: 'exportData.allData',
    descKey: 'exportData.allDataDesc',
    hasDateRange: false,
    hasAsOfDate: false,
    hasBankAccount: false,
    color: 'text-rose-600 dark:text-rose-400',
  },
];

function BookOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

/* ─── Export Page ─────────────────────────────────────────────── */

export function ExportPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Common state
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [recentExports, setRecentExports] = useState<RecentExport[]>([]);

  // Per-export settings (stored in a map keyed by export key)
  const [formats, setFormats] = useState<Record<string, string>>({});
  const [startDates, setStartDates] = useState<Record<string, string>>({});
  const [endDates, setEndDates] = useState<Record<string, string>>({});
  const [asOfDates, setAsOfDates] = useState<Record<string, string>>({});
  const [bankAccountIds, setBankAccountIds] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<Record<string, boolean>>({});

  // Initialize defaults
  useEffect(() => {
    const defaults: Record<string, string> = {};
    const sd: Record<string, string> = {};
    const ed: Record<string, string> = {};
    const aod: Record<string, string> = {};
    exportOptions.forEach((opt) => {
      defaults[opt.key] = 'csv';
      sd[opt.key] = thirtyDaysAgo;
      ed[opt.key] = today;
      aod[opt.key] = today;
    });
    setFormats(defaults);
    setStartDates(sd);
    setEndDates(ed);
    setAsOfDates(aod);
  }, []);  

  // Fetch bank accounts for reconciliation export
  useEffect(() => {
    if (!activeCompany?.id) return;
    fetch(`/api/dashboard?companyId=${activeCompany.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((dash) => {
        if (dash?.bankAccounts) setBankAccounts(dash.bankAccounts);
      })
      .catch(() => {});
  }, [activeCompany?.id]);

  function startExport(key: string) {
    if (!activeCompany?.id) return;

    const format = formats[key] || 'csv';
    let url = '';

    if (key === 'all_data') {
      // Export chart of accounts as CSV
      url = `/api/export/csv?type=chart_of_accounts&companyId=${activeCompany.id}`;
    } else {
      const base = format === 'csv' ? '/api/export/csv' : '/api/export/pdf';
      const params = new URLSearchParams({
        type: key,
        companyId: activeCompany.id,
      });
      if (startDates[key]) params.set('startDate', startDates[key]);
      if (endDates[key]) params.set('endDate', endDates[key]);
      if (asOfDates[key]) params.set('asOfDate', asOfDates[key]);
      if (bankAccountIds[key]) params.set('bankAccountId', bankAccountIds[key]);
      url = `${base}?${params.toString()}`;
    }

    setExporting((prev) => ({ ...prev, [key]: true }));
    window.open(url, '_blank');

    // Add to recent exports
    const newExport: RecentExport = {
      id: Date.now().toString(),
      type: key,
      format,
      createdAt: new Date().toISOString(),
    };
    setRecentExports((prev) => [newExport, ...prev.slice(0, 4)]);
    setTimeout(() => {
      setExporting((prev) => ({ ...prev, [key]: false }));
    }, 2000);
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-bold tracking-tight">{t('exportData.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('exportData.subtitle')}</p>
      </motion.div>

      {/* Export Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {exportOptions.map((opt) => (
          <motion.div key={opt.key} variants={itemVariants}>
            <Card className="h-full flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`flex size-10 items-center justify-center rounded-lg bg-muted ${opt.color}`}
                  >
                    <opt.icon className="size-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base">{t(opt.titleKey)}</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">{t(opt.descKey)}</p>

                {/* Format selector */}
                <div className="flex items-center gap-2">
                  <Label className="text-xs whitespace-nowrap">{t('exportData.format')}</Label>
                  <div className="flex rounded-md border">
                    <button
                      onClick={() => setFormats((prev) => ({ ...prev, [opt.key]: 'csv' }))}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors rounded-l-md ${
                        formats[opt.key] === 'csv'
                          ? 'bg-teal-600 text-white dark:bg-teal-500'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      CSV
                    </button>
                    <button
                      onClick={() => setFormats((prev) => ({ ...prev, [opt.key]: 'pdf' }))}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors rounded-r-md ${
                        formats[opt.key] === 'pdf'
                          ? 'bg-teal-600 text-white dark:bg-teal-500'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      PDF
                    </button>
                  </div>
                </div>

                {/* Date range filter */}
                {opt.hasDateRange && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('exportData.startDate')}</Label>
                      <Input
                        type="date"
                        value={startDates[opt.key] || ''}
                        onChange={(e) =>
                          setStartDates((prev) => ({ ...prev, [opt.key]: e.target.value }))
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('exportData.endDate')}</Label>
                      <Input
                        type="date"
                        value={endDates[opt.key] || ''}
                        onChange={(e) =>
                          setEndDates((prev) => ({ ...prev, [opt.key]: e.target.value }))
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                )}

                {/* As-of date filter */}
                {opt.hasAsOfDate && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('exportData.asOf')}</Label>
                    <Input
                      type="date"
                      value={asOfDates[opt.key] || ''}
                      onChange={(e) =>
                        setAsOfDates((prev) => ({ ...prev, [opt.key]: e.target.value }))
                      }
                      className="h-8 text-xs"
                    />
                  </div>
                )}

                {/* Bank account filter */}
                {opt.hasBankAccount && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('exportData.selectBankAccount')}</Label>
                    <Select
                      value={bankAccountIds[opt.key] || ''}
                      onValueChange={(v) =>
                        setBankAccountIds((prev) => ({ ...prev, [opt.key]: v }))
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder={t('exportData.selectBankAccount')} />
                      </SelectTrigger>
                      <SelectContent>
                        {bankAccounts.map((ba) => (
                          <SelectItem key={ba.id} value={ba.id}>
                            {ba.accountName} — {ba.bankName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Export Button */}
                <div className="mt-auto pt-2">
                  <Button
                    className="w-full"
                    onClick={() => startExport(opt.key)}
                    disabled={
                      exporting[opt.key] || (opt.hasBankAccount && !bankAccountIds[opt.key])
                    }
                  >
                    {exporting[opt.key] ? (
                      <>
                        <Download className="size-4 mr-1 animate-pulse" />
                        {t('exportData.downloading')}
                      </>
                    ) : (
                      <>
                        <Download className="size-4 mr-1" />
                        {t('exportData.export')}
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Recent Exports */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />
              {t('exportData.recentExports')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentExports.length > 0 ? (
              <div className="space-y-2">
                {recentExports.map((exp) => (
                  <div
                    key={exp.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="size-4 text-emerald-500" />
                      <div>
                        <p className="text-sm font-medium">
                          {exportOptions.find((o) => o.key === exp.type)
                            ? t(exportOptions.find((o) => o.key === exp.type)!.titleKey)
                            : exp.type}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatDate(exp.createdAt)}</p>
                      </div>
                    </div>
                    <Badge variant="secondary" className="uppercase text-xs">
                      {exp.format}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t('exportData.noRecentExports')}
              </p>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
