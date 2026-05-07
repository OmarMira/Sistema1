'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload,
  FileSpreadsheet,
  FileText,
  File,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  Clock,
  BarChart3,
  Landmark,
  ArrowLeftRight,
  RefreshCcw,
  FileUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Card,
  CardContent,
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
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';

// ─── Types ────────────────────────────────────────────────────────────

interface BankAccountOption {
  id: string;
  accountName: string;
  bankName: string;
  accountNo: string | null;
}

interface ImportStatement {
  id: string;
  bankAccountId: string;
  bankAccount: { id: string; accountName: string; bankName: string };
  startDate: string;
  endDate: string;
  openingBalance: number;
  closingBalance: number;
  format: string;
  fileName: string | null;
  createdAt: string;
  transactionCount: number;
  autoCategorizedCount: number;
  autoCategorizedPercent: number;
}

interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
}

interface FileResult {
  fileName: string;
  success: boolean;
  transactionCount?: number;
  autoCategorizedCount?: number;
  duplicatesSkipped?: number;
  newAccountCreated?: boolean;
  bankAccountName?: string;
  statementId?: string;
  error?: string;
}

interface MultiImportResult {
  results: FileResult[];
  totalTransactions: number;
  totalFiles: number;
  successCount: number;
  failCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'csv':
    case 'tsv':
      return <FileSpreadsheet className="size-5 text-emerald-500" />;
    case 'ofx':
    case 'qfx':
      return <FileText className="size-5 text-teal-500" />;
    case 'pdf':
      return <File className="size-5 text-red-500" />;
    default:
      return <File className="size-5 text-muted-foreground" />;
  }
}

function getFileIconLarge(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'csv':
    case 'tsv':
      return <FileSpreadsheet className="size-8 text-emerald-500" />;
    case 'ofx':
    case 'qfx':
      return <FileText className="size-8 text-teal-500" />;
    case 'pdf':
      return <File className="size-8 text-red-500" />;
    default:
      return <File className="size-8 text-muted-foreground" />;
  }
}

function getFormatBadge(format: string) {
  const config: Record<string, { className: string; label: string }> = {
    csv: {
      className:
        'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      label: 'CSV',
    },
    ofx: {
      className:
        'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
      label: 'OFX',
    },
    qfx: {
      className:
        'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
      label: 'QFX',
    },
    pdf: {
      className:
        'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      label: 'PDF',
    },
  };
  const c = config[format] || config.csv;
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] font-semibold uppercase', c.className)}
    >
      {c.label}
    </Badge>
  );
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

