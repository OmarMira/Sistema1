'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Plus,
  Search,
  Eye,
  Pencil,
  SendHorizonal,
  Ban,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  X,
  Loader2,
  FileText,
  Filter,
  CalendarDays,
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { AccountSelector, type GlAccountOption } from './journal/AccountSelector';

// ─── Types ──────────────────────────────────────────────────────────

interface JournalLineData {
  id: string;
  glAccountId: string | null;
  description: string;
  debit: number;
  credit: number;
}

interface JournalEntryLine {
  id: string;
  glAccountId: string;
  description: string | null;
  debit: number;
  credit: number;
  glAccount: { id: string; code: string; name: string; accountType: string; normalBalance: string };
}

interface JournalEntry {
  id: string;
  companyId: string;
  date: string;
  description: string;
  reference: string | null;
  status: 'draft' | 'posted' | 'void';
  createdAt: string;
  updatedAt: string;
  lines: JournalEntryLine[];
  _totalDebit?: number;
  _totalCredit?: number;
}

type ViewMode = 'list' | 'detail';

// ─── Status Badge ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const t = useLanguageStore((s) => s.t);
  const config: Record<string, { className: string; label: string }> = {
    draft: {
      className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700',
      label: t('journal.draft'),
    },
    posted: {
      className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
      label: t('journal.posted'),
    },
    void: {
      className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800',
      label: t('journal.void'),
    },
  };

  const c = config[status] ?? config.draft;
  return (
    <Badge variant="outline" className={cn('text-xs font-medium', c.className)}>
      {c.label}
    </Badge>
  );
}

// ─── Balance Indicator ──────────────────────────────────────────────

function BalanceIndicator({ balanced }: { balanced: boolean }) {
  if (balanced) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-4" />
        Balanced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-red-600 dark:text-red-400">
      <XCircle className="size-4" />
      Out of Balance
    </span>
  );
}

// ─── Format Helpers ─────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ─── Main Component ─────────────────────────────────────────────────

