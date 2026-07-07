'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { AnimatePresence } from 'framer-motion';
import { ACCOUNT_TYPES } from '@/lib/constants/account-types';
import {
  Plus,
  Search,
  Loader2,
  Landmark,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import type {
  GlAccount as GlAccountType,
  AccountFormData,
} from '@/components/spa/accounts/AccountFormClientDialog';
import { logger } from '@/lib/logger';
import { TYPE_SECTION_CONFIG } from '@/lib/constants/account-tree';
import { AccountTypeSection } from '@/components/accounts/AccountTypeSection';

// ── Lazy-loaded modals — not included in the initial bundle ──────────
const AccountFormDialog = dynamic(
  () =>
    import('@/components/spa/accounts/AccountFormClientDialog').then((m) => ({
      default: m.AccountFormClientDialog,
    })),
  { ssr: false, loading: () => null },
);
const AccountDeleteDialog = dynamic(
  () =>
    import('@/components/spa/accounts/AccountDeleteClientDialog').then((m) => ({
      default: m.AccountDeleteClientDialog,
    })),
  { ssr: false, loading: () => null },
);

/* ─── Types (re-exported from AccountFormDialog) ─── */
type GlAccount = GlAccountType;

const DEFAULT_FORM: AccountFormData = {
  code: '',
  name: '',
  accountType: '',
  normalBalance: '',
  parentId: 'none',
};

/* ─── AccountsPage ─── */
export function AccountsClient({ initialAccounts }: { initialAccounts?: GlAccount[] }) {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  // ── State ──
  const [accounts, setAccounts] = useState<GlAccount[]>(initialAccounts || []);
  const [loading, setLoading] = useState(!initialAccounts);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());

  // ── Modal state ──
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<GlAccount | null>(null);
  const [formData, setFormData] = useState<AccountFormData>(DEFAULT_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // ── Delete dialog ──
  const [deleteTarget, setDeleteTarget] = useState<GlAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  /* ── Fetch accounts ── */
  const fetchAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId: activeCompany.id });
      if (filterType !== 'all') params.set('accountType', filterType);
      if (search.trim()) params.set('search', search.trim());

      const res = await fetch(`/api/accounts?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setAccounts((data.accounts || []).filter(Boolean));
    } catch (err) {
      logger.error('[ACCOUNTS PAGE FETCH]', { error: String(err) });
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id, filterType, search]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  /* ── Build tree structures grouped by type ── */
  const accountsByType = useMemo(() => {
    const groups = new Map<string, GlAccount[]>();
    for (const account of accounts) {
      const existing = groups.get(account.accountType) ?? [];
      existing.push(account);
      groups.set(account.accountType, existing);
    }
    return groups;
  }, [accounts]);

  const childrenMap = useMemo(() => {
    const map = new Map<string, GlAccount[]>();
    for (const account of accounts) {
      if (account.parentId) {
        const existing = map.get(account.parentId) ?? [];
        existing.push(account);
        map.set(
          account.parentId,
          existing.sort((a, b) => a.code.localeCompare(b.code)),
        );
      }
    }
    return map;
  }, [accounts]);

  const allAccountsForSelect = useMemo(() => {
    return accounts.filter((a) => (a._count?.children ?? 0) === 0 || !a.parentId);
  }, [accounts]);

  /* ── Toggle expand for tree node ── */
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function expandAll() {
    const ids = new Set<string>();
    for (const account of accounts) {
      if ((account._count?.children ?? 0) > 0) {
        ids.add(account.id);
      }
    }
    setExpandedIds(ids);
    setCollapsedTypes(new Set());
  }

  function collapseAll() {
    setExpandedIds(new Set());
    setCollapsedTypes(new Set(ACCOUNT_TYPES));
  }

  /* ── Toggle type section collapse ── */
  function toggleTypeSection(typeKey: string) {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(typeKey)) {
        next.delete(typeKey);
      } else {
        next.add(typeKey);
      }
      return next;
    });
  }

  /* ── Open create modal ── */
  function openCreateModal() {
    setEditingAccount(null);
    setFormData(DEFAULT_FORM);
    setFormErrors({});
    setModalOpen(true);
  }

  /* ── Open edit modal ── */
  function openEditModal(account: GlAccount) {
    setEditingAccount(account);
    setFormData({
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      normalBalance: account.normalBalance,
      parentId: account.parentId ?? 'none',
    });
    setFormErrors({});
    setModalOpen(true);
  }

  /* ── Validate form ── */
  function validateForm(): boolean {
    const errors: Record<string, string> = {};
    if (!formData.code.trim()) {
      errors.code = t('accounts.accountCode') + ' is required';
    }
    if (!formData.name.trim()) {
      errors.name = t('accounts.accountName') + ' is required';
    }
    if (!formData.accountType) {
      errors.accountType = t('accounts.accountType') + ' is required';
    }
    if (!formData.normalBalance) {
      errors.normalBalance = t('accounts.normalBalance') + ' is required';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  /* ── Submit form ── */
  async function handleSubmit() {
    if (!validateForm() || !activeCompany?.id) return;
    setSubmitting(true);
    setFormErrors({});

    try {
      const body = {
        companyId: activeCompany.id,
        code: formData.code.trim(),
        name: formData.name.trim(),
        accountType: formData.accountType,
        normalBalance: formData.normalBalance,
        parentId: formData.parentId === 'none' || !formData.parentId ? null : formData.parentId,
      };

      logger.info('[ACCOUNTS CLIENT] handleSubmit', { method: editingAccount ? 'PUT' : 'POST', body });

      let res: Response;
      if (editingAccount) {
        res = await fetch(`/api/accounts/${editingAccount.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const data = await res.json();
        setFormErrors({ general: data.error || t('common.error') });
        return;
      }

      setModalOpen(false);
      fetchAccounts();
    } catch {
      setFormErrors({ general: t('common.error') });
    } finally {
      setSubmitting(false);
    }
  }

  function handleDeleteClick(account: GlAccount) {
    setDeleteError('');
    setDeleteTarget(account);

    if (account.isSystem) {
      setDeleteError(t('accounts.systemAccountCannotBeDeleted'));
      return;
    }

    if (account.balance && account.balance !== 0) {
      setDeleteError(t('accounts.accountHasBalanceCannotBeDeleted'));
      return;
    }
  }

  /* ── Delete account ── */
  async function handleDelete() {
    if (!deleteTarget || !activeCompany?.id) return;
    setDeleting(true);
    setDeleteError('');

    try {
      const res = await fetch(`/api/accounts/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      if (!res.ok) {
        const data = await res.json();
        setDeleteError(data.error || t('common.error'));
        return;
      }
      setDeleteTarget(null);
      fetchAccounts();
    } catch {
      setDeleteError(t('common.error'));
    } finally {
      setDeleting(false);
    }
  }

  async function handleToggleActive(account: GlAccount) {
    if (!activeCompany?.id) return;
    try {
      const res = await fetch(`/api/accounts/${account.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !account.isActive, companyId: activeCompany.id }),
      });
      if (res.ok) {
        fetchAccounts();
      }
    } catch (err) {
      logger.error('[TOGGLE ACTIVE ERROR]', { error: String(err) });
    }
  }

  /* ── Count ── */
  const totalAccounts = accounts.length;

  /* ── Determine visible type sections ── */
  const visibleTypeConfigs = useMemo(() => {
    if (filterType !== 'all') {
      return TYPE_SECTION_CONFIG.filter((c) => c.key === filterType);
    }
    return TYPE_SECTION_CONFIG;
  }, [filterType]);

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('accounts.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {totalAccounts} {totalAccounts === 1 ? 'account' : 'accounts'}
          </p>
        </div>
        <Button
          onClick={openCreateModal}
          className="bg-teal-600 hover:bg-teal-700 text-white shrink-0"
        >
          <Plus className="size-4 mr-2" />
          {t('accounts.newAccount')}
        </Button>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder={t('accounts.searchAccounts')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder={t('accounts.accountType')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('common.all')}</SelectItem>
            {ACCOUNT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`accounts.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" onClick={expandAll}>
            {t('accounts.expandedView')}
          </Button>
          <Button variant="outline" size="sm" onClick={collapseAll}>
            {t('accounts.collapsedView')}
          </Button>
        </div>
      </div>

      {/* ── Summary badges row ── */}
      {!loading && accounts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {TYPE_SECTION_CONFIG.map((config) => {
            const count = accountsByType.get(config.key)?.length ?? 0;
            if (count === 0) return null;
            const Icon = config.icon;
            return (
              <button
                key={config.key}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors hover:bg-muted/60',
                  filterType === config.key
                    ? cn(config.iconBg, config.iconColor, config.accentBorder)
                    : 'bg-background text-muted-foreground border-border',
                )}
                onClick={() => setFilterType(filterType === config.key ? 'all' : config.key)}
              >
                <Icon className="size-3" />
                {t(config.i18nKey)}
                <Badge
                  variant="secondary"
                  className="ml-0.5 text-[10px] px-1.5 py-0 h-4 min-w-[18px] flex items-center justify-center"
                >
                  {count}
                </Badge>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Type Sections ── */}
      <div className="space-y-4">
        {loading ? (
          // Skeleton sections
          TYPE_SECTION_CONFIG.map((config, idx) => (
            <div key={`skel-${idx}`} className="rounded-xl border border-border">
              <div className={cn('h-12 rounded-t-xl', config.accentBg, 'opacity-40')} />
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-5 w-5 shrink-0" />
                    <Skeleton className="h-5 w-16 shrink-0" />
                    <Skeleton className="h-5 flex-1 max-w-[200px]" />
                    <Skeleton className="h-5 w-14 shrink-0 hidden sm:block" />
                    <Skeleton className="h-5 w-12 shrink-0 hidden sm:block" />
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : accounts.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-muted/20 py-16 text-center">
            <Landmark className="size-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground">{t('common.noData')}</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {visibleTypeConfigs.map((config, idx) => {
              const typeAccounts = accountsByType.get(config.key);
              if (!typeAccounts || typeAccounts.length === 0) return null;
              return (
                <AccountTypeSection key={config.key}
                  config={config}
                  typeAccounts={typeAccounts}
                  sectionIndex={idx}
                  collapsedTypes={collapsedTypes}
                  onToggleTypeSection={toggleTypeSection}
                  expandedIds={expandedIds}
                  childrenMap={childrenMap}
                  onToggleExpand={toggleExpand}
                  onOpenEdit={openEditModal}
                  onToggleActive={handleToggleActive}
                  onDeleteClick={handleDeleteClick}
                />
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* ── Create / Edit Dialog — lazy loaded ── */}
      {modalOpen && (
        <AccountFormDialog
          open={modalOpen}
          onOpenChange={setModalOpen}
          editingAccount={editingAccount}
          formData={formData}
          formErrors={formErrors}
          submitting={submitting}
          allAccountsForSelect={allAccountsForSelect}
          onFormChange={(patch) => setFormData((f) => ({ ...f, ...patch }))}
          onSubmit={handleSubmit}
        />
      )}

      {/* ── Delete Confirmation — lazy loaded ── */}
      {deleteTarget && (
        <AccountDeleteDialog
          target={deleteTarget}
          deleteError={deleteError}
          deleting={deleting}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
