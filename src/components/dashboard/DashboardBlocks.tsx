'use client';

import React, { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Download, FileSpreadsheet, CheckCircle2, AlertCircle,
  Layers, Zap, Info, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LOCAL_TRANSLATIONS } from '@/lib/constants/financial-dashboard-translations';

// ─── PremiumCard (exact match from FinancialDashboardPage) ─────────

interface PremiumCardProps {
  title: string;
  value: string;
  trend: string;
  isUp: boolean;
  color: string;
  isSpecialColor?: boolean;
  isSpecialBalance?: boolean;
  isDrop?: boolean;
}

function PremiumCard({
  title,
  value,
  trend,
  isUp,
  color,
  isSpecialColor = false,
  isSpecialBalance = false,
  isDrop = false,
}: PremiumCardProps) {
  const isPositive = isUp;

  const themes: Record<string, string> = {
    teal: 'bg-teal-500/10 border-teal-500/20 text-teal-600 dark:text-teal-400',
    rose: 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400',
    emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
    blue: 'bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400',
    gray: 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-350',
  };

  const getDynamicColor = () => {
    if (isSpecialColor) {
      return isPositive
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-600 dark:text-rose-400';
    }
    if (isSpecialBalance) {
      return isDrop ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white';
    }
    return 'text-slate-900 dark:text-white';
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-250 dark:border-slate-800/80 p-5 rounded-2xl shadow-sm hover:border-slate-300 dark:hover:border-slate-700 transition-all duration-300 relative group overflow-hidden">
      <div className="relative z-10 flex flex-col justify-between h-full space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block truncate max-w-[120px]">
            {title}
          </span>
          {trend && (
            <div
              className={`flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider ${isPositive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600'}`}
            >
              {isPositive ? (
                <ArrowUpRight className="w-2.5 h-2.5" />
              ) : (
                <ArrowDownRight className="w-2.5 h-2.5" />
              )}
              {trend}
            </div>
          )}
        </div>

        <div>
          <div
            className={`text-lg font-bold tracking-tight font-mono tabular-nums leading-none truncate ${getDynamicColor()}`}
          >
            {value}
          </div>
          <div className="w-full h-1 bg-slate-100 dark:bg-slate-950 rounded-full overflow-hidden border border-slate-200 dark:border-slate-850 mt-3">
            <div
              className={`h-full rounded-full ${isPositive ? 'bg-emerald-500' : 'bg-rose-500'}`}
              style={{ width: '65%' }}
            ></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── KPI Cards Grid ──────────────────────────────────────────────

interface KpiCardsGridProps {
  dt: Record<string, string>;
  formatCurrency: (val: number) => string;
  stats: { revenue: number; expenses: number; netFlow: number; finalBalance: number; commissions: number };
  initialBalanceInput: number;
}

export function KpiCardsGrid({ dt, formatCurrency, stats, initialBalanceInput }: KpiCardsGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-5">
      <PremiumCard title={dt.totalIncome} value={formatCurrency(stats.revenue)} trend="+10.4%" isUp color="teal" />
      <PremiumCard title={dt.totalExpenses} value={formatCurrency(stats.expenses)} trend="+8.2%" isUp={false} color="rose" />
      <PremiumCard title={dt.netFlow} value={formatCurrency(stats.netFlow)} trend="" isUp={stats.netFlow >= 0} color="emerald" isSpecialColor />
      <PremiumCard title={dt.startingBalance} value={formatCurrency(initialBalanceInput)} trend="" isUp color="blue" />
      <PremiumCard title={dt.endingBalance} value={formatCurrency(stats.finalBalance)} trend="" isUp={stats.finalBalance >= initialBalanceInput} color="teal" isSpecialBalance isDrop={stats.finalBalance < initialBalanceInput} />
      <PremiumCard title={dt.commissions} value={formatCurrency(stats.commissions)} trend="" isUp={false} color="gray" />
    </div>
  );
}

// ─── Reconciliation Section ──────────────────────────────────────

interface ReconciliationSectionProps {
  language: string;
  totalCount: number;
  reconciledCount: number;
}

export function ReconciliationSection({ language, totalCount, reconciledCount }: ReconciliationSectionProps) {
  const unreconciled = totalCount - reconciledCount;
  const pct = totalCount > 0 ? ((reconciledCount / totalCount) * 100).toFixed(1) : '0';

  return (
    <div className="bg-gradient-to-br from-teal-500/5 to-indigo-500/5 dark:from-teal-500/10 dark:to-indigo-500/10 border border-teal-500/10 dark:border-teal-500/20 rounded-3xl p-6 shadow-sm">
      <div className="flex flex-col lg:flex-row items-center justify-between gap-6">
        <div className="space-y-2">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-teal-500" />
            {language === 'en' ? 'Operational Reconciliation Status' : 'Estado de Conciliación Operativa'}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            {language === 'en'
              ? 'Audit control of bank statement entries matched against GL Ledger.'
              : 'Control de auditoría de partidas bancarias confrontadas contra el Libro Mayor.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-6 lg:gap-12 w-full lg:w-auto">
          {/* Progreso Visual */}
          <div className="flex items-center gap-4 flex-1 lg:flex-initial min-w-[200px]">
            <div className="relative w-16 h-16 shrink-0 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                <path className="text-slate-200 dark:text-slate-800" strokeWidth="3.5" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                <path className="text-teal-500 transition-all duration-500" strokeWidth="3.5" strokeDasharray={`${pct}, 100`} strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              </svg>
              <span className="absolute text-xs font-bold text-slate-900 dark:text-white">
                {parseFloat(pct).toFixed(0)}%
              </span>
            </div>
            <div>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                {language === 'en' ? 'Reconciliation Rate' : 'Tasa de Conciliación'}
              </p>
              <p className="text-xl font-extrabold text-teal-600 dark:text-teal-400">{pct}%</p>
            </div>
          </div>

          {/* Contadores */}
          <div className="grid grid-cols-3 gap-6 lg:gap-8 flex-1">
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                {language === 'en' ? 'Total Entries' : 'Total Movimientos'}
              </p>
              <p className="text-lg font-black text-slate-950 dark:text-slate-50">{totalCount}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-teal-500" />
                {language === 'en' ? 'Reconciled' : 'Conciliados'}
              </p>
              <p className="text-lg font-black text-teal-600 dark:text-teal-400">{reconciledCount}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                {language === 'en' ? 'Pending' : 'Sin Conciliar'}
              </p>
              <p className="text-lg font-black text-rose-600 dark:text-rose-400">{unreconciled}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Alerts Section ──────────────────────────────────────────────

interface ConclusionItem {
  icon: string;
  title: string;
  text: React.ReactNode;
}

interface DashboardAlertsProps {
  dt: Record<string, string>;
  alerts: ConclusionItem[];
  structure: ConclusionItem[];
  opportunities: ConclusionItem[];
}

export function DashboardAlerts({ dt, alerts, structure, opportunities }: DashboardAlertsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Column 1: Alert Signals */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col">
        <div className="flex items-center gap-2 mb-6 pb-2 border-b border-slate-100 dark:border-slate-800/50">
          <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-600"><AlertCircle className="w-5 h-5" /></span>
          <h2 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">{dt.alertSignals}</h2>
        </div>
        <div className="flex-1 space-y-4">
          {alerts.length === 0 ? (
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 italic uppercase">{dt.noCriticalAlerts}</p>
          ) : (
            alerts.map((conc, idx) => (
              <div key={idx} className="flex gap-3 items-start p-3 bg-rose-500/5 border border-rose-500/10 rounded-xl">
                <span className="text-lg leading-none shrink-0">{conc.icon}</span>
                <div className="space-y-1">
                  <h4 className="text-xs font-extrabold text-rose-800 dark:text-rose-400 uppercase tracking-wider">{conc.title}</h4>
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-relaxed">{conc.text}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Column 2: Business Structure */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col">
        <div className="flex items-center gap-2 mb-6 pb-2 border-b border-slate-100 dark:border-slate-800/50">
          <span className="p-1.5 rounded-lg bg-teal-500/10 text-teal-600"><Layers className="w-5 h-5" /></span>
          <h2 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">{dt.businessStructure}</h2>
        </div>
        <div className="flex-1 space-y-4">
          {structure.map((conc, idx) => (
            <div key={idx} className="flex gap-3 items-start p-3 bg-teal-500/5 border border-teal-500/10 rounded-xl">
              <span className="text-lg leading-none shrink-0">{conc.icon}</span>
              <div className="space-y-1">
                <h4 className="text-xs font-extrabold text-teal-800 dark:text-teal-400 uppercase tracking-wider">{conc.title}</h4>
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-relaxed">{conc.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Column 3: Opportunities */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col">
        <div className="flex items-center gap-2 mb-6 pb-2 border-b border-slate-100 dark:border-slate-800/50">
          <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600"><Zap className="w-5 h-5" /></span>
          <h2 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">{dt.opportunities}</h2>
        </div>
        <div className="flex-1 space-y-4">
          {opportunities.map((conc, idx) => (
            <div key={idx} className="flex gap-3 items-start p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-xl">
              <span className="text-lg leading-none shrink-0">{conc.icon}</span>
              <div className="space-y-1">
                <h4 className="text-xs font-extrabold text-emerald-800 dark:text-emerald-400 uppercase tracking-wider">{conc.title}</h4>
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-relaxed">{conc.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Export Footer ───────────────────────────────────────────────

interface ExportFooterProps {
  dt: Record<string, string>;
  onExportClassified: () => void;
  onExportSummary: () => void;
  hasClassifiedData: boolean;
  hasSummaryData: boolean;
}

export function ExportFooter({ dt, onExportClassified, onExportSummary, hasClassifiedData, hasSummaryData }: ExportFooterProps) {
  return (
    <footer className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="w-5 h-5 text-teal-600" />
        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{dt.legalTaxExportModule}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onExportClassified}
          className="rounded-xl border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 gap-1.5"
          disabled={!hasClassifiedData}>
          <Download className="w-4 h-4" /> {dt.exportClassifiedCSV}
        </Button>
        <Button variant="outline" size="sm" onClick={onExportSummary}
          className="rounded-xl border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 gap-1.5"
          disabled={!hasSummaryData}>
          <Download className="w-4 h-4" /> {dt.exportMonthlySummaryCSV}
        </Button>
      </div>
    </footer>
  );
}

// ─── Help Modal ──────────────────────────────────────────────────

interface HelpModalProps {
  open: boolean;
  language: string;
  dt: Record<string, string>;
  onClose: () => void;
}

export function HelpModal({ open, language, dt, onClose }: HelpModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-200 dark:border-slate-800 max-w-2xl w-full p-8 shadow-2xl relative overflow-hidden"
      >
        <button onClick={onClose}
          className="absolute top-6 right-6 text-slate-400 hover:text-slate-600 dark:hover:text-white text-2xl font-bold"
        >&times;</button>
        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-4">{dt.requiredFileStructure}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">{dt.supportedFormatHelpDesc}</p>
        <div className="overflow-hidden border border-slate-200 dark:border-slate-800 rounded-2xl mb-6">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950 font-bold text-slate-400 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">{dt.columnHeader}</th>
                <th className="px-4 py-3">{dt.typeHeader}</th>
                <th className="px-4 py-3">{dt.descriptionHeader}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-150 dark:divide-slate-850 font-medium text-slate-700 dark:text-slate-300">
              <tr>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">fecha</td>
                <td className="px-4 py-3">{language === 'en' ? 'Text' : 'Texto'}</td>
                <td className="px-4 py-3">
                  {language === 'en'
                    ? 'Transaction date (YYYY-MM-DD, MM/DD/YYYY or DD/MM/YYYY).'
                    : 'Fecha de la transacción (YYYY-MM-DD, MM/DD/YYYY o DD/MM/YYYY).'}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">descripcion</td>
                <td className="px-4 py-3">{language === 'en' ? 'Text' : 'Texto'}</td>
                <td className="px-4 py-3">
                  {language === 'en'
                    ? 'Concept, beneficiary or detailed description of the transaction.'
                    : 'Concepto, beneficiario o descripción detallada de la transacción.'}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">monto</td>
                <td className="px-4 py-3">{language === 'en' ? 'Number' : 'Número'}</td>
                <td className="px-4 py-3">
                  {language === 'en'
                    ? 'Numeric value of the transaction (negative debits, positive credits).'
                    : 'Valor numérico de la transacción (debitos negativos, creditos positivos).'}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">tipo</td>
                <td className="px-4 py-3">{language === 'en' ? 'Text' : 'Texto'}</td>
                <td className="px-4 py-3">
                  {language === 'en'
                    ? 'Flow direction ("credit" or "debit"). Optional if amount has sign.'
                    : 'Dirección del flujo ("credito" o "debito"). Opcional si el monto tiene signo.'}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">cuenta_contable</td>
                <td className="px-4 py-3">{language === 'en' ? 'Text' : 'Texto'}</td>
                <td className="px-4 py-3">
                  {language === 'en'
                    ? 'Accounting code or associated catalog account (optional).'
                    : 'Código contable o cuenta del catálogo asociada (opcional).'}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">conciliado</td>
                <td className="px-4 py-3">{language === 'en' ? 'Boolean' : 'Booleano'}</td>
                <td className="px-4 py-3">
                  {language === 'en'
                    ? '"yes"/"no", "true"/"false" or "1"/"0" (optional, default "no").'
                    : '"si"/"no", "true"/"false" o "1"/"0" (opcional, por defecto "no").'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400 font-medium flex items-start gap-1.5">
          <Info className="w-4 h-4 shrink-0 text-teal-500" />
          {dt.supportedFormatHelpFootnote}
        </p>
      </motion.div>
    </div>
  );
}
