'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Plus,
  Landmark,
  Pencil,
  Eye,
  Trash2,
  Loader2,
  DollarSign,
  Building2,
  Hash,
  ArrowUpRight,
  CheckCircle2,
  XCircle,
  CircleDot,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { AccountSelector, type GlAccountOption } from './journal/AccountSelector';

// ─── Types ────────────────────────────────────────────────────────────

interface GlAccountInfo {
  id: string;
  code: string;
  name: string;
  accountType: string;
}

interface BankAccountData {
  id: string;
  companyId: string;
  accountName: string;
  bankName: string;
  accountNo: string | null;
  routingNo: string | null;
  glAccountId: string;
  balance: number;
  currency: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  glAccount: GlAccountInfo;
  _count: { statements: number };
}

interface BankTransactionData {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  isReconciled: boolean;
  glAccountId: string | null;
  glAccount: GlAccountInfo | null;
}

type ViewMode = 'grid' | 'detail';

// ─── Helpers ──────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCurrency(amount: number): string {
  return amount < 0 ? `-$${formatCurrency(amount)}` : `$${formatCurrency(amount)}`;
}

function maskAccountNo(accountNo: string | null): string {
  if (!accountNo) return '—';
  if (accountNo.length <= 4) return '••••';
  return '••••••••' + accountNo.slice(-4);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

const CURRENCIES = [
  { value: 'USD', label: 'USD ($)' },
  { value: 'EUR', label: 'EUR (€)' },
  { value: 'GBP', label: 'GBP (£)' },
  { value: 'MXN', label: 'MXN ($)' },
  { value: 'CAD', label: 'CAD ($)' },
];

// ─── Main Component ───────────────────────────────────────────────────

export function BanksPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  // State
  const [accounts, setAccounts] = useState<BankAccountData[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedAccount, setSelectedAccount] = useState<BankAccountData | null>(null);
  const [recentTransactions, setRecentTransactions] = useState<BankTransactionData[]>([]);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<BankAccountData | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [formAccountName, setFormAccountName] = useState('');
  const [formBankName, setFormBankName] = useState('');
  const [formAccountNo, setFormAccountNo] = useState('');
  const [formRoutingNo, setFormRoutingNo] = useState('');
  const [formGlAccountId, setFormGlAccountId] = useState<string | null>(null);
  const [formBalance, setFormBalance] = useState('');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formError, setFormError] = useState('');

  // Delete confirmation
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BankAccountData | null>(null);
  const [deleting, setDeleting] = useState(false);

  // GL accounts for dropdown
  const [assetAccounts, setAssetAccounts] = useState<GlAccountOption[]>([]);

  // ─── Fetch data ───────────────────────────────────────────────────

  async function fetchAccounts() {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/banks?companyId=${activeCompany.id}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts);
      }
    } catch (err) {
      console.error('Failed to fetch bank accounts:', err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchAssetAccounts() {
    if (!activeCompany) return;
    try {
      const res = await fetch(
        `/api/journal/accounts?companyId=${activeCompany.id}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setAssetAccounts(
          (data.data || data.accounts || []).filter(
            (a: GlAccountOption) => a.accountType === 'asset'
          )
        );
      }
    } catch (err) {
      console.error('Failed to fetch GL accounts:', err);
    }
  }

  useEffect(() => {
    fetchAccounts();
    fetchAssetAccounts();
  }, [activeCompany]);

  // ─── Modal helpers ────────────────────────────────────────────────

  function openCreateModal() {
    setEditingAccount(null);
    setFormAccountName('');
    setFormBankName('');
    setFormAccountNo('');
    setFormRoutingNo('');
    setFormGlAccountId(null);
    setFormBalance('');
    setFormCurrency('USD');
    setFormError('');
    setModalOpen(true);
  }

  function openEditModal(account: BankAccountData) {
    setEditingAccount(account);
    setFormAccountName(account.accountName);
    setFormBankName(account.bankName);
    setFormAccountNo(account.accountNo || '');
    setFormRoutingNo(account.routingNo || '');
    setFormGlAccountId(account.glAccountId);
    setFormBalance(account.balance.toString());
    setFormCurrency(account.currency);
    setFormError('');
    setModalOpen(true);
  }

  function validateForm(): string | null {
    if (!formAccountName.trim()) return t('banks.accountName') + ' is required';
    if (!formBankName.trim()) return t('banks.bankName') + ' is required';
    if (!formGlAccountId) return t('banks.linkedAccount') + ' is required';
    return null;
  }

  async function handleSave() {
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError('');

    setSaving(true);
    try {
      const body = {
        companyId: activeCompany!.id,
        accountName: formAccountName,
        bankName: formBankName,
        accountNo: formAccountNo || null,
        routingNo: formRoutingNo || null,
        glAccountId: formGlAccountId,
        balance: parseFloat(formBalance) || 0,
        currency: formCurrency,
      };

      const url = editingAccount
        ? `/api/banks/${editingAccount.id}`
        : '/api/banks';
      const method = editingAccount ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setModalOpen(false);
        fetchAccounts();
        if (selectedAccount && editingAccount?.id === selectedAccount.id) {
          fetchAccountDetail(selectedAccount.id);
        }
      } else {
        const err = await res.json();
        setFormError(err.error || 'Failed to save');
      }
    } catch (err) {
      console.error('Save error:', err);
      setFormError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────

  function requestDelete(account: BankAccountData) {
    setDeleteTarget(account);
    setDeleteOpen(true);
  }

  async function executeDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/banks/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompany!.id }),
      });
      if (res.ok) {
        setDeleteOpen(false);
        setDeleteTarget(null);
        fetchAccounts();
        if (selectedAccount?.id === deleteTarget.id) {
          setViewMode('grid');
          setSelectedAccount(null);
        }
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to deactivate');
      }
    } catch (err) {
      console.error('Delete error:', err);
    } finally {
      setDeleting(false);
    }
  }

  // ─── Detail view ─────────────────────────────────────────────────

  async function openDetail(account: BankAccountData) {
    setSelectedAccount(account);
    setViewMode('detail');
    fetchAccountDetail(account.id);
  }

  async function fetchAccountDetail(accountId: string) {
    try {
      const res = await fetch(
        `/api/banks/${accountId}?companyId=${activeCompany!.id}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setRecentTransactions(data.account.recentTransactions || []);
      }
    } catch (err) {
      console.error('Failed to fetch account detail:', err);
    }
  }

  // ─── Total balance ───────────────────────────────────────────────

  const totalBalance = useMemo(
    () => accounts.filter((a) => a.isActive).reduce((s, a) => s + a.balance, 0),
    [accounts]
  );

  // ─── Active accounts ─────────────────────────────────────────────

  const activeAccounts = accounts.filter((a) => a.isActive);
  const inactiveAccounts = accounts.filter((a) => !a.isActive);

  // ─── Render: Detail View ─────────────────────────────────────────

  if (viewMode === 'detail' && selectedAccount) {
    return (
      <div className="space-y-4">
        {/* Back + header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setViewMode('grid');
              setSelectedAccount(null);
              setRecentTransactions([]);
            }}
          >
            <ArrowUpRight className="size-4 mr-1 rotate-180" />
            {t('common.back')}
          </Button>
        </div>

        {/* Account header card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/40">
                    <Landmark className="size-5 text-teal-600 dark:text-teal-400" />
                  </div>
                  {selectedAccount.accountName}
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{selectedAccount.bankName}</span>
                  <span className="flex items-center gap-1">
                    <Hash className="size-3" />
                    {maskAccountNo(selectedAccount.accountNo)}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {selectedAccount.currency}
                  </Badge>
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEditModal(selectedAccount)}
                >
                  <Pencil className="size-3.5 mr-1" />
                  {t('common.edit')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('banks.currentBalance')}
                </p>
                <p className={cn(
                  'text-xl font-bold font-mono',
                  selectedAccount.balance >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                )}>
                  {fmtCurrency(selectedAccount.balance)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('banks.linkedAccount')}
                </p>
                <p className="text-sm font-medium">
                  <span className="font-mono text-teal-600 dark:text-teal-400">
                    {selectedAccount.glAccount.code}
                  </span>{' '}
                  {selectedAccount.glAccount.name}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('banks.statements')}
                </p>
                <p className="text-sm font-medium">
                  {selectedAccount._count.statements}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Status
                </p>
                <Badge
                  variant="outline"
                  className={
                    selectedAccount.isActive
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                      : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700'
                  }
                >
                  {selectedAccount.isActive ? t('common.active') : t('common.inactive')}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent transactions */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('banks.transactions')}</CardTitle>
          </CardHeader>
          <CardContent>
            {recentTransactions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <CircleDot className="size-8 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">
                  No transactions found. Import a statement to see transactions.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.date')}</TableHead>
                      <TableHead>{t('common.description')}</TableHead>
                      <TableHead className="text-right">{t('common.amount')}</TableHead>
                      <TableHead className="text-center">{t('reconciliation.reconciled')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentTransactions.map((txn) => (
                      <TableRow key={txn.id}>
                        <TableCell className="font-medium text-sm whitespace-nowrap">
                          {formatDateShort(txn.date)}
                        </TableCell>
                        <TableCell className="max-w-[300px]">
                          <div>
                            <p className="text-sm truncate">{txn.description}</p>
                            {txn.glAccount && (
                              <p className="text-xs text-muted-foreground">
                                {txn.glAccount.code} — {txn.glAccount.name}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className={cn(
                          'text-right font-mono text-sm font-medium',
                          txn.amount >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                        )}>
                          {fmtCurrency(txn.amount)}
                        </TableCell>
                        <TableCell className="text-center">
                          {txn.isReconciled ? (
                            <CheckCircle2 className="size-4 text-emerald-500 mx-auto" />
                          ) : (
                            <XCircle className="size-4 text-muted-foreground/40 mx-auto" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── Render: Grid View ───────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {t('banks.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {activeAccounts.length} {t('common.active').toLowerCase()} account
            {activeAccounts.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button variant="outline" onClick={() => setCurrentView('import')}>
          <Upload className="size-4 mr-1" />
          {t('banks.uploadStatement')}
        </Button>
        <Button onClick={openCreateModal}>
          <Plus className="size-4 mr-1" />
          {t('banks.newBankAccount')}
        </Button>
      </div>

      {/* Total balance banner */}
      {activeAccounts.length > 0 && (
        <div className="rounded-lg border bg-gradient-to-r from-teal-50 to-emerald-50 dark:from-teal-950/30 dark:to-emerald-950/30 p-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-teal-100 dark:bg-teal-900/50">
            <DollarSign className="size-5 text-teal-600 dark:text-teal-400" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Total Bank Balance
            </p>
            <p className={cn(
              'text-2xl font-bold font-mono',
              totalBalance >= 0
                ? 'text-teal-700 dark:text-teal-300'
                : 'text-red-700 dark:text-red-300'
            )}>
              {fmtCurrency(totalBalance)}
            </p>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : accounts.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-teal-100 dark:bg-teal-900/40 mb-4">
            <Landmark className="size-8 text-teal-600 dark:text-teal-400" />
          </div>
          <h3 className="text-lg font-semibold mb-1">{t('banks.noBankAccounts')}</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Add a bank account to start tracking your finances.
          </p>
          <Button onClick={openCreateModal}>
            <Plus className="size-4 mr-1" />
            {t('banks.newBankAccount')}
          </Button>
        </div>
      ) : (
        <>
          {/* Active accounts grid */}
          {activeAccounts.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeAccounts.map((account) => (
                <Card
                  key={account.id}
                  className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-teal-500"
                  onClick={() => openDetail(account)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/40">
                          <Building2 className="size-4 text-teal-600 dark:text-teal-400" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-sm font-semibold truncate">
                            {account.accountName}
                          </CardTitle>
                          <CardDescription className="text-xs truncate">
                            {account.bankName}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetail(account);
                          }}
                          title={t('banks.transactions')}
                        >
                          <Eye className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditModal(account);
                          }}
                          title={t('common.edit')}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-red-600"
                          onClick={(e) => {
                            e.stopPropagation();
                            requestDelete(account);
                          }}
                          title={t('common.delete')}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    <div className={cn(
                      'text-xl font-bold font-mono',
                      account.balance >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    )}>
                      {fmtCurrency(account.balance)}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Hash className="size-3" />
                        {maskAccountNo(account.accountNo)}
                      </span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                        {account.currency}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="font-mono text-teal-600 dark:text-teal-400">
                        {account.glAccount.code}
                      </span>
                      <span className="truncate">{account.glAccount.name}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Inactive accounts */}
          {inactiveAccounts.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                {t('common.inactive')} ({inactiveAccounts.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {inactiveAccounts.map((account) => (
                  <Card
                    key={account.id}
                    className="opacity-60 cursor-pointer hover:opacity-100 transition-opacity border-l-4 border-l-gray-400 dark:border-l-gray-600"
                    onClick={() => openDetail(account)}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
                            <Building2 className="size-4 text-gray-500" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-sm font-semibold truncate">
                              {account.accountName}
                            </CardTitle>
                            <CardDescription className="text-xs truncate">
                              {account.bankName}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(account);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="text-sm font-mono text-muted-foreground">
                        {fmtCurrency(account.balance)}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── Create/Edit Modal ─────────────────────────────────────── */}
      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditingAccount(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {editingAccount
                ? t('banks.editBankAccount')
                : t('banks.newBankAccount')}
            </DialogTitle>
            <DialogDescription>
              {editingAccount
                ? 'Update bank account information'
                : 'Add a new bank account for your company'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Account Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('common.name')} <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder="e.g. Business Checking"
                value={formAccountName}
                onChange={(e) => setFormAccountName(e.target.value)}
              />
            </div>

            {/* Bank Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('banks.bankName')} <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder="e.g. Chase Bank"
                value={formBankName}
                onChange={(e) => setFormBankName(e.target.value)}
              />
            </div>

            {/* Account Number + Routing */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('banks.accountNumber')}
                </label>
                <Input
                  placeholder="e.g. 123456789"
                  value={formAccountNo}
                  onChange={(e) => setFormAccountNo(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('banks.routingNumber')}
                </label>
                <Input
                  placeholder="e.g. 021000021"
                  value={formRoutingNo}
                  onChange={(e) => setFormRoutingNo(e.target.value)}
                />
              </div>
            </div>

            {/* GL Account */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('banks.linkedAccount')} <span className="text-red-500">*</span>
              </label>
              <AccountSelector
                accounts={assetAccounts}
                value={formGlAccountId}
                onChange={setFormGlAccountId}
                placeholder="Select asset account"
              />
              <p className="text-xs text-muted-foreground">
                Bank accounts must be linked to an asset-type GL account
              </p>
            </div>

            {/* Starting Balance + Currency */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  Starting Balance
                </label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={formBalance}
                  onChange={(e) => setFormBalance(e.target.value)}
                  className="font-mono text-right"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Currency</label>
                <Select value={formCurrency} onValueChange={setFormCurrency}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Error */}
            {formError && (
              <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation ───────────────────────────────────── */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Bank Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to deactivate &quot;{deleteTarget?.accountName}&quot; at{' '}
              &quot;{deleteTarget?.bankName}&quot;? This will mark the account as inactive.
              Existing statements and transactions will be preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={executeDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting && <Loader2 className="size-4 mr-1 animate-spin" />}
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
