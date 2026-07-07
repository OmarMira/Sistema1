'use client';

import { formatCurrency } from '@/lib/format';
import { useLanguageStore } from '@/store/language-store';

/* ─── Types ───────────────────────────────────────────────────── */

export interface MovementSummary {
  totalDebits: number;
  totalCredits: number;
  netMovement: number;
  transactionCount: number;
}

export interface ByAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  debits: number;
  credits: number;
  net: number;
}

export interface ByType {
  type: string;
  debits: number;
  credits: number;
  net: number;
}

export interface RecentMovement {
  id: string;
  date: string;
  description: string;
  debit: number;
  credit: number;
  account: string;
  reference: string;
}

export interface MovementSummaryResponse {
  summary: MovementSummary;
  byAccount: ByAccount[];
  byType: ByType[];
  recentMovements: RecentMovement[];
}

export interface GlAccount {
  id: string;
  code: string;
  name: string;
}

/* ─── Animation Variants ──────────────────────────────────────── */

export const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};

export const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Chart Colors ────────────────────────────────────────────── */

export const TYPE_COLORS: Record<string, { debit: string; credit: string }> = {
  asset: { debit: '#0891b2', credit: '#06b6d4' },
  liability: { debit: '#d97706', credit: '#f59e0b' },
  equity: { debit: '#7c3aed', credit: '#8b5cf6' },
  revenue: { debit: '#059669', credit: '#10b981' },
  expense: { debit: '#dc2626', credit: '#ef4444' },
};

export const TYPE_CHART_COLORS = ['#0891b2', '#d97706', '#7c3aed', '#059669', '#dc2626'];

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

/* ─── Custom Tooltip for Chart ────────────────────────────────── */

export function CustomChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const t = useLanguageStore.getState().t;
  return (
    <div className="rounded-lg border bg-background p-3 shadow-md">
      <p className="text-sm font-semibold mb-1">{label}</p>
      {payload.map((entry, index) => (
        <p key={index} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {formatCurrency(entry.value)}
        </p>
      ))}
    </div>
  );
}
