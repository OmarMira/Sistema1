'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Trash2, Loader2, Plus } from 'lucide-react';
import { UI_ROLES } from '@/lib/constants/entity-roles';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';

interface EntityItem {
  id: string;
  pattern: string;
  role: string;
  source: string;
  createdAt: string;
  isCandidate?: boolean;
  occurrences?: number;
  userDescription?: string | null;
}

interface PaginatedResponse {
  data: EntityItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const ROLES = UI_ROLES.map((role) => ({
  value: role,
  key: `entityManagement.role.${role}`,
}));

export function EntityManagementPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [entities, setEntities] = useState<EntityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editEntity, setEditEntity] = useState<EntityItem | null>(null);
  const [editRole, setEditRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [entityLookup, setEntityLookup] = useState<Record<string, EntityItem>>({});

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createPattern, setCreatePattern] = useState('');
  const [createRole, setCreateRole] = useState('');
  const [createGlAccountId, setCreateGlAccountId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const loadEntities = useCallback(async (p: number) => {
    if (!activeCompany?.id) return;
    setLoading(true);
    try {
      const roleQuery = roleFilter !== 'all' ? `&role=${roleFilter}` : '';
      const searchQuery = search.trim() ? `&search=${encodeURIComponent(search.trim())}` : '';
      const res = await fetch(`/api/entity-context?page=${p}&limit=20&sortBy=createdAt&sortDir=desc${searchQuery}${roleQuery}&companyId=${activeCompany.id}`);
      if (!res.ok) throw new Error('loadFailed');
      const json: PaginatedResponse = await res.json();
      const data = json.data || [];
      setEntities(data);
      setPage(json.pagination.page);
      setTotalPages(json.pagination.totalPages);

      setEntityLookup((prev) => {
        const next = { ...prev };
        data.forEach((item) => {
          next[item.id] = item;
        });
        return next;
      });
    } catch {
      toast.error(t('entityManagement.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t, search, roleFilter, activeCompany?.id]);

  useEffect(() => {
    loadEntities(1);
  }, [loadEntities]);

  useEffect(() => {
    if (!editEntity) return;
    setEditRole(editEntity.role || '');
  }, [editEntity]);

  const handleSaveEdit = async () => {
    if (!editEntity) return;
    setSaving(true);
    try {
      if (editRole === editEntity.role) {
        setEditEntity(null);
        setSaving(false);
        return;
      }
      const res = await fetch(`/api/entity-context/${editEntity.id}?companyId=${activeCompany?.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: editRole }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'updateFailed');
      }
      toast.success(t('common.success'));
      setEditEntity(null);
      loadEntities(page);
    } catch {
      toast.error(t('entityManagement.errors.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/entity-context/${id}?companyId=${activeCompany?.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('deleteFailed');
      toast.success(t('common.success'));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      loadEntities(page);
    } catch {
      toast.error(t('entityManagement.errors.deleteFailed'));
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    setBulkDeleting(true);
    try {
      const selectedIds = Array.from(selected);
      const res = await fetch('/api/entity-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds, companyId: activeCompany?.id }),
      });
      if (!res.ok) throw new Error('bulkDeleteFailed');

      toast.success(t('common.success'));
      setSelected(new Set());
      loadEntities(page);
    } catch {
      toast.error(t('entityManagement.errors.bulkDeleteFailed'));
    } finally {
      setBulkDeleting(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allSelected = entities.every((e) => selected.has(e.id));
    if (allSelected && entities.length > 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        entities.forEach((e) => next.delete(e.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        entities.forEach((e) => next.add(e.id));
        return next;
      });
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  // ─── Fetch accounts for AccountSelector ─────────────────────────────
  const fetchAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    setLoadingAccounts(true);
    try {
      const res = await fetch(`/api/accounts?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data ?? data);
      }
    } catch {
      // silent
    } finally {
      setLoadingAccounts(false);
    }
  }, [activeCompany]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // ─── Create entity handler ──────────────────────────────────────────
  const handleCreateEntity = async () => {
    if (!createPattern.trim() || !createRole) {
      toast.error(t('entityManagement.create.validationError'));
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/learning/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: createPattern.trim(),
          role: createRole,
          glAccountId: createGlAccountId ?? undefined,
        }),
      });

      if (res.status === 409) {
        toast.error(t('entityManagement.create.duplicateError'));
        return;
      }

      if (!res.ok) throw new Error('createFailed');

      toast.success(t('entityManagement.create.success'));
      setCreateDialogOpen(false);
      setCreatePattern('');
      setCreateRole('');
      setCreateGlAccountId(null);
      loadEntities(page);
    } catch {
      toast.error(t('entityManagement.create.duplicateError'));
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('entityManagement.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('entityManagement.description')}</p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5 flex-1 max-w-sm">
            <label className="text-xs font-medium text-muted-foreground">
              {t('entityManagement.search.label')}
            </label>
            <Input
              placeholder={t('entityManagement.search.placeholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5 w-full sm:w-48">
            <label className="text-xs font-medium text-muted-foreground">
              {t('entityManagement.filter.roleLabel')}
            </label>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('entityManagement.filter.allRoles')}</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {t(r.key as string)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 size-4" />
          {t('entityManagement.create.title')}
        </Button>
      </div>

      {entities.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <p className="text-muted-foreground">{t('entityManagement.emptyState')}</p>
        </div>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="flex items-center gap-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={bulkDeleting}>
                    {bulkDeleting && <Loader2 className="mr-2 size-4 animate-spin" />}
                    {t('entityManagement.actions.bulkDelete')} ({selected.size})
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('entityManagement.bulkDelete.title')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('entityManagement.bulkDelete.confirm').replace('{count}', String(selected.size))}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleBulkDelete}>
                      {t('common.delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        entities.length > 0 &&
                        entities.every((e) => selected.has(e.id))
                      }
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead>{t('entityManagement.columns.pattern')}</TableHead>
                  <TableHead>{t('entityManagement.columns.role')}</TableHead>
                  <TableHead>{t('entityManagement.columns.description')}</TableHead>
                  <TableHead>{t('entityManagement.columns.source')}</TableHead>
                  <TableHead>{t('entityManagement.columns.createdAt')}</TableHead>
                  <TableHead className="w-16">{t('entityManagement.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entities.map((entity) => (
                  <TableRow
                    key={entity.id}
                    className="cursor-pointer select-none"
                    onDoubleClick={() => setEditEntity(entity)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(entity.id)}
                        onCheckedChange={() => toggleSelect(entity.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{entity.pattern}</TableCell>
                    <TableCell>
                      {entity.role
                        ? (ROLES.some((r) => r.value === entity.role) ? t(`entityManagement.role.${entity.role}` as string) : entity.role)
                        : '-'}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-muted-foreground">
                      {entity.userDescription || '-'}
                    </TableCell>
                    <TableCell>{entity.source}</TableCell>
                    <TableCell>{formatDate(entity.createdAt)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('entityManagement.delete.title')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('entityManagement.delete.confirm')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(entity.id)}>
                              {t('common.delete')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => loadEntities(page - 1)}
              >
                {t('common.previous')}
              </Button>
              <span className="text-sm text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => loadEntities(page + 1)}
              >
                {t('common.next')}
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={!!editEntity} onOpenChange={(open) => { if (!open) setEditEntity(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('entityManagement.edit.title')}</DialogTitle>
            <DialogDescription>{editEntity?.pattern}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('entityManagement.edit.roleLabel')}
              </label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {t(r.key as string)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {t('entityManagement.warning.combinedRules')}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditEntity(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('entityManagement.edit.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Create Entity Dialog ─────────────────────────────────────── */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateDialogOpen(false);
            setCreatePattern('');
            setCreateRole('');
            setCreateGlAccountId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('entityManagement.create.title')}</DialogTitle>
            <DialogDescription>
              {t('entityManagement.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('entityManagement.create.patternLabel')}
              </label>
              <Input
                value={createPattern}
                onChange={(e) => setCreatePattern(e.target.value)}
                placeholder={t('entityManagement.search.placeholder')}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('entityManagement.create.roleLabel')}
              </label>
              <Select value={createRole} onValueChange={setCreateRole}>
                <SelectTrigger>
                  <SelectValue placeholder={t('learning.rolePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {t(r.key as string)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('entityManagement.create.glAccountLabel')}
              </label>
              {loadingAccounts ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span>{t('learning.loadingAccounts')}</span>
                </div>
              ) : (
                <AccountSelector
                  accounts={accounts}
                  value={createGlAccountId}
                  onChange={setCreateGlAccountId}
                  placeholder={t('learning.accountPlaceholder')}
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateDialogOpen(false);
                setCreatePattern('');
                setCreateRole('');
                setCreateGlAccountId(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateEntity} disabled={creating}>
              {creating && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('entityManagement.create.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
