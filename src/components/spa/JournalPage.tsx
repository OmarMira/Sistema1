'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Plus,
  Loader2,
  FileText,
  Eye,
  Pencil,
  SendHorizontal,
  Ban,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { isPeriodLocked } from '@/lib/fiscal-period/utils';
import { logger } from '@/lib/logger';
import { toast } from 'sonner';
import {
  JournalFilters,
  JournalDetailView,
  JournalFormDialog,
  ConfirmActionDialog,
  StatusBadge,
  fmt,
  formatDate,
  type JournalLineData,
} from './journal';
import type { GlAccountOption } from './journal/AccountSelector';

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

export type { JournalEntry, JournalEntryLine, JournalLineData };

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
  const [fiscalPeriods, setFiscalPeriods] = useState<{ id: string; name: string; startDate: string; endDate: string; isLocked: boolean }[]>([]);

  const fetchFiscalPeriods = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/settings?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setFiscalPeriods(data.periods || []);
      }
    } catch (err) {
      logger.error('Failed to fetch fiscal periods:', { error: String(err) });
    }
  }, [activeCompany]);

  // Confirmation dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'post' | 'void' | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
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
      logger.error('Failed to fetch entries:', { error: String(err) });
    } finally {
      setLoading(false);
    }
  }, [activeCompany, statusFilter, searchQuery, startDate, endDate]);

  const fetchAccounts = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/journal/accounts?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data);
      }
    } catch (err) {
      logger.error('Failed to fetch accounts:', { error: String(err) });
    }
  }, [activeCompany]);

  useEffect(() => {
    fetchAccounts();
    fetchFiscalPeriods();
  }, [fetchAccounts, fetchFiscalPeriods]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  function handleSearchChange(val: string) {
    setSearchQuery(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => fetchEntries(), 400);
  }

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
      })),
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

  function updateLine(lineId: string, field: keyof JournalLineData, value: unknown) {
    setFormLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, [field]: value } : l)));
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
      toast.error(validationError);
      return;
    }

    const entryDate = new Date(formDate);
    if (isPeriodLocked(entryDate, fiscalPeriods)) {
      toast.error('No se pueden registrar asientos en períodos fiscales cerrados. Contacte a auditoría.');
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

      const url = editingEntryId ? `/api/journal/${editingEntryId}` : '/api/journal';
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
          const data = await res.json();
          setSelectedEntry(data);
        }
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to save');
      }
    } catch (err) {
      logger.error('Save error:', { error: String(err) });
    } finally {
      setSaving(false);
    }
  }

  function requestAction(entryId: string, action: 'post' | 'void') {
    setConfirmAction(action);
    setConfirmTarget(entryId);
    setConfirmOpen(true);
  }

  async function executeAction() {
    if (!confirmTarget || !confirmAction) return;

    if (confirmAction === 'post') {
      const entryToPost = entries.find((e) => e.id === confirmTarget);
      if (entryToPost && isPeriodLocked(new Date(entryToPost.date), fiscalPeriods)) {
        toast.error('No se pueden postear asientos en períodos fiscales cerrados.');
        setConfirmOpen(false);
        return;
      }
    }

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
        toast.error(err.error || 'Action failed');
      }
    } catch (err) {
      logger.error('Action error:', { error: String(err) });
    } finally {
      setActionLoading(false);
      setConfirmOpen(false);
      setConfirmAction(null);
      setConfirmTarget(null);
    }
  }

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
      logger.error('Failed to refresh entry:', { error: String(err) });
    }
  }

  const detailTotalDebits = selectedEntry?.lines.reduce((s, l) => s + l.debit, 0) ?? 0;
  const detailTotalCredits = selectedEntry?.lines.reduce((s, l) => s + l.credit, 0) ?? 0;
  const detailBalanced = Math.abs(detailTotalDebits - detailTotalCredits) < 0.005;

  if (viewMode === 'detail' && selectedEntry) {
    return (
      <JournalDetailView
        entry={selectedEntry}
        onBack={() => {
          setViewMode('list');
          setSelectedEntry(null);
        }}
        onEdit={openEditModal}
        onPost={(id) => requestAction(id, 'post')}
        onVoid={(id) => requestAction(id, 'void')}
        totalDebits={detailTotalDebits}
        totalCredits={detailTotalCredits}
        balanced={detailBalanced}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t('journal.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('journal.subtitle')}</p>
        </div>
        <Button onClick={openNewModal}>
          <Plus className="size-4 mr-1" />
          {t('journal.newEntry')}
        </Button>
      </div>

      <JournalFilters
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        startDate={startDate}
        onStartDateChange={setStartDate}
        endDate={endDate}
        onEndDateChange={setEndDate}
        onClearFilters={() => {
          setStatusFilter('all');
          setStartDate('');
          setEndDate('');
        }}
      />

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
                <TableHead className="text-right hidden md:table-cell">
                  {t('journal.debitTotal')}
                </TableHead>
                <TableHead className="text-right hidden md:table-cell">
                  {t('journal.creditTotal')}
                </TableHead>
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
                  <TableCell className="font-medium">{formatDate(entry.date)}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {entry.reference || '—'}
                  </TableCell>
                  <TableCell className="max-w-[250px] truncate">{entry.description}</TableCell>
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
                            <SendHorizontal className="size-3.5" />
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

      <JournalFormDialog
        open={modalOpen}
        onOpenChange={(val) => {
          setModalOpen(val);
          if (!val) setEditingEntryId(null);
        }}
        editingEntryId={editingEntryId}
        formDate={formDate}
        onFormDateChange={setFormDate}
        formDescription={formDescription}
        onFormDescriptionChange={setFormDescription}
        formReference={formReference}
        onFormReferenceChange={setFormReference}
        formLines={formLines}
        accounts={accounts}
        onAddLine={addLine}
        onRemoveLine={removeLine}
        onUpdateLine={updateLine}
        totalDebits={totalDebits}
        totalCredits={totalCredits}
        isBalanced={isBalanced}
        saving={saving}
        onSave={handleSave}
      />

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        action={confirmAction}
        loading={actionLoading}
        onConfirm={executeAction}
      />
    </div>
  );
}
