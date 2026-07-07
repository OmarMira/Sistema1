'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Plus, Landmark, Loader2, DollarSign, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { AccountSelector, type GlAccountOption } from './journal/AccountSelector';
import { logger } from '@/lib/logger';
import {
  BankFormDialog,
  DeleteConfirmDialog,
  BankDetailView,
  BankAccountCard,
  fmtCurrency,
} from './banks';

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
  initialBalance: number;
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

export function BanksPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  const [accounts, setAccounts] = useState<BankAccountData[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedAccount, setSelectedAccount] = useState<BankAccountData | null>(null);
  const [recentTransactions, setRecentTransactions] = useState<BankTransactionData[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<BankAccountData | null>(null);
  const [saving, setSaving] = useState(false);

  const [formAccountName, setFormAccountName] = useState('');
  const [formBankName, setFormBankName] = useState('');
  const [formAccountNo, setFormAccountNo] = useState('');
  const [formRoutingNo, setFormRoutingNo] = useState('');
  const [formGlAccountId, setFormGlAccountId] = useState<string | null>(null);
  const [formBalance, setFormBalance] = useState('');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formError, setFormError] = useState('');

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BankAccountData | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [assetAccounts, setAssetAccounts] = useState<GlAccountOption[]>([]);

  const fetchAccounts = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/banks?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts || []);
      }
    } catch (err) {
      logger.error('Failed to fetch bank accounts:', { error: String(err) });
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  const fetchAssetAccounts = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/journal/accounts?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAssetAccounts(
          (data.data || []).filter((a: GlAccountOption) => a.accountType === 'asset'),
        );
      }
    } catch (err) {
      logger.error('Failed to fetch asset accounts:', { error: String(err) });
    }
  }, [activeCompany]);

  useEffect(() => {
    fetchAccounts();
    fetchAssetAccounts();
  }, [fetchAccounts, fetchAssetAccounts]);

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
    const formattedBalance = formatNumberWithComas(String(account.initialBalance));
    setFormBalance(formattedBalance);
    setFormCurrency(account.currency);
    setFormError('');
    setModalOpen(true);
  }

  function formatNumberWithComas(val: string): string {
    const cleaned = val.replace(/[^0-9.]/g, '');
    const parts = cleaned.split('.');
    if (parts.length > 2) return val;
    const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (parts.length === 2) {
      return `${integerPart}.${parts[1].slice(0, 2)}`;
    }
    return integerPart;
  }

  function validateForm(): string | null {
    if (!formAccountName.trim()) return 'Account name is required';
    if (!formBankName.trim()) return 'Bank name is required';
    if (!formGlAccountId) return 'GL account is required';
    return null;
  }

  async function handleSave() {
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSaving(true);
    try {
      const body = {
        companyId: activeCompany!.id,
        accountName: formAccountName,
        bankName: formBankName,
        accountNo: formAccountNo || null,
        routingNo: formRoutingNo || null,
        glAccountId: formGlAccountId,
        balance: parseFloat(formBalance.replace(/,/g, '')) || 0,
        currency: formCurrency,
      };

      const url = editingAccount ? `/api/banks/${editingAccount.id}` : '/api/banks';
      const method = editingAccount ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setModalOpen(false);
        setEditingAccount(null);
        await fetchAccounts();
        if (selectedAccount) {
          await fetch(`/api/banks/${selectedAccount.id}?companyId=${activeCompany!.id}`);
        }
      } else {
        const err = await res.json();
        setFormError(err.error || 'Failed to save');
      }
    } catch (err) {
      logger.error('Save error:', { error: String(err) });
      setFormError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(account: BankAccountData) {
    setDeleteTarget(account);
    setDeleteOpen(true);
  }

  async function executeDelete() {
    if (!deleteTarget || !activeCompany) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/banks/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      if (res.ok) {
        setDeleteOpen(false);
        setDeleteTarget(null);
        await fetchAccounts();
        if (selectedAccount?.id === deleteTarget.id) {
          setViewMode('grid');
          setSelectedAccount(null);
          setRecentTransactions([]);
        }
      } else {
        const err = await res.json();
        logger.error('Delete error:', { error: err.error });
      }
    } catch (err) {
      logger.error('Delete error:', { error: String(err) });
    } finally {
      setDeleting(false);
    }
  }

  async function openDetail(account: BankAccountData) {
    setSelectedAccount(account);
    setViewMode('detail');
    await fetchAccountDetail(account.id);
  }

  async function fetchAccountDetail(accountId: string) {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/banks/${accountId}?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setRecentTransactions(data.account.recentTransactions || []);
      }
    } catch (err) {
      logger.error('Failed to fetch account detail:', { error: String(err) });
    }
  }

  const totalBalance = useMemo(
    () => accounts.filter((a) => a.isActive).reduce((sum, a) => sum + a.balance, 0),
    [accounts],
  );

  const activeAccounts = accounts.filter((a) => a.isActive);
  const inactiveAccounts = accounts.filter((a) => !a.isActive);

  // ─── Render: Detail View ──────────────────────────────────────────

  if (viewMode === 'detail' && selectedAccount) {
    return (
      <BankDetailView
        account={selectedAccount}
        transactions={recentTransactions}
        onBack={() => {
          setViewMode('grid');
          setSelectedAccount(null);
          setRecentTransactions([]);
        }}
        onEdit={openEditModal}
      />
    );
  }

  // ─── Render: Grid View ───────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t('banks.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {activeAccounts.length} {t('common.active').toLowerCase()} account
            {activeAccounts.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button
          onClick={() => setCurrentView('import')}
          className="bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white border-none shadow-sm hover:shadow transition-all"
        >
          <Upload className="size-4 mr-1.5" />
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
            <p
              className={`text-2xl font-bold font-mono ${
                totalBalance >= 0
                  ? 'text-teal-700 dark:text-teal-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
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
                <BankAccountCard
                  key={account.id}
                  account={account}
                  variant="active"
                  onView={openDetail}
                  onEdit={openEditModal}
                  onDelete={requestDelete}
                  onSelect={openDetail}
                />
              ))}
            </div>
          )}

          {/* Inactive accounts */}
          {inactiveAccounts.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                {t('banks.inactive')} ({inactiveAccounts.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {inactiveAccounts.map((account) => (
                  <BankAccountCard
                    key={account.id}
                    account={account}
                    variant="inactive"
                    onEdit={openEditModal}
                    onDelete={requestDelete}
                    onSelect={openDetail}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <BankFormDialog
        open={modalOpen}
        onOpenChange={(val) => {
          setModalOpen(val);
          if (!val) setEditingAccount(null);
        }}
        editingAccount={editingAccount}
        saving={saving}
        formAccountName={formAccountName}
        onFormAccountNameChange={setFormAccountName}
        formBankName={formBankName}
        onFormBankNameChange={setFormBankName}
        formAccountNo={formAccountNo}
        onFormAccountNoChange={setFormAccountNo}
        formRoutingNo={formRoutingNo}
        onFormRoutingNoChange={setFormRoutingNo}
        formGlAccountId={formGlAccountId}
        onFormGlAccountIdChange={setFormGlAccountId}
        formBalance={formBalance}
        onFormBalanceChange={setFormBalance}
        formCurrency={formCurrency}
        onFormCurrencyChange={setFormCurrency}
        formError={formError}
        assetAccounts={assetAccounts}
        onSave={handleSave}
      />

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        deleting={deleting}
        accountName={deleteTarget?.accountName || ''}
        bankName={deleteTarget?.bankName || ''}
        onConfirm={executeDelete}
      />
    </div>
  );
}
