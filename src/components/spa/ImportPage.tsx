'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Loader2,
  AlertCircle,
  Clock,
  BarChart3,
  Landmark,
  RefreshCcw,
  FileUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AccountSelector, type GlAccountOption } from './journal/AccountSelector';
import { EntityOnboardingModal } from '@/components/learning/EntityOnboardingModal';
import { logger } from '@/lib/logger';
import { ImportDropZone } from '@/components/import/ImportDropZone';
import { ImportResultDialog } from '@/components/import/ImportResultDialog';
import { MismatchWarningDialog } from '@/components/import/MismatchWarningDialog';
import {
  type BankAccountOption,
  type ImportStatement,
  type ImportResult,
  type ValidationResult,
  type GlAccountData,
  CURRENCIES,
  getFileIcon,
  getFormatBadge,
  formatDateShort,
} from '@/lib/types/import-page';

// ─── Main Component ───────────────────────────────────────────────────

export function ImportPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  const startProcessing = useAuthStore((s) => s.startProcessing);
  const stopProcessing = useAuthStore((s) => s.stopProcessing);

  // State
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>('');
  const [history, setHistory] = useState<ImportStatement[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Bank Account Creation Modal State (when required by the import)
  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [formAccountName, setFormAccountName] = useState('');
  const [formBankName, setFormBankName] = useState('');
  const [formAccountNo, setFormAccountNo] = useState('');
  const [formRoutingNo, setFormRoutingNo] = useState('');
  const [formGlOption, setFormGlOption] = useState<'create' | 'link'>('create');
  const [formGlAccountId, setFormGlAccountId] = useState<string | null>(null);
  const [formBalance, setFormBalance] = useState('');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formError, setFormError] = useState('');
  const [savingBank, setSavingBank] = useState(false);
  const [assetAccounts, setAssetAccounts] = useState<GlAccountOption[]>([]);

  // Upload state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');

  // Result dialog
  const [resultOpen, setResultOpen] = useState(false);
  const [entityOnboardingOpen, setEntityOnboardingOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // Mismatch warning dialog states
  const [mismatchFiles, setMismatchFiles] = useState<
    { fileName: string; extractedHolder: string; score: number }[]
  >([]);
  const [mismatchModalOpen, setMismatchModalOpen] = useState(false);
  const [isStrict, setIsStrict] = useState(false);

  // ─── Helpers ────────────────────────────────────────────────────────
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

  // ─── Fetch data ───────────────────────────────────────────────────

  const fetchBankAccounts = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/banks?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        const active = (data.accounts || []).filter((a: { isActive: boolean }) => a.isActive);
        setBankAccounts(
          active.map((a: BankAccountOption) => ({
            id: a.id,
            accountName: a.accountName,
            bankName: a.bankName,
            accountNo: a.accountNo,
          })),
        );
      }
    } catch (err) {
      logger.error('Failed to fetch bank accounts:', { error: String(err) });
    }
  }, [activeCompany]);

  const fetchAssetAccounts = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/journal/accounts?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAssetAccounts(
          (data.data || data.accounts || []).filter(
            (a: GlAccountOption) => a.accountType === 'asset',
          ),
        );
      }
    } catch (err) {
      logger.error('Failed to fetch GL accounts:', { error: String(err) });
    }
  }, [activeCompany]);

  const fetchHistory = useCallback(async () => {
    if (!activeCompany) return;
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/import/history?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data.statements || []);
      }
    } catch (err) {
      logger.error('Failed to fetch import history:', { error: String(err) });
    } finally {
      setLoadingHistory(false);
    }
  }, [activeCompany]);

  useEffect(() => {
    fetchBankAccounts();
    fetchHistory();
    fetchAssetAccounts();
  }, [fetchBankAccounts, fetchHistory, fetchAssetAccounts]);

  // ─── Handlers ────────────────────────────────────────────────────

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function clearFiles() {
    setSelectedFiles([]);
    setUploadError('');
  }

  function handleFilesAdded(files: File[]) {
    setSelectedFiles((prev) => [...prev, ...files]);
  }

  function handleUploadError(error: string) {
    setUploadError(error);
  }

  // ─── Upload ───────────────────────────────────────────────────────

  const handleRejectMismatches = () => {
    setMismatchModalOpen(false);
    setSelectedFiles([]);
  };

  function handleAcceptMismatch() {
    setMismatchModalOpen(false);
    handleUpload(true);
  }

  async function handleUpload(forceBypass: boolean = false) {
    if (selectedFiles.length === 0 || !activeCompany) return;

    // 1. Pre-validate account holder name for PDF statement files
    const pdfFiles = selectedFiles.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfFiles.length > 0 && !forceBypass) {
      setUploading(true);
      startProcessing(t('bankRules.processing.validatingHolder'));
      try {
        const valData = new FormData();
        valData.append('companyId', activeCompany.id);
        selectedFiles.forEach((f) => valData.append('files', f));

        const valRes = await fetch('/api/import/validate', {
          method: 'POST',
          body: valData,
        });

        if (valRes.ok) {
          const valResult = await valRes.json();
          const mismatches = valResult.results.filter((r: ValidationResult) => r.requiresApproval);

          if (mismatches.length > 0) {
            setIsStrict(valResult.strictMode || false);
            setMismatchFiles(
              mismatches.map((m: ValidationResult) => ({
                fileName: m.fileName,
                extractedHolder: m.extractedHolder,
                score: Math.round(m.score * 100),
              })),
            );
            setMismatchModalOpen(true);
            setUploading(false);
            stopProcessing();
            return;
          }
        }
      } catch (err) {
        logger.error('Validation failed:', { error: String(err) });
      } finally {
        setUploading(false);
        stopProcessing();
      }
    }

    setUploading(true);
    setUploadProgress(5);
    setUploadError('');
    startProcessing(t('bankRules.processing.importingStatement'));

    try {
      let totalTransactions = 0;
      let totalAutoCategorized = 0;
      let totalDuplicatesSkipped = 0;
      let newAccountCreated = false;
      let bankAccountName = '';
      let statementId = '';
      const skippedMonths: string[] = [];

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // Progress weight for each file
        const startProgress = (i / selectedFiles.length) * 100;
        const endProgress = ((i + 1) / selectedFiles.length) * 100;
        setUploadProgress(startProgress + 5);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('companyId', activeCompany.id);
        if (forceBypass) {
          formData.append('bypassHolderValidation', 'true');
        }
        if (selectedBankAccountId) {
          formData.append('bankAccountId', selectedBankAccountId);
        }

        const res = await fetch('/api/import', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const err = await res.json();

            // Check if bank account creation is required!
            if (err.code === 'BANK_CREATION_REQUIRED') {
              const meta = err.details || {};
              setFormAccountName(meta.bankName || t('importPage.defaultAccountName'));
              setFormBankName(meta.bankName || '');
              setFormAccountNo(meta.accountNo || '');
              setFormRoutingNo('');
              setFormGlAccountId(null);
              setFormGlOption('create');
              setFormBalance(
                meta.openingBalance !== undefined
                  ? formatNumberWithComas(Number(meta.openingBalance.toFixed(2)).toString())
                  : '0.00',
              );
              setFormCurrency(meta.currency || 'USD');
              setFormError('');
              setBankModalOpen(true);

              setUploading(false);
              setUploadProgress(0);
              stopProcessing();
              return;
            }

            // Skip CONFLICT (existing statement) — collect and continue
            if (err.code === 'CONFLICT') {
              const monthMatch = err.error?.match(/período que inicia el\s+([^\s.]+)/i);
              skippedMonths.push(monthMatch ? monthMatch[1] : file.name.replace('.pdf', ''));
              setUploadProgress(endProgress);
              continue;
            }

            throw new Error(err.error || `${file.name}: ${t('banks.importFailed')}`);
          } else {
            throw new Error(t('importPage.serverError').replace('{file}', file.name).replace('{status}', String(res.status)));
          }
        }

        const data: ImportResult = await res.json();
        statementId = data.statementId;
        totalTransactions += data.transactionCount;
        totalAutoCategorized += data.autoCategorizedCount;
        totalDuplicatesSkipped += data.duplicatesSkipped;
        if (data.newAccountCreated) newAccountCreated = true;
        bankAccountName = data.bankAccountName;

        setUploadProgress(endProgress);
      }

      // If ALL files were skipped, show a clear message
      if (skippedMonths.length > 0 && totalTransactions === 0) {
        setUploadError(
          t('importPage.allMonthsSkipped').replace('{months}', skippedMonths.join(', ')),
        );
        clearFiles();
        setUploading(false);
        setUploadProgress(0);
        stopProcessing();
        return;
      }

      const skippedNote =
        skippedMonths.length > 0 ? ` ${t('importPage.skippedMonthsNote').replace('{months}', skippedMonths.join(', '))}` : '';

      setImportResult({
        statementId,
        transactionCount: totalTransactions,
        autoCategorizedCount: totalAutoCategorized,
        duplicatesSkipped: totalDuplicatesSkipped,
        newAccountCreated,
        bankAccountName,
        skippedNote,
      });
      setResultOpen(true);
      clearFiles();
      fetchBankAccounts();
      fetchHistory();
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setUploadProgress(0);
      stopProcessing();
    }
  }

  async function handleSaveBank() {
    if (!formAccountName.trim()) {
      setFormError(t('importPage.accountNameRequired'));
      return;
    }
    if (!formBankName.trim()) {
      setFormError(t('importPage.bankNameRequired'));
      return;
    }
    if (formGlOption === 'link' && !formGlAccountId) {
      setFormError(t('importPage.linkedAccountRequired'));
      return;
    }

    setSavingBank(true);
    setFormError('');
    try {
      let targetGlAccountId = formGlAccountId;

      if (formGlOption === 'create') {
        // Fetch all accounts to find parent "1010" and next code
        const accountsRes = await fetch(`/api/accounts?companyId=${activeCompany!.id}`);
        if (!accountsRes.ok) throw new Error(t('importPage.fetchAccountsFailed'));
        const data = await accountsRes.json();
        const accounts = data.accounts ?? [];

        const parentAcc = accounts.find((a: GlAccountData) => a.code === '1010');
        if (!parentAcc)
          throw new Error(t('importPage.parentAccountNotFound'));

        const subAccounts = accounts.filter(
          (a: GlAccountData) =>
            a.parentId === parentAcc.id || (a.code.startsWith('101') && a.code !== '1010'),
        );
        let nextCode = 1011;
        const codes = subAccounts
          .map((a: GlAccountData) => parseInt(a.code, 10))
          .filter((c: number) => !isNaN(c));
        if (codes.length > 0) {
          nextCode = Math.max(...codes) + 1;
        }

        // Create the GL Account automatically
        const newAccRes = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId: activeCompany!.id,
            code: String(nextCode),
            name: `${formBankName} - ${formAccountName}`,
            accountType: 'asset',
            normalBalance: 'debit',
            parentId: parentAcc.id,
          }),
        });

        if (!newAccRes.ok) {
          const errData = await newAccRes.json();
          throw new Error(errData.error || t('importPage.createAccountFailed'));
        }

        const newAccData = await newAccRes.json();
        targetGlAccountId = newAccData.account.id;
      }

      const body = {
        companyId: activeCompany!.id,
        accountName: formAccountName,
        bankName: formBankName,
        accountNo: formAccountNo || null,
        routingNo: formRoutingNo || null,
        glAccountId: targetGlAccountId!,
        balance: parseFloat(formBalance.replace(/,/g, '')) || 0,
        currency: formCurrency,
      };

      const res = await fetch('/api/banks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setBankModalOpen(false);
        await fetchBankAccounts();

        // Auto-resume import process!
        setTimeout(() => {
          handleUpload();
        }, 100);
      } else {
        const err = await res.json();
        setFormError(err.error || t('importPage.saveBankFailed'));
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBank(false);
    }
  }

  const getSuggestedCode = () => {
    const subAccounts = assetAccounts.filter((a) => a.code.startsWith('101') && a.code !== '1010');
    let nextCode = 1011;
    const codes = subAccounts.map((a) => parseInt(a.code, 10)).filter((c) => !isNaN(c));
    if (codes.length > 0) {
      nextCode = Math.max(...codes) + 1;
    }
    return String(nextCode);
  };

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('banks.importStatement')}</h2>
        <p className="text-sm text-muted-foreground">{t('banks.importStatement')}</p>
      </div>

      {/* Upload Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-5">
            {/* Drop zone */}
            <ImportDropZone
              files={selectedFiles}
              onFilesAdded={handleFilesAdded}
              onRemoveFile={removeFile}
              onClearFiles={clearFiles}
              onError={handleUploadError}
              uploading={uploading}
            />

            {/* Upload progress */}
            {uploading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" />
                    {t('banks.processing')}
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

            {/* Import button */}
            <div className="flex items-center gap-3">
              <Button
                onClick={() => handleUpload()}
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
              <p className="text-xs text-muted-foreground">{t('banks.autoDetect')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Import History */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">{t('banks.importHistory')}</CardTitle>
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
              <p className="text-sm text-muted-foreground">{t('banks.noImportHistory')}</p>
            </div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.date')}</TableHead>
                    <TableHead>{t('common.name')}</TableHead>
                    <TableHead>{t('common.type')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('banks.title')}</TableHead>
                    <TableHead className="text-center">{t('banks.transactionsImported')}</TableHead>
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
                          {getFileIcon(stmt.fileName || 'file.csv')}
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
                        <Badge variant="outline" className="font-mono text-xs">
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
                                  : 'text-muted-foreground',
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

      {/* ─── Import Result Dialog ───────────────────────────────────── */}
      <ImportResultDialog
        open={resultOpen}
        onOpenChange={setResultOpen}
        result={importResult}
        onClassifyEntities={() => {
          setResultOpen(false);
          setEntityOnboardingOpen(true);
        }}
        onGoToReconciliation={() => {
          setResultOpen(false);
          setCurrentView('reconciliation');
        }}
      />

      {/* ─── Entity Onboarding Modal ───────────────── */}
      <EntityOnboardingModal
        isOpen={entityOnboardingOpen}
        onClose={() => setEntityOnboardingOpen(false)}
        companyId={activeCompany?.id || ''}
      />

      {/* ─── Pre-filled Bank Account Creation Dialog ───────────────── */}
      <Dialog
        open={bankModalOpen}
        onOpenChange={(open) => {
          setBankModalOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('banks.newBankAccount')}</DialogTitle>
            <DialogDescription>{t('banks.newBankAccountDetectDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Account Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('common.name')} <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder={t('importPage.accountNamePlaceholder')}
                value={formAccountName}
                onChange={(e) => setFormAccountName(e.target.value)}
              />
            </div>

            {/* Bank Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('banks.bankName')} <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder={t('importPage.bankNamePlaceholder')}
                value={formBankName}
                onChange={(e) => setFormBankName(e.target.value)}
              />
            </div>

            {/* Account Number + Routing */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('banks.accountNumber')}</label>
                <Input
                  placeholder={t('importPage.accountNumberPlaceholder')}
                  value={formAccountNo}
                  onChange={(e) => setFormAccountNo(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('banks.routingNumber')}</label>
                <Input
                  placeholder={t('importPage.routingNumberPlaceholder')}
                  value={formRoutingNo}
                  onChange={(e) => setFormRoutingNo(e.target.value)}
                />
              </div>
            </div>

            {/* GL Account Option Selection */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('importPage.glAccountLabel')}</label>
              <div className="grid grid-cols-2 gap-2 bg-slate-900/50 dark:bg-slate-900/80 p-1 rounded-lg border">
                <button
                  type="button"
                  onClick={() => setFormGlOption('create')}
                  className={cn(
                    'py-1.5 text-xs font-semibold rounded-md transition-all',
                    formGlOption === 'create'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {t('importPage.createNewAuto')}
                </button>
                <button
                  type="button"
                  onClick={() => setFormGlOption('link')}
                  className={cn(
                    'py-1.5 text-xs font-semibold rounded-md transition-all',
                    formGlOption === 'link'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {t('importPage.linkExisting')}
                </button>
              </div>
            </div>

            {formGlOption === 'create' ? (
              <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3 text-xs leading-relaxed text-blue-300 space-y-2">
                <p className="font-semibold text-blue-400">✨ {t('importPage.autoConfigTitle')}</p>
                <p>{t('importPage.autoConfigDesc')}</p>
                <div className="mt-1 bg-slate-950/80 p-2.5 rounded border border-white/5 font-mono text-[11px] text-white space-y-1">
                  <div>
                    <span className="text-slate-400">{t('importPage.glCodeLabel')}</span>{' '}
                    <span className="text-blue-400 font-bold">{getSuggestedCode()}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">{t('importPage.glNameLabel')}</span>{' '}
                    <span className="text-emerald-400 font-bold">
                      {formBankName
                        ? `${formBankName} - ${formAccountName || t('importPage.defaultAccountName')}`
                        : t('importPage.defaultBankAccountName')}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">{t('importPage.parentAccountLabel')}</span> 1010 - Cash & Cash
                    Equivalents
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('banks.linkedAccount')} <span className="text-red-500">*</span>
                </label>
                <AccountSelector
                  accounts={assetAccounts}
                  value={formGlAccountId}
                  onChange={setFormGlAccountId}
                  placeholder={t('importPage.selectAssetAccount')}
                />
                <p className="text-xs text-muted-foreground">{t('banks.linkedAccountHelp')}</p>
              </div>
            )}

            {/* Starting Balance + Currency */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('banks.startingBalance')}</label>
                <Input
                  type="text"
                  placeholder="0.00"
                  value={formBalance}
                  onChange={(e) => setFormBalance(formatNumberWithComas(e.target.value))}
                  className="font-mono text-right"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('banks.currency')}</label>
                <Select value={formCurrency} onValueChange={setFormCurrency}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Error */}
            {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBankModalOpen(false)} disabled={savingBank}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveBank} disabled={savingBank}>
              {savingBank && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Account Holder Mismatch Warning Dialog ───────────────── */}
      <MismatchWarningDialog
        open={mismatchModalOpen}
        onOpenChange={setMismatchModalOpen}
        mismatches={mismatchFiles}
        isStrict={isStrict}
        companyName={activeCompany?.legalName || ''}
        onReject={handleRejectMismatches}
        onAccept={handleAcceptMismatch}
      />
    </div>
  );
}
