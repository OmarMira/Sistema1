'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Search,
  ChevronRight,
  ChevronDown,
  Lock,
  Pencil,
  Trash2,
  FolderOpen,
  Loader2,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountTypeBadge } from '@/components/spa/accounts/AccountTypeBadge';
import { BalanceBadge } from '@/components/spa/accounts/BalanceBadge';

/* ─── Types ─── */
interface AccountCount {
  children: number;
  journalLines: number;
}

interface GlAccount {
  id: string;
  companyId: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
  parent?: { id: string; code: string; name: string } | null;
  _count?: AccountCount;
}

interface AccountFormData {
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentId: string;
}

const DEFAULT_FORM: AccountFormData = {
  code: '',
  name: '',
  accountType: '',
  normalBalance: '',
  parentId: '',
};

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

const TYPE_HELPERS: Record<string, { en: string; es: string }> = {
  asset: { en: 'Resources owned by the company (cash, receivables, inventory)', es: 'Recursos propiedad de la empresa (efectivo, cuentas por cobrar, inventario)' },
  liability: { en: 'Debts and obligations (payables, loans, taxes)', es: 'Deudas y obligaciones (cuentas por pagar, préstamos, impuestos)' },
  equity: { en: 'Owner\'s equity and retained earnings', es: 'Capital contable y utilidades retenidas' },
  revenue: { en: 'Income from business operations', es: 'Ingresos por operaciones del negocio' },
  expense: { en: 'Costs incurred in business operations', es: 'Costos incurridos en las operaciones del negocio' },
};

const BALANCE_HELPERS: Record<string, { en: string; es: string }> = {
  debit: { en: 'Increases with debits (Assets, Expenses)', es: 'Aumenta con cargos (Activos, Gastos)' },
  credit: { en: 'Increases with credits (Liabilities, Equity, Revenue)', es: 'Aumenta con abonos (Pasivos, Capital, Ingresos)' },
};

/* ─── Animation Variants ─── */
const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.03, duration: 0.3, ease: 'easeOut' as const },
  }),
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

