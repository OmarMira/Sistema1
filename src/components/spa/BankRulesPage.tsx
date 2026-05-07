'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Zap,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';

/* ─── Types ─── */
interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
}

interface BankRule {
  id: string;
  companyId: string;
  name: string;
  conditionType: string;
  conditionValue: string;
  transactionDirection: string;
  glAccountId: string;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  glAccount: GlAccount;
  _matchCount: number;
}

interface RuleForm {
  name: string;
  conditionType: string;
  conditionValue: string;
  transactionDirection: string;
  glAccountId: string | null;
  priority: number;
  isActive: boolean;
}

const defaultForm: RuleForm = {
  name: '',
  conditionType: 'contains',
  conditionValue: '',
  transactionDirection: 'any',
  glAccountId: null,
  priority: 10,
  isActive: true,
};

const conditionTypes = [
  'contains',
  'starts_with',
  'ends_with',
  'equals',
  'amount_greater',
  'amount_less',
];

const directions = ['any', 'debit', 'credit'];

/* ─── Helpers ─── */
function getPriorityBadge(priority: number, t: (k: string) => string) {
  if (priority <= 4) {
    return (
      <Badge className="bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800">
        {t('bankRules.priorityCritical')} ({priority})
      </Badge>
    );
  }
  if (priority <= 9) {
    return (
      <Badge className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
        {t('bankRules.priorityHigh')} ({priority})
      </Badge>
    );
  }
  if (priority <= 14) {
    return (
      <Badge className="bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800">
        {t('bankRules.priorityMedium')} ({priority})
      </Badge>
    );
  }
  return (
    <Badge className="bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-900/40 dark:text-gray-300 dark:border-gray-800">
      {t('bankRules.priorityLow')} ({priority})
    </Badge>
  );
}

function getConditionDisplay(rule: BankRule, t: (k: string) => string): string {
  const typeLabel: Record<string, string> = {
    contains: t('bankRules.contains'),
    starts_with: t('bankRules.startsWith'),
    ends_with: t('bankRules.endsWith'),
    equals: t('bankRules.equals'),
    amount_greater: t('bankRules.amountGreater'),
    amount_less: t('bankRules.amountLess'),
  };

  const dirLabel =
    rule.transactionDirection === 'any'
      ? ''
      : ` (${rule.transactionDirection === 'debit' ? t('bankRules.debit') : t('bankRules.credit')})`;

  return `${typeLabel[rule.conditionType] ?? rule.conditionType} '${rule.conditionValue}'${dirLabel}`;
}

function getConditionPreview(form: RuleForm, t: (k: string) => string): string {
  const typeLabel: Record<string, string> = {
    contains: t('bankRules.contains'),
    starts_with: t('bankRules.startsWith'),
    ends_with: t('bankRules.endsWith'),
    equals: t('bankRules.equals'),
    amount_greater: t('bankRules.amountGreater'),
    amount_less: t('bankRules.amountLess'),
  };

  const dirLabel =
    form.transactionDirection === 'any'
      ? ''
      : ` (${form.transactionDirection === 'debit' ? t('bankRules.debit') : t('bankRules.credit')})`;

  if (!form.conditionValue) {
    return `— ${t('bankRules.conditionPreviewHint')}`;
  }

  return `${t('bankRules.description')} ${typeLabel[form.conditionType]} '${form.conditionValue}'${dirLabel}`;
}