export function JournalPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  // Form state
  const [formDate, setFormDate] = useState(new Date().toISOString().split('T')[0]);
  const [formDescription, setFormDescription] = useState('');
  const [formReference, setFormReference] = useState('');
  const [formLines, setFormLines] = useState<JournalLineData[]>([]);
  const [saving, setSaving] = useState(false);

  // Accounts
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);

  // Confirmation dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'post' | 'void' | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  // ─── Fetch entries ──────────────────────────────────────────────
  async function fetchEntries() {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId: activeCompany.id });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (searchQuery) params.set('search', searchQuery);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);

      const res = await fetch(`/api/journal?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch entries:', err);
    } finally {
      setLoading(false);
    }
  }

  // ─── Fetch accounts ─────────────────────────────────────────────
  async function fetchAccounts() {
    if (!activeCompany) return;
    try {
      const res = await fetch(
        `/api/journal/accounts?companyId=${activeCompany.id}`
      );
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }

  useEffect(() => {
    fetchAccounts();
  }, [activeCompany]);

  useEffect(() => {
    fetchEntries();
  }, [activeCompany, statusFilter, startDate, endDate]);

  // Debounced search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  function handleSearchChange(val: string) {
    setSearchQuery(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchEntries(), 400);
  }

  // ─── Form helpers ───────────────────────────────────────────────

  function createEmptyLine(): JournalLineData {
    return {
      id: crypto.randomUUID(),
      glAccountId: null,
      description: '',
      debit: 0,
      credit: 0,
    };
  }

  function openNewModal() {
    setEditingEntryId(null);
    setFormDate(new Date().toISOString().split('T')[0]);
    setFormDescription('');
    setFormReference('');
    setFormLines([createEmptyLine(), createEmptyLine()]);
    setModalOpen(true);
  }

  function openEditModal(entry: JournalEntry) {
    setEditingEntryId(entry.id);
    setFormDate(entry.date.split('T')[0]);
    setFormDescription(entry.description);
    setFormReference(entry.reference ?? '');
    setFormLines(
      entry.lines.map((l) => ({
        id: l.id,
        glAccountId: l.glAccountId,
        description: l.description ?? '',
        debit: l.debit,
        credit: l.credit,
      }))
    );
    setModalOpen(true);
  }

  function addLine() {
    setFormLines((prev) => [...prev, createEmptyLine()]);
  }

  function removeLine(lineId: string) {
    setFormLines((prev) => {
      if (prev.length <= 2) return prev;
      return prev.filter((l) => l.id !== lineId);
    });
  }

  function updateLine(
    lineId: string,
    field: keyof JournalLineData,
    value: unknown
  ) {
    setFormLines((prev) =>
      prev.map((l) => (l.id === lineId ? { ...l, [field]: value } : l))
    );
  }

  const totalDebits = formLines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredits = formLines.reduce((s, l) => s + (l.credit || 0), 0);
  const isBalanced = formLines.length >= 2 && Math.abs(totalDebits - totalCredits) < 0.005;

  function validateForm(): string | null {
    if (!formDate) return 'Date is required';
    if (!formDescription.trim()) return 'Description is required';
    if (formLines.length < 2) return 'At least 2 lines are required';
    for (const line of formLines) {
      if (!line.glAccountId) return 'All lines must have an account selected';
    }
    if (!isBalanced) return 'Debits and credits must be equal';
    return null;
  }

  async function handleSave(status: 'draft' | 'posted') {
    const validationError = validateForm();
    if (validationError) {
      alert(validationError);
      return;
    }

    setSaving(true);
    try {
      const body = {
        companyId: activeCompany!.id,
        date: formDate,
        description: formDescription,
        reference: formReference || null,
        status,
        lines: formLines.map((l) => ({
          glAccountId: l.glAccountId,
          description: l.description || null,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
        })),
      };

      const url = editingEntryId
        ? `/api/journal/${editingEntryId}`
        : '/api/journal';
      const method = editingEntryId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setModalOpen(false);
        fetchEntries();
        if (selectedEntry && editingEntryId === selectedEntry.id) {
          // Refresh detail view
          const data = await res.json();
          setSelectedEntry(data);
        }
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to save');
      }
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }

  // ─── Actions (Post / Void) ──────────────────────────────────────

  function requestAction(entryId: string, action: 'post' | 'void') {
    setConfirmAction(action);
    setConfirmTarget(entryId);
    setConfirmOpen(true);
  }

  async function executeAction() {
    if (!confirmTarget || !confirmAction) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/journal/${confirmTarget}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: confirmAction }),
      });
      if (res.ok) {
        const data = await res.json();
        if (selectedEntry?.id === confirmTarget) {
          setSelectedEntry(data);
        }
        fetchEntries();
      } else {
        const err = await res.json();
        alert(err.error || 'Action failed');
      }
    } catch (err) {
      console.error('Action error:', err);
    } finally {
      setActionLoading(false);
      setConfirmOpen(false);
      setConfirmAction(null);
      setConfirmTarget(null);
    }
  }

  // ─── Detail view ────────────────────────────────────────────────

  function openDetail(entry: JournalEntry) {
    setSelectedEntry(entry);
    setViewMode('detail');
  }

  async function refreshDetail() {
    if (!selectedEntry) return;
    try {
      const res = await fetch(`/api/journal/${selectedEntry.id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedEntry(data);
      }
    } catch (err) {
      console.error('Failed to refresh entry:', err);
    }
  }

  const detailTotalDebits = selectedEntry?.lines.reduce((s, l) => s + l.debit, 0) ?? 0;
  const detailTotalCredits = selectedEntry?.lines.reduce((s, l) => s + l.credit, 0) ?? 0;
  const detailBalanced = Math.abs(detailTotalDebits - detailTotalCredits) < 0.005;

  // ─── Render: List View ──────────────────────────────────────────

  if (viewMode === 'detail' && selectedEntry) {
    return (
      <div className="space-y-4">
        {/* Back button + header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setViewMode('list');
              setSelectedEntry(null);
            }}
          >
            <ArrowLeft className="size-4 mr-1" />
            {t('common.back')}
          </Button>
        </div>

        {/* Entry header */}
        <div className="rounded-lg border bg-card p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{selectedEntry.description}</h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="size-3.5" />
                  {formatDate(selectedEntry.date)}
                </span>
                {selectedEntry.reference && (
                  <span>
                    {t('common.reference')}: {selectedEntry.reference}
                  </span>
                )}
                <StatusBadge status={selectedEntry.status} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              {selectedEntry.status === 'draft' && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditModal(selectedEntry)}
                  >
                    <Pencil className="size-3.5 mr-1" />
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => requestAction(selectedEntry.id, 'post')}
                  >
                    <SendHorizonal className="size-3.5 mr-1" />
                    {t('journal.postEntry')}
                  </Button>
                </>
              )}
              {selectedEntry.status === 'posted' && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => requestAction(selectedEntry.id, 'void')}
                >
                  <Ban className="size-3.5 mr-1" />
                  {t('journal.voidEntry')}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Lines table */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('accounts.accountCode')}</TableHead>
                <TableHead>{t('accounts.accountName')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('common.description')}</TableHead>
                <TableHead className="text-right">{t('accounts.debit')}</TableHead>
                <TableHead className="text-right">{t('accounts.credit')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedEntry.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <span className="font-mono text-xs text-teal-600 dark:text-teal-400">
                      {line.glAccount.code}
                    </span>
                  </TableCell>
                  <TableCell className="font-medium">{line.glAccount.name}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {line.description || '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {line.debit > 0 ? fmt(line.debit) : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {line.credit > 0 ? fmt(line.credit) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>
                  <BalanceIndicator balanced={detailBalanced} />
                </TableCell>
                <TableCell className="text-right font-mono font-semibold">
                  {fmt(detailTotalDebits)}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold">
                  {fmt(detailTotalCredits)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </div>
    );
  }

  // ─── Render: List View ──────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t('journal.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('journal.subtitle')}
          </p>
        </div>
        <Button onClick={openNewModal}>
          <Plus className="size-4 mr-1" />
          {t('journal.newEntry')}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder={`${t('common.search')}...`}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8 h-9"
          />
        </div>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v)}>
          <SelectTrigger className="w-[140px] h-9">
            <Filter className="size-3.5 mr-1 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('common.all')}</SelectItem>
            <SelectItem value="draft">{t('journal.draft')}</SelectItem>
            <SelectItem value="posted">{t('journal.posted')}</SelectItem>
            <SelectItem value="void">{t('journal.void')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Date range */}
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="w-[150px] h-9"
          placeholder={t('journal.fromDate')}
        />
        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="w-[150px] h-9"
          placeholder={t('journal.toDate')}
        />
        {(statusFilter !== 'all' || startDate || endDate) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusFilter('all');
              setStartDate('');
              setEndDate('');
            }}
            className="h-9"
          >
            <X className="size-3.5 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Entries table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="size-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">{t('journal.noEntries')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.date')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('common.reference')}</TableHead>
                <TableHead>{t('common.description')}</TableHead>
                <TableHead className="text-right hidden md:table-cell">{t('journal.debitTotal')}</TableHead>
                <TableHead className="text-right hidden md:table-cell">{t('journal.creditTotal')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow
                  key={entry.id}
                  className="cursor-pointer"
                  onClick={() => openDetail(entry)}
                >
                  <TableCell className="font-medium">
                    {formatDate(entry.date)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {entry.reference || '—'}
                  </TableCell>
                  <TableCell className="max-w-[250px] truncate">
                    {entry.description}
                  </TableCell>
                  <TableCell className="text-right font-mono hidden md:table-cell">
                    {fmt(entry._totalDebit ?? 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono hidden md:table-cell">
                    {fmt(entry._totalCredit ?? 0)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={entry.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(entry);
                        }}
                        title={t('journal.viewEntry')}
                      >
                        <Eye className="size-3.5" />
                      </Button>
                      {entry.status === 'draft' && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(entry);
                            }}
                            title={t('common.edit')}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-emerald-600 hover:text-emerald-700"
                            onClick={(e) => {
                              e.stopPropagation();
                              requestAction(entry.id, 'post');
                            }}
                            title={t('journal.postEntry')}
                          >
                            <SendHorizonal className="size-3.5" />
                          </Button>
                        </>
                      )}
                      {entry.status === 'posted' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-red-600 hover:text-red-700"
                          onClick={(e) => {
                            e.stopPropagation();
                            requestAction(entry.id, 'void');
                          }}
                          title={t('journal.voidEntry')}
                        >
                          <Ban className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ─── Create/Edit Modal ─────────────────────────────────────── */}
      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) {
            setEditingEntryId(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto p-0">
          <div className="p-6 space-y-4">
            <DialogHeader>
              <DialogTitle>
                {editingEntryId ? t('journal.editEntry') : t('journal.newEntry')}
              </DialogTitle>
              <DialogDescription>
                {editingEntryId
                  ? t('journal.editEntryDesc')
                  : t('journal.newEntryDesc')}
              </DialogDescription>
            </DialogHeader>

            {/* Header fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('journal.entryDate')}</label>
                <Input
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('journal.entryReference')}</label>
                <Input
                  placeholder="e.g. INV-001"
                  value={formReference}
                  onChange={(e) => setFormReference(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2 sm:col-start-1">
                <label className="text-sm font-medium">{t('journal.entryDescription')}</label>
                <Input
                  placeholder={t('journal.entryDescription')}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                />
              </div>
            </div>

            {/* Lines table */}
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[45%]">{t('journal.account')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('common.description')}</TableHead>
                    <TableHead className="w-[120px] text-right">{t('accounts.debit')}</TableHead>
                    <TableHead className="w-[120px] text-right">{t('accounts.credit')}</TableHead>
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {formLines.map((line, idx) => (
                    <TableRow key={line.id}>
                      <TableCell>
                        <AccountSelector
                          accounts={accounts}
                          value={line.glAccountId}
                          onChange={(v) => updateLine(line.id, 'glAccountId', v)}
                          placeholder={`${t('journal.selectAccount')} ${idx + 1}`}
                        />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Input
                          value={line.description}
                          onChange={(e) =>
                            updateLine(line.id, 'description', e.target.value)
                          }
                          placeholder="—"
                          className="h-9"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={line.debit || ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            updateLine(line.id, 'debit', val);
                          }}
                          placeholder="0.00"
                          className="h-9 text-right font-mono"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={line.credit || ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            updateLine(line.id, 'credit', val);
                          }}
                          placeholder="0.00"
                          className="h-9 text-right font-mono"
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-red-600"
                          onClick={() => removeLine(line.id)}
                          disabled={formLines.length <= 2}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>
                      <div className="flex items-center justify-between">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={addLine}
                          className="h-7 text-xs"
                        >
                          <Plus className="size-3 mr-1" />
                          {t('journal.addLine')}
                        </Button>
                        <BalanceIndicator balanced={isBalanced} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      {fmt(totalDebits)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      {fmt(totalCredits)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            {/* Actions */}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => handleSave('draft')}
                disabled={saving || formLines.length < 2}
              >
                {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
                {t('journal.saveDraft')}
              </Button>
              <Button
                onClick={() => handleSave('posted')}
                disabled={saving || formLines.length < 2 || !isBalanced}
              >
                {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
                {t('journal.saveAndPost')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Confirmation Dialog ───────────────────────────────────── */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {confirmAction === 'post'
                ? t('journal.confirmPost')
                : t('journal.confirmVoid')}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === 'post'
                ? t('journal.confirmPostDesc')
                : t('journal.confirmVoidDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={actionLoading}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant={confirmAction === 'void' ? 'destructive' : 'default'}
              onClick={executeAction}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="size-4 mr-1 animate-spin" />}
              {confirmAction === 'post'
                ? t('journal.postEntry')
                : t('journal.voidEntry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


