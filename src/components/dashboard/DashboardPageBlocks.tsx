'use client';

import { motion } from 'framer-motion';
import {
  TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Wallet, CheckCircle2, XCircle,
  FileText, Upload, BarChart3, Landmark, Info, Building2, Users, Database, ShieldAlert, ArrowLeft, Activity,
} from 'lucide-react';
import {
  Bar, BarChart, Area, AreaChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import { formatCurrency, formatDate } from '@/lib/format';

// ─── Variants (shared) ───

export const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
} as const;

export const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
} as const;

// ─── StatCard ───

interface StatCardProps {
  title: string;
  value: string;
  icon: React.ReactNode;
  iconBg: string;
  trend?: 'up' | 'down';
  loading?: boolean;
}

export function StatCard({ title, value, icon, iconBg, trend, loading }: StatCardProps) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="relative overflow-hidden">
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">{title}</p>
              {loading ? (
                <Skeleton className="h-8 w-28" />
              ) : (
                <p className="text-2xl font-bold tracking-tight">{value}</p>
              )}
            </div>
            <div className={`flex size-10 items-center justify-center rounded-lg ${iconBg}`}>
              {icon}
            </div>
          </div>
          {trend && (
            <div className="mt-3 flex items-center gap-1 text-xs">
              {trend === 'up' ? (
                <ArrowUpRight className="size-3.5 text-emerald-600" />
              ) : (
                <ArrowDownRight className="size-3.5 text-rose-600" />
              )}
              <span className={trend === 'up' ? 'text-emerald-600' : 'text-rose-600'}>
                {trend === 'up' ? '+' : '-'}12.5%
              </span>
              <span className="text-muted-foreground">vs last period</span>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Chart configs ───

export const balanceChartConfig: ChartConfig = {
  asset: { label: 'Assets', color: 'hsl(160, 60%, 45%)' },
  liability: { label: 'Liabilities', color: 'hsl(38, 92%, 50%)' },
  equity: { label: 'Equity', color: 'hsl(170, 60%, 41%)' },
  revenue: { label: 'Revenue', color: 'hsl(152, 69%, 38%)' },
  expense: { label: 'Expenses', color: 'hsl(350, 80%, 55%)' },
};

export const cashFlowChartConfig: ChartConfig = {
  income: { label: 'Ingresos', color: 'hsl(217, 91%, 60%)' },
  expenses: { label: 'Gastos', color: 'hsl(350, 80%, 55%)' },
};

// ─── Summary Mini Cards ───

interface DashboardData {
  totalBankBalance: number;
  reconciledCount: number;
  unreconciledCount: number;
  postedEntries: number;
}

interface SummaryMiniCardsProps {
  t: (key: string) => string;
  loading: boolean;
  data: DashboardData;
}

export function SummaryMiniCards({ t, loading, data }: SummaryMiniCardsProps) {
  return (
    <motion.div variants={itemVariants} className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <Wallet className="size-4 text-primary" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('dashboard.cashBalance')}</p>
            {loading ? (
              <Skeleton className="h-4 w-20 mt-1" />
            ) : (
              <p className="text-sm font-semibold">{formatCurrency(data.totalBankBalance)}</p>
            )}
          </div>
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-950">
            <CheckCircle2 className="size-4 text-emerald-600" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('reconciliation.reconciled')}</p>
            {loading ? (
              <Skeleton className="h-4 w-12 mt-1" />
            ) : (
              <p className="text-sm font-semibold">{data.reconciledCount}</p>
            )}
          </div>
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-950">
            <XCircle className="size-4 text-rose-600" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('reconciliation.unreconciled')}</p>
            {loading ? (
              <Skeleton className="h-4 w-12 mt-1" />
            ) : (
              <p className="text-sm font-semibold">{data.unreconciledCount}</p>
            )}
          </div>
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950">
            <FileText className="size-4 text-amber-600" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('journal.posted')}</p>
            {loading ? (
              <Skeleton className="h-4 w-12 mt-1" />
            ) : (
              <p className="text-sm font-semibold">{data.postedEntries}</p>
            )}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

// ─── Balance Chart ───

interface AccountBalance {
  accountType: string;
  balance: number;
}

function buildBalanceChartData(accountBalances: AccountBalance[]) {
  return accountBalances.map((ab) => ({
    type: ab.accountType.charAt(0).toUpperCase() + ab.accountType.slice(1),
    ...Object.fromEntries([[ab.accountType, Math.abs(ab.balance)]]),
  }));
}

interface BalanceChartProps {
  t: (key: string) => string;
  loading: boolean;
  accountBalances: AccountBalance[];
}

