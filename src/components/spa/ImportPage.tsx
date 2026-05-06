'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload,
  FileSpreadsheet,
  FileText,
  File,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  X,
  Clock,
  BarChart3,
  Landmark,
  ArrowLeftRight,
  RefreshCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
  newAccountCreated: boolean;
  bankAccountName: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fmtCurrency(amount: number): string {
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
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
      className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      label: 'CSV',
    },
    ofx: {
      className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
      label: 'OFX',
    },
    qfx: {
      className: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
      label: 'QFX',
    },
    pdf: {
      className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      label: 'PDF',
    },
  };
  const c = config[format] || config.csv;
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold uppercase', c.className)}>
      {c.label}
    </Badge>
  );
}

const ACCEPTED_TYPES = [
  '.csv',
  '.tsv',
  '.txt',
  '.ofx',
  '.qfx',
  '.pdf',
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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

  // Upload state
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');

  // Result dialog
  const [resultOpen, setResultOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Fetch data ───────────────────────────────────────────────────

  async function fetchBankAccounts() {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/banks?companyId=${activeCompany.id}`);
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
        `/api/import/history?companyId=${activeCompany.id}`
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

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      validateAndSetFile(files[0]);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      validateAndSetFile(files[0]);
    }
  }

  function validateAndSetFile(file: File) {
    const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '');
    if (!ACCEPTED_TYPES.includes(ext)) {
      setUploadError(
        `Unsupported file type "${ext}". Supported: .csv, .ofx, .qfx, .pdf`
      );
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setUploadError('File is too large. Maximum size is 10 MB.');
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setUploadError('');
  }

  function clearFile() {
    setSelectedFile(null);
    setUploadError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  // ─── Upload ───────────────────────────────────────────────────────

  async function handleUpload() {
    if (!selectedFile || !activeCompany) return;

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
      formData.append('file', selectedFile);
      formData.append('companyId', activeCompany.id);
      if (selectedBankAccountId) {
        formData.append('bankAccountId', selectedBankAccountId);
      }

      const res = await fetch('/api/import', {
        method: 'POST',
        body: formData,
      });

      clearInterval(progressInterval);
      setUploadProgress(100);

      if (res.ok) {
        const data: ImportResult = await res.json();
        setImportResult(data);
        setResultOpen(true);
        clearFile();
        fetchBankAccounts();
        fetchHistory();
      } else {
        const err = await res.json();
        setUploadError(err.error || 'Import failed');
      }
    } catch (err) {
      console.error('Upload error:', err);
      setUploadError('An unexpected error occurred during import');
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
          {t('banks.uploadStatement')}
        </h2>
        <p className="text-sm text-muted-foreground">
          Import bank statements from CSV, OFX, or QFX files
        </p>
      </div>

      {/* Upload Area */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              className={cn(
                'relative rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer',
                isDragging
                  ? 'border-primary bg-primary/5 scale-[1.01]'
                  : selectedFile
                    ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20'
                    : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50',
                uploading && 'pointer-events-none opacity-60'
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !selectedFile && !uploading && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".csv,.tsv,.txt,.ofx,.qfx,.pdf"
                onChange={handleFileInput}
              />

              {selectedFile ? (
                /* Selected file preview */
                <div className="flex flex-col items-center gap-3">
                  {getFileIcon(selectedFile.name)}
                  <div>
                    <p className="text-sm font-medium">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(selectedFile.size)}
                    </p>
                  </div>
                  {!uploading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-red-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearFile();
                      }}
                    >
                      <X className="size-3.5 mr-1" />
                      Remove
                    </Button>
                  )}
                </div>
              ) : (
                /* Empty drop zone */
                <div className="flex flex-col items-center gap-3">
                  <div className={cn(
                    'flex size-14 items-center justify-center rounded-full transition-colors',
                    isDragging
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  )}>
                    <Upload className="size-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {isDragging
                        ? 'Drop your file here'
                        : 'Drag & drop a file here, or click to browse'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Supported formats: .csv, .ofx, .qfx, .pdf (max 10 MB)
                    </p>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {['CSV', 'OFX', 'QFX'].map((fmt) => (
                      <Badge key={fmt} variant="outline" className="text-[10px]">
                        {fmt}
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
                    Processing...
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
                <p className="text-sm text-red-700 dark:text-red-400">{uploadError}</p>
              </div>
            )}

            {/* Bank account selector */}
            <div className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="space-y-1.5 flex-1 w-full sm:max-w-[300px]">
                <label className="text-sm font-medium">
                  Import to Bank Account
                </label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className={cn(
                        'w-full justify-between font-normal h-9',
                        !selectedBankAccountId && 'text-muted-foreground'
                      )}
                    >
                      {selectedBankAccountId
                        ? bankAccounts.find((a) => a.id === selectedBankAccountId)
                            ?.accountName
                        : 'Auto-detect or select...'}
                      <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search bank accounts..." />
                      <CommandList className="max-h-[250px]">
                        <CommandEmpty>No bank accounts found</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="__auto"
                            onSelect={() => setSelectedBankAccountId('')}
                          >
                            <Check
                              className={cn(
                                'mr-2 size-4 shrink-0',
                                !selectedBankAccountId
                                  ? 'opacity-100'
                                  : 'opacity-0'
                              )}
                            />
                            <span className="flex items-center gap-2">
                              <Landmark className="size-3.5 text-muted-foreground" />
                              Auto-detect from file
                            </span>
                          </CommandItem>
                          {bankAccounts.map((account) => (
                            <CommandItem
                              key={account.id}
                              value={`${account.bankName} ${account.accountName}`}
                              onSelect={() =>
                                setSelectedBankAccountId(
                                  account.id === selectedBankAccountId
                                    ? ''
                                    : account.id
                                )
                              }
                            >
                              <Check
                                className={cn(
                                  'mr-2 size-4 shrink-0',
                                  selectedBankAccountId === account.id
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                              <span className="truncate">
                                {account.bankName} — {account.accountName}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <Button
                onClick={handleUpload}
                disabled={!selectedFile || uploading}
                className="w-full sm:w-auto"
              >
                {uploading ? (
                  <>
                    <Loader2 className="size-4 mr-1 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Upload className="size-4 mr-1" />
                    Import Statement
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Import History */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Import History</h3>
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

        {loadingHistory ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : history.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Clock className="size-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                No import history yet. Upload your first bank statement above.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.date')}</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead className="hidden sm:table-cell">Bank Account</TableHead>
                  <TableHead className="text-center">Transactions</TableHead>
                  <TableHead className="text-center hidden md:table-cell">Auto-cat.</TableHead>
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
                        {getFileIcon(stmt.fileName || 'file.csv')}
                        <span className="text-sm truncate max-w-[150px]">
                          {stmt.fileName || 'Unknown'}
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
                      <Badge variant="outline" className="font-mono text-xs">
                        {stmt.transactionCount}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      <div className="flex items-center justify-center gap-1">
                        <BarChart3 className="size-3 text-muted-foreground" />
                        <span className={cn(
                          'text-xs font-medium',
                          stmt.autoCategorizedPercent >= 70
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : stmt.autoCategorizedPercent >= 40
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground'
                        )}>
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
      </div>

      {/* ─── Import Result Dialog ───────────────────────────────────── */}
      <Dialog open={resultOpen} onOpenChange={setResultOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              Import Successful
            </DialogTitle>
            <DialogDescription>
              Your bank statement has been imported and transactions have been created.
            </DialogDescription>
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
                    Transactions Imported
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
                    Auto-Categorized
                  </p>
                </div>
              </div>

              {/* Details */}
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Auto-categorized transactions
                  </span>
                  <span className="font-medium">
                    {importResult.autoCategorizedCount} / {importResult.transactionCount}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Bank Account</span>
                  <span className="font-medium">
                    {importResult.bankAccountName}
                  </span>
                </div>
                {importResult.newAccountCreated && (
                  <div className="flex items-center gap-2 rounded-md bg-teal-50 dark:bg-teal-950/30 p-2 text-sm">
                    <Landmark className="size-4 text-teal-600 dark:text-teal-400" />
                    <span className="text-teal-700 dark:text-teal-300">
                      A new bank account was auto-created
                    </span>
                  </div>
                )}
              </div>

              {/* Categorization bar */}
              {importResult.transactionCount > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Categorization Progress
                  </p>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                      style={{
                        width: `${importResult.transactionCount > 0
                          ? (importResult.autoCategorizedCount / importResult.transactionCount) * 100
                          : 0
                          }%`,
                      }}
                    />
                  </div>
                  {importResult.autoCategorizedCount < importResult.transactionCount && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {importResult.transactionCount - importResult.autoCategorizedCount} transaction
                      {importResult.transactionCount - importResult.autoCategorizedCount !== 1 ? 's' : ''} need
                      manual categorization. Set up bank rules to improve auto-categorization.
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
              Close
            </Button>
            <Button
              onClick={() => {
                setResultOpen(false);
                setCurrentView('reconciliation');
              }}
              className="w-full sm:w-auto"
            >
              <ArrowLeftRight className="size-4 mr-1" />
              Go to Reconciliation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
