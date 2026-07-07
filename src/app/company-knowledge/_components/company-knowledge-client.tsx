'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Search,
  Loader2,
  Building2,
  Archive,
  RotateCcw,
  ArrowLeftRight,
  Pencil,
  Eye,
} from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import type { CompanyKnowledgeRecord } from '@/internal/company-knowledge/entity/types';
import { EntityTypeValues } from '@/internal/company-knowledge/entity/types';
import { MergeDialog } from './merge-dialog';

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const statusColorMap: Record<string, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100',
  archived: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100',
  merged: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
};

const entityTypeLabels: Record<string, string> = {
  person: 'Person',
  company: 'Company',
  financial_product: 'Financial Product',
  platform: 'Platform',
  asset: 'Asset',
};

interface CompanyKnowledgeClientProps {
  initialRecords: CompanyKnowledgeRecord[];
  initialTotal: number;
}

export function CompanyKnowledgeClient({
  initialRecords,
  initialTotal,
}: CompanyKnowledgeClientProps) {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const router = useRouter();

  // ── State ──
  const [records, setRecords] = useState<CompanyKnowledgeRecord[]>(initialRecords);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 20,
    total: initialTotal,
    totalPages: Math.ceil(initialTotal / 20),
  });

  // ── Merge dialog state ──
  const [mergeTarget, setMergeTarget] = useState<CompanyKnowledgeRecord | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);

  const companyId = activeCompany?.id;

  // ── Fetch records ──
  const fetchRecords = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId });
      if (filterType !== 'all') params.set('type', filterType);
      if (filterStatus !== 'all') params.set('status', filterStatus);
      if (search.trim()) params.set('search', search.trim());
      params.set('page', page.toString());
      params.set('limit', '20');

      const res = await fetch(`/api/company-knowledge?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setRecords(data.data || []);
      setPagination(data.pagination || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } catch (err) {
      console.error('[CompanyKnowledge] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [companyId, filterType, filterStatus, search, page]);

  useEffect(() => {
    if (companyId) fetchRecords();
  }, [fetchRecords, companyId]);

  // ── Actions ──
  const handleArchive = async (record: CompanyKnowledgeRecord) => {
    if (!companyId) return;
    if (!confirm(`Archive "${record.canonicalName}"?`)) return;

    try {
      const res = await fetch(`/api/company-knowledge/${record.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          changedByUserId: 'current-user',
        }),
      });
      if (!res.ok) throw new Error('Archive failed');
      fetchRecords();
    } catch (err) {
      console.error('[CompanyKnowledge] archive error:', err);
    }
  };

  const handleRestore = async (record: CompanyKnowledgeRecord) => {
    if (!companyId) return;

    try {
      const res = await fetch(`/api/company-knowledge/${record.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          changedByUserId: 'current-user',
        }),
      });
      if (!res.ok) throw new Error('Restore failed');
      fetchRecords();
    } catch (err) {
      console.error('[CompanyKnowledge] restore error:', err);
    }
  };

  const handleOpenMerge = (record: CompanyKnowledgeRecord) => {
    setMergeTarget(record);
    setMergeOpen(true);
  };

  const handleMergeComplete = () => {
    setMergeOpen(false);
    setMergeTarget(null);
    fetchRecords();
  };

  // ── Render ──
  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Company Knowledge</h1>
          <p className="text-sm text-muted-foreground">
            Manage verified entities and business relationships
          </p>
        </div>
        <Button onClick={() => router.push('/company-knowledge/new')}>
          <Plus className="mr-2 h-4 w-4" />
          New Entity
        </Button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 max-w-sm"
          />
        </div>
        <Select value={filterType} onValueChange={(v) => { setFilterType(v); setPage(1); }}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {EntityTypeValues.map((type) => (
              <SelectItem key={type} value={type}>
                {entityTypeLabels[type] ?? type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="merged">Merged</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Relationship</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : records.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Building2 className="mx-auto mb-2 h-8 w-8 opacity-50" />
                  No entities found. Create your first entity to get started.
                </TableCell>
              </TableRow>
            ) : (
              records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-medium">{record.canonicalName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {entityTypeLabels[record.type] ?? record.type}
                    </Badge>
                  </TableCell>
                  <TableCell>{record.relationship ?? '—'}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        statusColorMap[record.status] ?? ''
                      }`}
                    >
                      {record.status}
                    </span>
                  </TableCell>
                  <TableCell>{record.version}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => router.push(`/company-knowledge/${record.id}`)}
                        title="View details"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => router.push(`/company-knowledge/${record.id}/edit`)}
                        title="Edit"
                        disabled={record.status !== 'active'}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {record.status === 'active' && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleArchive(record)}
                            title="Archive"
                          >
                            <Archive className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleOpenMerge(record)}
                            title="Merge"
                          >
                            <ArrowLeftRight className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {record.status === 'archived' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRestore(record)}
                          title="Restore"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="mt-4">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className={page <= 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                />
              </PaginationItem>
              {Array.from({ length: pagination.totalPages }, (_, i) => i + 1)
                .filter((p) => Math.abs(p - page) <= 2 || p === 1 || p === pagination.totalPages)
                .map((p, idx, arr) => (
                  <PaginationItem key={p}>
                    {idx > 0 && arr[idx - 1] !== p - 1 && (
                      <span className="px-1 text-muted-foreground">...</span>
                    )}
                    <PaginationLink
                      onClick={() => setPage(p)}
                      isActive={p === page}
                      className="cursor-pointer"
                    >
                      {p}
                    </PaginationLink>
                  </PaginationItem>
                ))}
              <PaginationItem>
                <PaginationNext
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                  className={page >= pagination.totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}

      {/* Merge Dialog */}
      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        sourceRecord={mergeTarget}
        companyId={companyId ?? ''}
        onComplete={handleMergeComplete}
      />
    </div>
  );
}