export function BalanceChartCard({ t, loading, accountBalances }: BalanceChartProps) {
  const chartData = buildBalanceChartData(accountBalances);

  return (
    <motion.div variants={itemVariants}>
      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.accountBalance')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : (
            <ChartContainer config={balanceChartConfig} className="h-[280px] w-full">
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="type" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="asset" fill="hsl(160, 60%, 45%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="liability" fill="hsl(38, 92%, 50%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="equity" fill="hsl(170, 60%, 41%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="revenue" fill="hsl(152, 69%, 38%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expense" fill="hsl(350, 80%, 55%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Monthly Trend Chart ───

interface MonthlyTrend {
  month: string;
  income: number;
  expenses: number;
}

interface MonthlyTrendChartProps {
  t: (key: string) => string;
  loading: boolean;
  data: MonthlyTrend[] | undefined;
}

export function MonthlyTrendChartCard({ t, loading, data }: MonthlyTrendChartProps) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="border-primary/10 shadow-xl">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-7">
          <CardTitle className="text-base font-bold">{t('dashboard.monthlyTrend')}</CardTitle>
          <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <div className="size-2 rounded-full bg-[#0071c5]" /> {t('dashboard.income')}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="size-2 rounded-full bg-[#f43f5e]" /> {t('dashboard.expenses')}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : data && data.length > 0 ? (
            <ChartContainer config={cashFlowChartConfig} className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorIncome" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0071c5" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0071c5" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorExpenses" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.1} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={10} fontWeight={600} tick={{ fill: 'hsl(var(--muted-foreground))' }} dy={10} />
                  <YAxis tickLine={false} axisLine={false} fontSize={10} fontWeight={600} tick={{ fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="income" stroke="#0071c5" strokeWidth={3} fillOpacity={1} fill="url(#colorIncome)" />
                  <Area type="monotone" dataKey="expenses" stroke="#f43f5e" strokeWidth={3} fillOpacity={1} fill="url(#colorExpenses)" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartContainer>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
              {t('common.noData') ?? 'Sin datos disponibles para el período'}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Recent Transactions Table ───

interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  glAccount: { name: string } | null;
  isReconciled: boolean;
}

interface RecentTransactionsTableProps {
  t: (key: string) => string;
  loading: boolean;
  transactions: Transaction[];
}

export function RecentTransactionsTable({ t, loading, transactions }: RecentTransactionsTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.recentEntries')}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {loading ? (
          <div className="space-y-3 px-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.date')}</TableHead>
                <TableHead>{t('common.description')}</TableHead>
                <TableHead className="text-right">{t('common.amount')}</TableHead>
                <TableHead className="text-center">{t('common.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="text-muted-foreground">{formatDate(tx.date)}</TableCell>
                  <TableCell>
                    <div>
                      <p className="font-medium">{tx.description}</p>
                      {tx.glAccount && (
                        <p className="text-xs text-muted-foreground">{tx.glAccount.name}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium">
                    <span className={tx.amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                      {formatCurrency(tx.amount)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {tx.isReconciled ? (
                      <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                        <CheckCircle2 className="size-3 mr-1" />
                        {t('reconciliation.reconciled')}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-600 border-amber-300">
                        {t('reconciliation.unreconciled')}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Bank Accounts Card ───

interface BankAccount {
  id: string;
  accountName: string;
  bankName: string;
  balance: number;
}

interface BankAccountsCardProps {
  t: (key: string) => string;
  loading: boolean;
  accounts: BankAccount[];
}

export function BankAccountsCard({ t, loading, accounts }: BankAccountsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Landmark className="size-4" />
          {t('banks.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading
          ? Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))
          : accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{account.accountName}</p>
                  <p className="text-xs text-muted-foreground">{account.bankName}</p>
                </div>
                <p className="text-sm font-semibold font-mono">{formatCurrency(account.balance)}</p>
              </div>
            ))}
      </CardContent>
    </Card>
  );
}

// ─── Quick Actions Card ───

interface QuickActionsCardProps {
  t: (key: string) => string;
  onNewEntry: () => void;
  onImportStatement: () => void;
  onRunReports: () => void;
}

export function QuickActionsCard({ t, onNewEntry, onImportStatement, onRunReports }: QuickActionsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.quickActions')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button className="w-full justify-start gap-2" onClick={onNewEntry}>
          <FileText className="size-4" />
          {t('journal.newEntry')}
        </Button>
        <Button variant="outline" className="w-full justify-start gap-2" onClick={onImportStatement}>
          <Upload className="size-4" />
          {t('banks.uploadStatement')}
        </Button>
        <Button variant="outline" className="w-full justify-start gap-2" onClick={onRunReports}>
          <BarChart3 className="size-4" />
          {t('reports.title')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Super Admin: Stat Cards Grid ────────────────────────────────

interface AdminStats {
  companiesCount: number;
  usersCount: number;
  logsCount: number;
  systemLoad: string;
}

interface AdminStatCardsProps {
  t: (key: string) => string;
  stats: AdminStats;
  loading: boolean;
  onNavigate: (view: string) => void;
}

interface AdminQuickActionsProps {
  t: (key: string) => string;
  onNavigate: (view: string) => void;
}

export function AdminStatCards({ t, stats, loading, onNavigate }: AdminStatCardsProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      <Card className="cursor-pointer hover:shadow-md hover:border-indigo-500/50 transition-all duration-200 group" onClick={() => onNavigate('admin-companies')}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{t('superAdmin.totalCompanies')}</CardTitle>
          <div className="rounded-xl bg-indigo-500/10 p-2 text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
            <Building2 className="size-5" />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-9 w-16 animate-pulse bg-muted rounded my-0.5" />
          ) : (
            <span className="text-3xl font-bold text-foreground">{stats.companiesCount}</span>
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('superAdmin.totalCompaniesDesc')}</p>
        </CardContent>
      </Card>

      <Card className="cursor-pointer hover:shadow-md hover:border-indigo-500/50 transition-all duration-200 group" onClick={() => onNavigate('admin-users')}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{t('superAdmin.globalUsers')}</CardTitle>
          <div className="rounded-xl bg-violet-500/10 p-2 text-violet-600 dark:text-violet-400 group-hover:scale-110 transition-transform">
            <Users className="size-5" />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-9 w-16 animate-pulse bg-muted rounded my-0.5" />
          ) : (
            <span className="text-3xl font-bold text-foreground">{stats.usersCount}</span>
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('superAdmin.globalUsersDesc')}</p>
        </CardContent>
      </Card>

      <Card className="cursor-pointer hover:shadow-md hover:border-indigo-500/50 transition-all duration-200 group" onClick={() => onNavigate('admin-audit-logs')}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{t('superAdmin.auditLogs')}</CardTitle>
          <div className="rounded-xl bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
            <Activity className="size-5" />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-9 w-16 animate-pulse bg-muted rounded my-0.5" />
          ) : (
            <span className="text-3xl font-bold text-foreground">{stats.logsCount}</span>
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('superAdmin.auditLogsDesc')}</p>
        </CardContent>
      </Card>

      <Card className="group">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{t('superAdmin.serverLoad')}</CardTitle>
          <div className="rounded-xl bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400 group-hover:scale-110 transition-transform">
            <Database className="size-5" />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-9 w-16 animate-pulse bg-muted rounded my-0.5" />
          ) : (
            <span className="text-3xl font-bold text-foreground">{stats.systemLoad}</span>
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('superAdmin.serverLoadDesc')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Super Admin: Quick Actions ──────────────────────────────────

interface AdminQuickActionsProps {
  t: (key: string) => string;
  onNavigate: (view: string) => void;
}

export function AdminQuickActions({ t, onNavigate }: AdminQuickActionsProps) {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      <Card className="relative overflow-hidden group hover:border-indigo-500/30 transition-colors">
        <CardHeader>
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <Building2 className="size-5 text-indigo-600" />
            {t('superAdmin.companiesCardTitle')}
          </CardTitle>
          <CardDescription>{t('superAdmin.companiesCardDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <Button variant="secondary" className="w-full justify-between" onClick={() => onNavigate('admin-companies')}>
            {t('superAdmin.manageBtn')}
            <ArrowLeft className="size-4 rotate-180" />
          </Button>
        </CardContent>
      </Card>

      <Card className="relative overflow-hidden group hover:border-violet-500/30 transition-colors">
        <CardHeader>
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <Users className="size-5 text-violet-600" />
            {t('superAdmin.usersCardTitle')}
          </CardTitle>
          <CardDescription>{t('superAdmin.usersCardDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <Button variant="secondary" className="w-full justify-between" onClick={() => onNavigate('admin-users')}>
            {t('superAdmin.manageBtn')}
            <ArrowLeft className="size-4 rotate-180" />
          </Button>
        </CardContent>
      </Card>

      <Card className="relative overflow-hidden group hover:border-emerald-500/30 transition-colors">
        <CardHeader>
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <Activity className="size-5 text-emerald-600" />
            {t('superAdmin.logsCardTitle')}
          </CardTitle>
          <CardDescription>{t('superAdmin.logsCardDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <Button variant="secondary" className="w-full justify-between" onClick={() => onNavigate('admin-audit-logs')}>
            {t('superAdmin.manageBtn')}
            <ArrowLeft className="size-4 rotate-180" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
