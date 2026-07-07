import React from 'react';
import { FileSpreadsheet, FileText, File } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface BankAccountOption {
  id: string;
  accountName: string;
  bankName: string;
  accountNo: string | null;
}

export interface ImportStatement {
  id: string;
  bankAccountId: string;
  bankAccount: { id: string; accountName: string; bankName: string };
  startDate: string;
  endDate: string;
  openingBalance: number;
  closingBalance: number;
  format: string;
  fileName: string | null;
  createdAt: string;
  transactionCount: number;
  autoCategorizedCount: number;
  autoCategorizedPercent: number;
}

export interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
  skippedNote?: string;
}

export interface ValidationResult {
  requiresApproval: boolean;
  fileName: string;
  extractedHolder: string;
  score: number;
}

export interface GlAccountData {
  id: string;
  code: string;
  name: string;
  accountType: string;
  parentId?: string | null;
}

/* ─── Constants ──────────────────────────────────────────────────────── */

export const ACCEPTED_TYPES = ['.csv', '.tsv', '.txt', '.ofx', '.qfx', '.pdf'];
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const CURRENCIES = [
  { value: 'USD', label: 'USD ($)' },
  { value: 'EUR', label: 'EUR (€)' },
  { value: 'GBP', label: 'GBP (£)' },
  { value: 'MXN', label: 'MXN ($)' },
  { value: 'CAD', label: 'CAD ($)' },
];

export const FORMAT_BADGES: { label: string; className: string }[] = [
  {
    label: 'CSV',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  {
    label: 'OFX',
    className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  },
  {
    label: 'QFX',
    className: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  },
  {
    label: 'PDF',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  },
];

/* ─── Helpers ────────────────────────────────────────────────────────── */

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'csv':
    case 'tsv':
      return <FileSpreadsheet className="size-8 text-emerald-500" />;
    case 'ofx':
    case 'qfx':
      return <FileText className="size-8 text-teal-500" />;
    case 'pdf':
      return <File className="size-8 text-red-500" />;
    default:
      return <File className="size-8 text-muted-foreground" />;
  }
}

export function getFormatBadge(format: string) {
  const config: Record<string, { className: string; label: string }> = {
    csv: {
      className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      label: 'CSV',
    },
    ofx: {
      className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
      label: 'OFX',
    },
    qfx: {
      className: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
      label: 'QFX',
    },
    pdf: {
      className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      label: 'PDF',
    },
  };
  const c = config[format] || config.csv;
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold uppercase', c.className)}>
      {c.label}
    </Badge>
  );
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
