/* ─── Reconciliation Types ─── */

export interface BankAccountOption {
  id: string;
  accountName: string;
  bankName: string;
}

export interface StatementOption {
  id: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  closingBalance: number;
  format: string;
  fileName: string | null;
}

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  glAccountId: string | null;
  glAccount: { id: string; code: string; name: string } | null;
  matchedRule: { id: string; name: string } | null;
  reconciledAt: string | null;
  createdAt: string;
}

export interface ReconciliationSummary {
  statementBalance: number;
  bookBalance: number;
  difference: number;
  totalTransactions: number;
  reconciledCount: number;
  unreconciledCount: number;
  pendingReviewCount: number;
  depositsTotal: number;
  paymentsTotal: number;
  filteredCount: number;
}

export interface BankAccountInfo {
  id: string;
  accountName: string;
  bankName: string;
  balance: number;
  currency: string;
  glAccount: GlAccount;
}

export interface ReconPeriod {
  id: string;
  bankAccountId: string;
  userId: string;
  statementBalance: number;
  bookBalance: number;
  difference: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  transactionCount: number;
  notes: string | null;
  user?: { firstName: string; lastName: string };
}

export interface AdjustForm {
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: string;
  notes: string;
}