const ACCEPTED_TYPES = ['.csv', '.tsv', '.txt', '.ofx', '.qfx', '.pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const FORMAT_BADGES: { label: string; className: string }[] = [
  {
    label: 'CSV',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  {
    label: 'OFX',
    className:
      'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  },
  {
    label: 'QFX',
    className:
      'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  },
  {
    label: 'PDF',
    className:
      'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  },
];

// ─── Main Component ───────────────────────────────────────────────────

export function ImportPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  // State
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>('');
  const [history, setHistory] = useState<ImportStatement[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Upload state — multi-file
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');

  // Result dialog — supports both single and multi
  const [resultOpen, setResultOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [multiResult, setMultiResult] = useState<MultiImportResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Fetch data ───────────────────────────────────────────────────

  async function fetchBankAccounts() {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/banks?companyId=${activeCompany.id}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const active = (data.accounts || []).filter(
          (a: { isActive: boolean }) => a.isActive
        );
        setBankAccounts(
          active.map((a: BankAccountOption) => ({
            id: a.id,
            accountName: a.accountName,
            bankName: a.bankName,
            accountNo: a.accountNo,
          }))
        );
      }
    } catch (err) {
      console.error('Failed to fetch bank accounts:', err);
    }
  }

  async function fetchHistory() {
    if (!activeCompany) return;
    setLoadingHistory(true);
    try {
      const res = await fetch(
        `/api/import/history?companyId=${activeCompany.id}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setHistory(data.statements || []);
      }
    } catch (err) {
      console.error('Failed to fetch import history:', err);
    } finally {
      setLoadingHistory(false);
    }
  }

  useEffect(() => {
    fetchBankAccounts();
    fetchHistory();
  }, [activeCompany]);

  // ─── Drag & Drop ─────────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    setUploadError('');

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      addFiles(droppedFiles);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      addFiles(Array.from(files));
    }
  }

  function addFiles(newFiles: File[]) {
    const validatedFiles: File[] = [];
    for (const file of newFiles) {
      const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '');
      if (!ACCEPTED_TYPES.includes(ext)) {
        setUploadError(
          `"${file.name}" — ${t('banks.supportedFormats')}`
        );
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setUploadError(
          `"${file.name}" (${formatFileSize(file.size)}) — Max 10 MB`
        );
        continue;
      }
      validatedFiles.push(file);
    }

    if (validatedFiles.length > 0) {
      setSelectedFiles((prev) => {
        // Merge: add new files, skip duplicates by name+size
        const existing = new Set(prev.map((f) => `${f.name}|${f.size}`));
        const unique = validatedFiles.filter(
          (f) => !existing.has(`${f.name}|${f.size}`)
        );
        return [...prev, ...unique];
      });
    }

    // Clear error if we added at least one file
    if (validatedFiles.length > 0) {
      setUploadError('');
    }
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setUploadError('');
  }

  function clearFiles() {
    setSelectedFiles([]);
    setUploadError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  // ─── Upload ───────────────────────────────────────────────────────

  async function handleUpload() {
    if (selectedFiles.length === 0 || !activeCompany) return;

    setUploading(true);
    setUploadProgress(10);
    setUploadError('');

    try {
      // Simulate progress
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + Math.random() * 15;
        });
      }, 200);

      const formData = new FormData();
      formData.append('companyId', activeCompany.id);
      if (selectedBankAccountId) {
        formData.append('bankAccountId', selectedBankAccountId);
      }

      // If single file, use "file" field for backward compatibility
      // If multiple files, use "files" field
      if (selectedFiles.length === 1) {
        formData.append('file', selectedFiles[0]);
      } else {
        for (const file of selectedFiles) {
          formData.append('files', file);
        }
      }

      const res = await fetch('/api/import', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      clearInterval(progressInterval);
      setUploadProgress(100);

      if (res.ok) {
        const data = await res.json();

        // Check if this is a multi-file response (has "results" array)
        if (data.results && Array.isArray(data.results)) {
          setMultiResult(data as MultiImportResult);
          setImportResult(null);
        } else {
          // Single-file response (backward compatible)
          setImportResult(data as ImportResult);
          setMultiResult(null);
        }

        setResultOpen(true);
        clearFiles();
        fetchBankAccounts();
        fetchHistory();
      } else {
        // Try to parse error from response
        let errorMsg = t('banks.importFailed');
        try {
          const errData = await res.json();
          errorMsg = errData.error || errorMsg;
        } catch {
          // Response wasn't valid JSON
          errorMsg = `Server error (${res.status}): ${res.statusText}`;
        }
        setUploadError(errorMsg);
      }
    } catch (err) {
      setUploadError(t('banks.importFailed'));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          {t('banks.importStatement')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('banks.multipleFiles')}
        </p>
      </div>

      {/* Upload Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-5">
            {/* Drop zone */}
            <div
              className={cn(
                'relative rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer',
                isDragging
                  ? 'border-primary bg-primary/5 scale-[1.01]'
                  : selectedFiles.length > 0
                    ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20'
                    : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50',
                uploading && 'pointer-events-none opacity-60'
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() =>
                !uploading && fileInputRef.current?.click()
              }
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept=".csv,.tsv,.txt,.ofx,.qfx,.pdf"
                onChange={handleFileInput}
              />

              {selectedFiles.length > 0 ? (
                /* Selected files list */
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-3">
                    <div
                      className={cn(
                        'flex size-14 items-center justify-center rounded-full transition-colors',
                        'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400'
                      )}
                    >
                      <Upload className="size-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {t('banks.filesSelected').replace('{count}', String(selectedFiles.length))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {selectedFiles.reduce((sum, f) => sum + f.size, 0) > 0
                          ? `${formatFileSize(selectedFiles.reduce((sum, f) => sum + f.size, 0))} total`
                          : ''}
                      </p>
                    </div>
                    {!uploading && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-red-600"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearFiles();
                        }}
                      >
                        <X className="size-3.5 mr-1" />
                        {t('common.delete')}
                      </Button>
                    )}
                  </div>

                  {/* File list */}
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {selectedFiles.map((file, idx) => (
                      <div
                        key={`${file.name}-${file.size}-${idx}`}
                        className="flex items-center gap-2 rounded-lg bg-background/50 dark:bg-background/30 px-3 py-2"
                      >
                        {getFileIcon(file.name)}
                        <div className="flex-1 min-w-0 text-left">
                          <p className="text-xs font-medium truncate">{file.name}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {formatFileSize(file.size)}
                          </p>
                        </div>
                        {!uploading && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile(idx);
                            }}
                            className="shrink-0 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-600 transition-colors"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Add more hint */}
                  {!uploading && (
                    <p className="text-[10px] text-muted-foreground">
                      {t('banks.dragDrop')}
                    </p>
                  )}
                </div>
              ) : (
                /* Empty drop zone */
                <div className="flex flex-col items-center gap-3">
                  <div
                    className={cn(
                      'flex size-14 items-center justify-center rounded-full transition-colors',
                      isDragging
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    <Upload className="size-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {t('banks.dragDrop')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('banks.supportedFormats')}
                    </p>
                  </div>
                  {/* Prominent format badges */}
                  <div className="flex items-center gap-2 mt-2">
                    {FORMAT_BADGES.map((fmt) => (
                      <Badge
                        key={fmt.label}
                        variant="outline"
                        className={cn(
                          'text-xs font-bold px-3 py-1',
                          fmt.className
                        )}
                      >
                        {fmt.label}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Upload progress */}
            {uploading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" />
                    {selectedFiles.length > 1
                      ? t('banks.fileXOfY').replace('{total}', String(selectedFiles.length))
                      : t('banks.processing')}
                  </span>
                  <span>{Math.round(uploadProgress)}%</span>
                </div>
                <Progress value={uploadProgress} className="h-1.5" />
              </div>
            )}

            {/* Upload error */}
            {uploadError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3">
                <AlertCircle className="size-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700 dark:text-red-400">
                  {uploadError}
                </p>
              </div>
            )}

            {/* Import button */}
            <div className="flex items-center gap-3">
              <Button
                onClick={handleUpload}
                disabled={selectedFiles.length === 0 || uploading}
                className="w-full sm:w-auto h-10 px-6 text-sm font-semibold"
                size="lg"
              >
                {uploading ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    {t('banks.processing')}
                  </>
                ) : (
                  <>
                    <FileUp className="size-4 mr-2" />
                    {t('banks.importStatement')}
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('banks.autoDetect')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Import History */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">
              {t('banks.importHistory')}
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchHistory}
              className="text-muted-foreground"
            >
              <RefreshCcw className="size-3.5 mr-1" />
              {t('common.refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingHistory ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Clock className="size-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                {t('banks.noImportHistory')}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.date')}</TableHead>
                    <TableHead>{t('common.name')}</TableHead>
                    <TableHead>{t('common.type')}</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      {t('banks.title')}
                    </TableHead>
                    <TableHead className="text-center">
                      {t('banks.transactionsImported')}
                    </TableHead>
                    <TableHead className="text-center hidden md:table-cell">
                      {t('banks.autoCategorized')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((stmt) => (
                    <TableRow key={stmt.id}>
                      <TableCell className="font-medium text-sm whitespace-nowrap">
                        {formatDateShort(stmt.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getFileIconLarge(stmt.fileName || 'file.csv')}
                          <span className="text-sm truncate max-w-[150px]">
                            {stmt.fileName || '—'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{getFormatBadge(stmt.format)}</TableCell>
                      <TableCell className="hidden sm:table-cell text-sm">
                        <span className="flex items-center gap-1">
                          <Landmark className="size-3 text-muted-foreground" />
                          {stmt.bankAccount.accountName}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant="outline"
                          className="font-mono text-xs"
                        >
                          {stmt.transactionCount}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center hidden md:table-cell">
                        <div className="flex items-center justify-center gap-1">
                          <BarChart3 className="size-3 text-muted-foreground" />
                          <span
                            className={cn(
                              'text-xs font-medium',
                              stmt.autoCategorizedPercent >= 70
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : stmt.autoCategorizedPercent >= 40
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-muted-foreground'
                            )}
                          >
                            {stmt.autoCategorizedPercent}%
                          </span>
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

      {/* ─── Import Result Dialog (Multi-file) ─────────────────────── */}
      {multiResult && (
        <Dialog open={resultOpen} onOpenChange={setResultOpen}>
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div className={cn(
                  'flex size-8 items-center justify-center rounded-full',
                  multiResult.failCount === 0
                    ? 'bg-emerald-100 dark:bg-emerald-900/40'
                    : multiResult.successCount === 0
                      ? 'bg-red-100 dark:bg-red-900/40'
                      : 'bg-amber-100 dark:bg-amber-900/40'
                )}>
                  {multiResult.failCount === 0 ? (
                    <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
                  ) : multiResult.successCount === 0 ? (
                    <AlertCircle className="size-5 text-red-600 dark:text-red-400" />
                  ) : (
                    <CheckCircle2 className="size-5 text-amber-600 dark:text-amber-400" />
                  )}
                </div>
                {multiResult.failCount === 0
                  ? t('banks.importComplete')
                  : multiResult.successCount === 0
                    ? t('banks.importFailed')
                    : t('banks.importComplete')}
              </DialogTitle>
              <DialogDescription>
                {multiResult.failCount === 0
                  ? t('banks.importSuccessMessage')
                  : t('banks.importPartial')
                    .replace('{success}', String(multiResult.successCount))
                    .replace('{total}', String(multiResult.totalFiles))}
              </DialogDescription>
            </DialogHeader>

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-2xl font-bold font-mono text-teal-600 dark:text-teal-400">
                  {multiResult.totalTransactions}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('banks.transactionsImported')}
                </p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {multiResult.successCount}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('banks.successfulFiles')}
                </p>
              </div>
              {multiResult.failCount > 0 && (
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-2xl font-bold font-mono text-red-600 dark:text-red-400">
                    {multiResult.failCount}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('banks.failedFiles')}
                  </p>
                </div>
              )}
            </div>

            {/* Per-file results */}
            <div className="rounded-lg border max-h-64 overflow-y-auto">
              <div className="divide-y">
                {multiResult.results.map((fr, idx) => (
                  <div
                    key={`${fr.fileName}-${idx}`}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    {getFileIcon(fr.fileName)}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{fr.fileName}</p>
                      {fr.success ? (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                          {fr.transactionCount} {t('banks.transactions').toLowerCase()}
                          {fr.duplicatesSkipped && fr.duplicatesSkipped > 0
                            ? ` · ${fr.duplicatesSkipped} ${t('reconciliation.duplicatesSkipped')}`
                            : ''}
                          {fr.newAccountCreated && (
                            <span className="text-teal-600 dark:text-teal-400"> · {t('banks.newAccountCreated')}</span>
                          )}
                        </p>
                      ) : (
                        <p className="text-xs text-red-600 dark:text-red-400 truncate">
                          {fr.error}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0">
                      {fr.success ? (
                        <CheckCircle2 className="size-4 text-emerald-500" />
                      ) : (
                        <AlertCircle className="size-4 text-red-500" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button
                variant="outline"
                onClick={() => setResultOpen(false)}
                className="w-full sm:w-auto"
              >
                {t('common.cancel')}
              </Button>
              {multiResult.successCount > 0 && (
                <Button
                  onClick={() => {
                    setResultOpen(false);
                    setCurrentView('reconciliation');
                  }}
                  className="w-full sm:w-auto"
                >
                  <ArrowLeftRight className="size-4 mr-1" />
                  {t('banks.goToReconciliation')}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ─── Import Result Dialog (Single-file, backward compatible) ── */}
      {!multiResult && (
        <Dialog open={resultOpen} onOpenChange={setResultOpen}>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                  <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                {t('banks.importSuccess')}
              </DialogTitle>
              <DialogDescription>{t('banks.importSuccessMessage')}</DialogDescription>
            </DialogHeader>

            {importResult && (
              <div className="space-y-4 py-2">
                {/* Summary cards */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3 text-center">
                    <p className="text-2xl font-bold font-mono text-teal-600 dark:text-teal-400">
                      {importResult.transactionCount}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('banks.transactionsImported')}
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 text-center">
                    <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {importResult.transactionCount > 0
                        ? Math.round(
                            (importResult.autoCategorizedCount /
                              importResult.transactionCount) *
                              100
                          )
                        : 0}
                      %
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('banks.autoCategorized')}
                    </p>
                  </div>
                </div>

                {/* Details */}
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {t('banks.autoCategorized')}
                    </span>
                    <span className="font-medium">
                      {importResult.autoCategorizedCount} /{' '}
                      {importResult.transactionCount}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {t('banks.title')}
                    </span>
                    <span className="font-medium">
                      {importResult.bankAccountName}
                    </span>
                  </div>
                  {importResult.newAccountCreated && (
                    <div className="flex items-center gap-2 rounded-md bg-teal-50 dark:bg-teal-950/30 p-2 text-sm">
                      <Landmark className="size-4 text-teal-600 dark:text-teal-400" />
                      <span className="text-teal-700 dark:text-teal-300">
                        {t('banks.newAccountCreated')}
                      </span>
                    </div>
                  )}
                  {importResult.duplicatesSkipped > 0 && (
                    <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 p-2 text-sm">
                      <AlertCircle className="size-4 text-amber-600 dark:text-amber-400" />
                      <span className="text-amber-700 dark:text-amber-300">
                        {importResult.duplicatesSkipped} {t('reconciliation.duplicatesSkipped')}
                      </span>
                    </div>
                  )}
                </div>

                {/* Categorization bar */}
                {importResult.transactionCount > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      {t('banks.categorizationProgress')}
                    </p>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                        style={{
                          width: `${
                            importResult.transactionCount > 0
                              ? (importResult.autoCategorizedCount /
                                  importResult.transactionCount) *
                                100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    {importResult.autoCategorizedCount <
                      importResult.transactionCount && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        {importResult.transactionCount -
                          importResult.autoCategorizedCount}{' '}
                        {t('banks.transactions').toLowerCase()}{' '}
                        {t('banks.uncategorizedNote')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button
                variant="outline"
                onClick={() => setResultOpen(false)}
                className="w-full sm:w-auto"
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  setResultOpen(false);
                  setCurrentView('reconciliation');
                }}
                className="w-full sm:w-auto"
              >
                <ArrowLeftRight className="size-4 mr-1" />
                {t('banks.goToReconciliation')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
