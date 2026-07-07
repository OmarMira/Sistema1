// ─── Reports: Shared Types ──────────────────────────────────────

export interface TrialBalanceAccount {
  code: string;
  name: string;
  accountType: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface TrialBalanceResponse {
  accounts: TrialBalanceAccount[];
  totalDebits: number;
  totalCredits: number;
  asOfDate: string;
}

export interface TransactionEntry {
  id: string;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  lines: {
    id: string;
    glAccountId: string;
    accountCode: string;
    accountName: string;
    accountType: string;
    description: string | null;
    debit: number;
    credit: number;
  }[];
  _totalDebit: number;
  _totalCredit: number;
}

export interface TransactionResponse {
  data: TransactionEntry[];
  pagination: { page: number; limit: number; totalCount: number; totalPages: number };
}

export interface ReconTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  glAccount: { id: string; code: string; name: string } | null;
}

export interface ReconciliationResponse {
  bankAccount: {
    id: string;
    accountName: string;
    bankName: string;
    balance: number;
    currency: string;
  };
  summary: {
    totalTransactions: number;
    reconciledCount: number;
    unreconciledCount: number;
    reconciledTotal: number;
    unreconciledTotal: number;
    reconciledPercentage: number;
  };
  reconciledTransactions: ReconTransaction[];
  unreconciledTransactions: ReconTransaction[];
}

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
}

export interface BankAccount {
  id: string;
  accountName: string;
  bankName: string;
}

// ─── Shared Animations ──────────────────────────────────────────

import type { Variants } from 'framer-motion';

export const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

// ─── Shared Helpers ─────────────────────────────────────────────

export function accountTypeColor(type: string): string {
  switch (type) {
    case 'asset':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400';
    case 'liability':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'equity':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400';
    case 'revenue':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
    case 'expense':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400';
  }
}
