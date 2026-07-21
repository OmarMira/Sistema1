'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { createInitialReadinessForm, type ReadinessForm } from '@/lib/readiness/default-readiness-profile';
import { buildPolicyQueryParams } from '@/lib/readiness/build-policy-query-params';
import type { OperationalPolicyDecision, OperationalContext } from '@/lib/operational-policy/types';
import { logger } from '@/lib/logger';
import ReadinessCriteriaForm from '@/components/spa/admin/readiness/ReadinessCriteriaForm';
import ReadinessStatusCard from '@/components/spa/admin/readiness/ReadinessStatusCard';
import ReadinessMetricsGrid from '@/components/spa/admin/readiness/ReadinessMetricsGrid';
import ReadinessRatesGrid from '@/components/spa/admin/readiness/ReadinessRatesGrid';
import ReadinessChecksTable from '@/components/spa/admin/readiness/ReadinessChecksTable';
import ReadinessRecommendationBanner from '@/components/spa/admin/readiness/ReadinessRecommendationBanner';
import TrustPolicyWarning from '@/components/spa/admin/readiness/TrustPolicyWarning';
import PolicyDecisionCard from '@/components/spa/admin/readiness/PolicyDecisionCard';
import { Info, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type DashboardForm = ReadinessForm & { context: OperationalContext };

const CONTEXT_OPTIONS: OperationalContext[] = ['APPLY_ALL', 'IMPORT', 'RECONCILIATION'];

export default function AdminReadinessDashboardPage() {
  const t = useLanguageStore((s) => s.t);
  const { adminSelectedCompanyId } = useAuthStore();

  const initialForm = (): DashboardForm => ({
    ...createInitialReadinessForm(),
    context: 'APPLY_ALL',
  });

  const [draftForm, setDraftForm] = useState<DashboardForm>(initialForm);
  const [appliedQuery, setAppliedQuery] = useState<DashboardForm | null>(null);
  const [policyResult, setPolicyResult] = useState<OperationalPolicyDecision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasExistingData, setHasExistingData] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const fetchPolicy = useCallback(async (query: DashboardForm, companyId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const currentId = ++requestIdRef.current;

    const params = buildPolicyQueryParams(query, companyId);

    try {
      setLoading(true);
      setError(null);
      const res = await fetch(
        `/api/admin/shadow-metrics/policy?${params.toString()}`,
        { credentials: 'include', signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data: OperationalPolicyDecision = await res.json();

      if (currentId !== requestIdRef.current) return;
      setPolicyResult(data);
      setHasExistingData(true);
    } catch (err) {
      if (currentId !== requestIdRef.current) return;
      if ((err as Error)?.name === 'AbortError') return;
      logger.error('Policy fetch failed', { error: String(err) });
      if (!hasExistingData) {
        setError(String(err));
      }
    } finally {
      if (currentId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [hasExistingData]);

  const handleFieldChange = useCallback((field: keyof ReadinessForm, value: string) => {
    setDraftForm(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleContextChange = useCallback((value: string) => {
    setDraftForm(prev => ({ ...prev, context: value as OperationalContext }));
  }, []);

  const handleApply = useCallback(() => {
    setAppliedQuery(draftForm);
    if (adminSelectedCompanyId) {
      fetchPolicy(draftForm, adminSelectedCompanyId);
    }
  }, [draftForm, adminSelectedCompanyId, fetchPolicy]);

  useEffect(() => {
    const mountedForm = initialForm();
    setDraftForm(mountedForm);
    if (adminSelectedCompanyId) {
      setAppliedQuery(mountedForm);
      fetchPolicy(mountedForm, adminSelectedCompanyId);
    }
  }, [adminSelectedCompanyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const readinessResult = policyResult?.readiness ?? null;

  if (!adminSelectedCompanyId) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center space-y-2">
          <Info className="size-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">{t('admin.readiness.companyRequired')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">{t('admin.readiness.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('admin.readiness.subtitle')}</p>
        <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 p-3 mt-2">
          <Info className="size-4 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-xs text-blue-700 dark:text-blue-300">{t('admin.readiness.useCaseAlert')}</p>
        </div>
      </div>

      <ReadinessCriteriaForm
        draftForm={draftForm}
        onFieldChange={handleFieldChange}
        onApply={handleApply}
        loading={loading}
        t={t}
      />

      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground">Operational Context:</label>
        <Select
          value={draftForm.context}
          onValueChange={handleContextChange}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTEXT_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && !hasExistingData && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/20 p-8 text-center">
          <AlertCircle className="size-8 text-red-500" />
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => appliedQuery && adminSelectedCompanyId && fetchPolicy(appliedQuery, adminSelectedCompanyId)}
          >
            {t('admin.readiness.retry')}
          </Button>
        </div>
      )}

      {error && hasExistingData && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/20 p-3">
          <AlertCircle className="size-4 shrink-0 text-red-500" />
          <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {loading && !hasExistingData && (
        <div className="flex items-center justify-center gap-2 py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('admin.readiness.loading')}</p>
        </div>
      )}

      {policyResult && (
        <>
          <PolicyDecisionCard decision={policyResult} />
          <ReadinessStatusCard
            status={readinessResult!.status}
            reasons={'reasons' in readinessResult! ? readinessResult!.reasons : undefined}
            t={t}
          />
          <ReadinessMetricsGrid
            metrics={readinessResult!.metrics}
            loading={loading}
            t={t}
          />
          <ReadinessRatesGrid
            metrics={readinessResult!.metrics}
            checks={readinessResult!.checks}
            loading={loading}
            t={t}
          />
          {appliedQuery && (
            <TrustPolicyWarning
              trustPolicy={appliedQuery.trustPolicy}
              legacyUntrustedBatches={readinessResult!.metrics.legacyUntrustedBatches}
              t={t}
            />
          )}
          <ReadinessChecksTable
            checks={readinessResult!.checks}
            failedChecks={'failedChecks' in readinessResult! ? readinessResult!.failedChecks : undefined}
            t={t}
          />
          <ReadinessRecommendationBanner
            status={readinessResult!.status}
            t={t}
          />
        </>
      )}
    </div>
  );
}