/* ─── AccountsPage ─── */
export function AccountsPage() {
  const t = useLanguageStore((s) => s.t);
  const language = useLanguageStore((s) => s.language);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  // ── State ──
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

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
      setAccounts(data.accounts);
    } catch (err) {
      console.error('[ACCOUNTS PAGE FETCH]', err);
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id, filterType, search]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  /* ── Build tree ── */
  const rootAccounts = useMemo(() => {
    return accounts
      .filter((a) => !a.parentId)
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts]);

  const childrenMap = useMemo(() => {
    const map = new Map<string, GlAccount[]>();
    for (const account of accounts) {
      if (account.parentId) {
        const existing = map.get(account.parentId) ?? [];
        existing.push(account);
        map.set(account.parentId, existing.sort((a, b) => a.code.localeCompare(b.code)));
      }
    }
    return map;
  }, [accounts]);

  const allAccountsForSelect = useMemo(() => {
    return accounts.filter((a) => (a._count?.children ?? 0) === 0 || !a.parentId);
  }, [accounts]);

  /* ── Toggle expand ── */
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
    setExpandedIds(new Set(accounts.filter((a) => (a._count?.children ?? 0) > 0).map((a) => a.id)));
  }

  function collapseAll() {
    setExpandedIds(new Set());
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
      parentId: account.parentId ?? '',
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
        parentId: formData.parentId || null,
      };

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

  /* ── Delete account ── */
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');

    try {
      const res = await fetch(`/api/accounts/${deleteTarget.id}`, { method: 'DELETE' });
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

  /* ── Render account row ── */
  function renderRow(account: GlAccount, depth: number, index: number) {
    const hasChildren = (account._count?.children ?? 0) > 0;
    const isExpanded = expandedIds.has(account.id);
    const children = childrenMap.get(account.id) ?? [];

    return (
      <motion.div
        key={account.id}
        custom={index}
        variants={rowVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        layout
      >
        <Collapsible
          open={isExpanded}
          onOpenChange={() => toggleExpand(account.id)}
        >
          <TableRow
            className={cn(
              'group',
              !account.isActive && 'opacity-50',
              depth > 0 && 'bg-muted/30'
            )}
          >
            {/* Expand */}
            <TableCell className="w-10">
              {hasChildren ? (
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7">
                    {isExpanded ? (
                      <ChevronDown className="size-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground" />
                    )}
                  </Button>
                </CollapsibleTrigger>
              ) : (
                <div className="w-7" />
              )}
            </TableCell>

            {/* Code */}
            <TableCell className="w-28">
              <div
                className="flex items-center gap-2"
                style={{ paddingLeft: `${depth * 20}px` }}
              >
                {hasChildren && !isExpanded && (
                  <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="font-mono text-sm font-semibold text-teal-700 dark:text-teal-400">
                  {account.code}
                </span>
              </div>
            </TableCell>

            {/* Name */}
            <TableCell>
              <div className="flex items-center gap-2">
                {account.isSystem && (
                  <Lock className="size-3.5 text-amber-500 shrink-0" aria-label="System account" />
                )}
                <span className="font-medium">{account.name}</span>
              </div>
            </TableCell>

            {/* Type */}
            <TableCell className="w-32">
              <AccountTypeBadge accountType={account.accountType} />
            </TableCell>

            {/* Balance */}
            <TableCell className="w-24">
              <BalanceBadge normalBalance={account.normalBalance} />
            </TableCell>

            {/* Status */}
            <TableCell className="w-24">
              <Badge
                variant={account.isActive ? 'default' : 'secondary'}
                className={cn(
                  account.isActive
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                )}
              >
                {account.isActive ? t('common.active') : t('common.inactive')}
              </Badge>
            </TableCell>

            {/* Actions */}
            <TableCell className="w-24 text-right">
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => openEditModal(account)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                {!account.isSystem && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                    onClick={() => {
                      setDeleteTarget(account);
                      setDeleteError('');
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>

          {/* Children */}
          {hasChildren && (
            <CollapsibleContent>
              {children.map((child, childIndex) =>
                renderRow(child, depth + 1, index + childIndex + 1)
              )}
            </CollapsibleContent>
          )}
        </Collapsible>
      </motion.div>
    );
  }

  /* ── Type helper text ── */
  function getTypeHelper(type: string) {
    const helper = TYPE_HELPERS[type];
    if (!helper) return '';
    return helper[language] ?? helper.en;
  }

  function getBalanceHelper(balance: string) {
    const helper = BALANCE_HELPERS[balance];
    if (!helper) return '';
    return helper[language] ?? helper.en;
  }

  /* ── Count ── */
  const totalAccounts = accounts.length;

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
        <Button onClick={openCreateModal} className="bg-teal-600 hover:bg-teal-700 text-white shrink-0">
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

      {/* ── Table ── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="w-10" />
                <TableHead className="w-28">{t('common.code')}</TableHead>
                <TableHead>{t('accounts.accountName')}</TableHead>
                <TableHead className="w-32">{t('accounts.accountType')}</TableHead>
                <TableHead className="w-24">{t('accounts.normalBalance')}</TableHead>
                <TableHead className="w-24">{t('common.status')}</TableHead>
                <TableHead className="w-24 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                // Skeleton rows
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={`skel-${i}`}>
                    <TableCell><Skeleton className="h-5 w-5" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-48" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  </TableRow>
                ))
              ) : accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    {t('common.noData')}
                  </TableCell>
                </TableRow>
              ) : (
                <AnimatePresence mode="popLayout">
                  {rootAccounts.map((account, i) => renderRow(account, 0, i))}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Create / Edit Dialog ── */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingAccount ? t('accounts.editAccount') : t('accounts.newAccount')}
            </DialogTitle>
            <DialogDescription>
              {editingAccount
                ? t('accounts.editAccount')
                : t('accounts.newAccount')}
            </DialogDescription>
          </DialogHeader>

          {/* General error */}
          {formErrors.general && (
            <div className="rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 text-sm text-rose-800 dark:text-rose-300">
              {formErrors.general}
            </div>
          )}

          <div className="grid gap-4 py-2">
            {/* Code + Name row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="account-code">{t('accounts.accountCode')}</Label>
                <Input
                  id="account-code"
                  placeholder="1000"
                  value={formData.code}
                  onChange={(e) => setFormData((f) => ({ ...f, code: e.target.value }))}
                  className={formErrors.code ? 'border-rose-500' : ''}
                />
                {formErrors.code && (
                  <p className="text-xs text-rose-600">{formErrors.code}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-name">{t('accounts.accountName')}</Label>
                <Input
                  id="account-name"
                  placeholder={language === 'es' ? 'Efectivo' : 'Cash'}
                  value={formData.name}
                  onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                  className={formErrors.name ? 'border-rose-500' : ''}
                />
                {formErrors.name && (
                  <p className="text-xs text-rose-600">{formErrors.name}</p>
                )}
              </div>
            </div>

            {/* Type + Balance row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('accounts.accountType')}</Label>
                <Select
                  value={formData.accountType}
                  onValueChange={(v) => setFormData((f) => ({ ...f, accountType: v }))}
                >
                  <SelectTrigger className={formErrors.accountType ? 'border-rose-500' : ''}>
                    <SelectValue placeholder={t('accounts.accountType')} />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`accounts.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {formErrors.accountType && (
                  <p className="text-xs text-rose-600">{formErrors.accountType}</p>
                )}
                {formData.accountType && (
                  <p className="text-xs text-muted-foreground">{getTypeHelper(formData.accountType)}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>{t('accounts.normalBalance')}</Label>
                <Select
                  value={formData.normalBalance}
                  onValueChange={(v) => setFormData((f) => ({ ...f, normalBalance: v }))}
                >
                  <SelectTrigger className={formErrors.normalBalance ? 'border-rose-500' : ''}>
                    <SelectValue placeholder={t('accounts.normalBalance')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="debit">{t('accounts.debit')}</SelectItem>
                    <SelectItem value="credit">{t('accounts.credit')}</SelectItem>
                  </SelectContent>
                </Select>
                {formErrors.normalBalance && (
                  <p className="text-xs text-rose-600">{formErrors.normalBalance}</p>
                )}
                {formData.normalBalance && (
                  <p className="text-xs text-muted-foreground">{getBalanceHelper(formData.normalBalance)}</p>
                )}
              </div>
            </div>

            {/* Parent Account */}
            <div className="space-y-2">
              <Label>{t('accounts.parentAccount')}</Label>
              <Select
                value={formData.parentId}
                onValueChange={(v) => setFormData((f) => ({ ...f, parentId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    <span className="text-muted-foreground">
                      {language === 'es' ? 'Ninguna (cuenta raíz)' : 'None (root account)'}
                    </span>
                  </SelectItem>
                  {allAccountsForSelect
                    .filter((a) => a.id !== editingAccount?.id)
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {language === 'es'
                  ? 'Opcional. Agrupa esta cuenta bajo una cuenta padre.'
                  : 'Optional. Group this account under a parent account.'}
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {submitting && <Loader2 className="size-4 mr-2 animate-spin" />}
              {editingAccount ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('accounts.deleteAccount')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('accounts.confirmDelete')}
              {deleteTarget && (
                <span className="block mt-2 font-semibold text-foreground">
                  {deleteTarget.code} — {deleteTarget.name}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div className="rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 text-sm text-rose-800 dark:text-rose-300">
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              {deleting && <Loader2 className="size-4 mr-2 animate-spin" />}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