/* ─── Component ─── */
export function BankRulesPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [rules, setRules] = useState<BankRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<BankRule | null>(null);
  const [form, setForm] = useState<RuleForm>(defaultForm);
  const [saving, setSaving] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingRule, setDeletingRule] = useState<BankRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Apply all dialog
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ matched: number; total: number } | null>(null);

  // Fetch accounts for dropdown
  const fetchAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    try {
      const res = await fetch(
        `/api/journal/accounts?companyId=${activeCompany.id}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data ?? data);
      }
    } catch {
      // Silently fail — accounts dropdown will be empty
    }
  }, [activeCompany?.id]);

  // Fetch rules
  const fetchRules = useCallback(async () => {
    if (!activeCompany?.id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/bank-rules?companyId=${activeCompany.id}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRules(data.data ?? []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id]);

  useEffect(() => {
    fetchAccounts();
    fetchRules();
  }, [fetchAccounts, fetchRules]);

  // Toggle sort direction
  const toggleSort = () => {
    setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  };

  const sortedRules = [...rules].sort((a, b) =>
    sortDir === 'asc' ? a.priority - b.priority : b.priority - a.priority
  );

  // Open create modal
  const handleCreate = () => {
    setEditingRule(null);
    setForm(defaultForm);
    setModalOpen(true);
  };

  // Open edit modal
  const handleEdit = (rule: BankRule) => {
    setEditingRule(rule);
    setForm({
      name: rule.name,
      conditionType: rule.conditionType,
      conditionValue: rule.conditionValue,
      transactionDirection: rule.transactionDirection,
      glAccountId: rule.glAccountId,
      priority: rule.priority,
      isActive: rule.isActive,
    });
    setModalOpen(true);
  };

  // Save rule
  const handleSave = async () => {
    if (!activeCompany?.id || !form.glAccountId || !form.name.trim()) return;

    setSaving(true);
    try {
      const url = editingRule ? `/api/bank-rules/${editingRule.id}` : '/api/bank-rules';
      const method = editingRule ? 'PUT' : 'POST';
      const body = editingRule
        ? { ...form }
        : { companyId: activeCompany.id, ...form };

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setModalOpen(false);
        fetchRules();
      }
    } catch {
      // Silently fail
    } finally {
      setSaving(false);
    }
  };

  // Toggle active
  const handleToggleActive = async (rule: BankRule) => {
    if (!activeCompany?.id) return;
    try {
      await fetch(`/api/bank-rules/${rule.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      fetchRules();
    } catch {
      // Silently fail
    }
  };

  // Delete
  const handleDelete = async () => {
    if (!deletingRule) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/bank-rules/${deletingRule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setDeleteDialogOpen(false);
        setDeletingRule(null);
        fetchRules();
      }
    } catch {
      // Silently fail
    } finally {
      setDeleting(false);
    }
  };

  // Apply all rules
  const handleApplyAll = async () => {
    if (!activeCompany?.id) return;
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await fetch('/api/bank-rules/apply-all', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      if (res.ok) {
        const data = await res.json();
        setApplyResult(data);
        fetchRules();
      }
    } catch {
      // Silently fail
    } finally {
      setApplying(false);
    }
  };

  /* ─── Render ─── */
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('bankRules.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('bankRules.rulesDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setApplyResult(null);
              setApplyDialogOpen(true);
            }}
            className="gap-2"
          >
            <Play className="size-4" />
            {t('bankRules.applyAll')}
          </Button>
          <Button size="sm" onClick={handleCreate} className="gap-2">
            <Plus className="size-4" />
            {t('bankRules.newRule')}
          </Button>
        </div>
      </div>

      {/* Rules Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-muted mb-4">
                <Zap className="size-7 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                {t('bankRules.noRules')}
              </p>
              <Button size="sm" onClick={handleCreate} className="mt-4 gap-2">
                <Plus className="size-4" />
                {t('bankRules.newRule')}
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 h-auto p-0 font-medium text-xs"
                        onClick={toggleSort}
                      >
                        {t('bankRules.priority')}
                        {sortDir === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )}
                      </Button>
                    </TableHead>
                    <TableHead>{t('bankRules.ruleName')}</TableHead>
                    <TableHead>{t('bankRules.condition')}</TableHead>
                    <TableHead>{t('bankRules.assignToAccount')}</TableHead>
                    <TableHead className="text-center">{t('bankRules.autoMatches')}</TableHead>
                    <TableHead className="text-center">{t('common.status')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRules.map((rule) => (
                    <TableRow key={rule.id} className={!rule.isActive ? 'opacity-60' : ''}>
                      <TableCell>{getPriorityBadge(rule.priority, t)}</TableCell>
                      <TableCell className="font-medium">{rule.name}</TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {getConditionDisplay(rule, t)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs text-teal-600 dark:text-teal-400">
                            {rule.glAccount.code}
                          </span>
                          <span className="text-sm">{rule.glAccount.name}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary" className="font-mono">
                          {rule._matchCount}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={rule.isActive}
                          onCheckedChange={() => handleToggleActive(rule)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => handleEdit(rule)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              setDeletingRule(rule);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {editingRule ? t('bankRules.editRule') : t('bankRules.newRule')}
            </DialogTitle>
            <DialogDescription>
              {editingRule
                ? t('bankRules.editRuleDesc')
                : t('bankRules.newRuleDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="rule-name">{t('bankRules.ruleName')}</Label>
              <Input
                id="rule-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('bankRules.ruleNamePlaceholder')}
              />
            </div>

            {/* Condition Type + Value */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t('bankRules.conditionType')}</Label>
                <Select
                  value={form.conditionType}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, conditionType: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {conditionTypes.map((ct) => (
                      <SelectItem key={ct} value={ct}>
                        {t(`bankRules.${ct === 'starts_with' ? 'startsWith' : ct === 'ends_with' ? 'endsWith' : ct}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('bankRules.conditionValue')}</Label>
                <Input
                  value={form.conditionValue}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, conditionValue: e.target.value }))
                  }
                  placeholder={
                    form.conditionType.startsWith('amount')
                      ? '1000'
                      : 'WALMART'
                  }
                />
              </div>
            </div>

            {/* Direction */}
            <div className="space-y-2">
              <Label>{t('bankRules.direction')}</Label>
              <Select
                value={form.transactionDirection}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, transactionDirection: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {directions.map((d) => (
                    <SelectItem key={d} value={d}>
                      {t(
                        `bankRules.${
                          d === 'any'
                            ? 'anyDirection'
                            : d === 'debit'
                            ? 'debit'
                            : 'credit'
                        }`
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* GL Account */}
            <div className="space-y-2">
              <Label>{t('bankRules.assignToAccount')}</Label>
              <AccountSelector
                accounts={accounts}
                value={form.glAccountId}
                onChange={(id) =>
                  setForm((f) => ({ ...f, glAccountId: id }))
                }
                placeholder={t('journal.selectAccount')}
              />
            </div>

            {/* Priority */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t('bankRules.priority')} (0-20)</Label>
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={form.priority}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 0 && v <= 20) {
                      setForm((f) => ({ ...f, priority: v }));
                    }
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('common.status')}</Label>
                <div className="flex items-center gap-2 h-9">
                  <Switch
                    checked={form.isActive}
                    onCheckedChange={(v) =>
                      setForm((f) => ({ ...f, isActive: v }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">
                    {form.isActive ? t('common.active') : t('common.inactive')}
                  </span>
                </div>
              </div>
            </div>

            {/* Condition Preview */}
            <Card className="bg-muted/50 border-dashed">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground mb-1">
                  {t('bankRules.conditionPreview')}
                </p>
                <p className="text-sm font-medium">
                  {getConditionPreview(form, t)}
                </p>
              </CardContent>
            </Card>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.glAccountId}
              className="gap-2"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('bankRules.confirmDelete')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingRule && (
                <>
                  {t('bankRules.deleteWarning')} &quot;{deletingRule.name}&quot;.
                  {t('bankRules.deleteWarning2')}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="size-4 animate-spin mr-2" />}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Apply All Confirmation */}
      <Dialog open={applyDialogOpen} onOpenChange={setApplyDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('bankRules.applyAllTitle')}</DialogTitle>
            <DialogDescription>
              {t('bankRules.applyAllDesc')}
            </DialogDescription>
          </DialogHeader>

          {applyResult ? (
            <div className="space-y-4">
              <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                    {applyResult.matched}
                  </p>
                  <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">
                    {t('bankRules.transactionsCategorized')}
                  </p>
                </CardContent>
              </Card>
              <DialogFooter>
                <Button onClick={() => setApplyDialogOpen(false)}>
                  {t('common.confirm')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={() => setApplyDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleApplyAll}
                disabled={applying}
                className="gap-2"
              >
                {applying && <Loader2 className="size-4 animate-spin" />}
                <Zap className="size-4" />
                {t('bankRules.applyAll')}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
