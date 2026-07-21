'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { createInitialReadinessForm, type ReadinessForm } from '@/lib/readiness/default-readiness-profile';
import { buildReadinessQueryParams } from '@/lib/readiness/build-readiness-query-params';
import type { CanonicalReadiness } from '@/lib/services/canonical-readiness-service';
import { logger } from '@/lib/logger';
import ReadinessCriteriaForm from '@/components/spa/admin/readiness/ReadinessCriteriaForm';
import ReadinessStatusCard from '@/components/spa/admin/readiness/ReadinessStatusCard';
import ReadinessMetricsGrid from '@/components/spa/admin/readiness/ReadinessMetricsGrid';
import ReadinessRatesGrid from '@/components/spa/admin/readiness/ReadinessRatesGrid';
import ReadinessChecksTable from '@/components/spa/admin/readiness/ReadinessChecksTable';
import ReadinessRecommendationBanner from '@/components/spa/admin/readiness/ReadinessRecommendationBanner';
import TrustPolicyWarning from '@/components/spa/admin/readiness/TrustPolicyWarning';
import { Info, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AdminReadinessDashboardPage() {
  const t = useLanguageStore((s) => s.t);
  const { adminSelectedCompanyId } = useAuthStore();

  const [draftForm, setDraftForm] = useState<ReadinessForm>(() => createInitialReadinessForm());
  const [appliedQuery, setAppliedQuery] = useState<ReadinessForm | null>(null);
  const [readinessResult, setReadinessResult] = useState<CanonicalReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasExistingData, setHasExistingData] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const fetchReadiness = useCallback(async (query: ReadinessForm, companyId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const currentId = ++requestIdRef.current;

    const params = buildReadinessQueryParams(query, companyId);

    try {
      setLoading(true);
      setError(null);
      const res = await fetch(
        `/api/admin/shadow-metrics/readiness?${params.toString()}`,
        { credentials: 'include', signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data: CanonicalReadiness = await res.json();

      if (currentId !== requestIdRef.current) return;
      setReadinessResult(data);
      setHasExistingData(true);
    } catch (err) {
      if (currentId !== requestIdRef.current) return;
      if ((err as Error)?.name === 'AbortError') return;
      logger.error('Readiness fetch failed', { error: String(err) });
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

  const handleApply = useCallback(() => {
    setAppliedQuery(draftForm);
    if (adminSelectedCompanyId) {
      fetchReadiness(draftForm, adminSelectedCompanyId);
    }
  }, [draftForm, adminSelectedCompanyId, fetchReadiness]);

  useEffect(() => {
    const mountedForm = createInitialReadinessForm();
    setDraftForm(mountedForm);
    if (adminSelectedCompanyId) {
      setAppliedQuery(mountedForm);
      fetchReadiness(mountedForm, adminSelectedCompanyId);
    }
  }, [adminSelectedCompanyId]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {error && !hasExistingData && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/20 p-8 text-center">
          <AlertCircle className="size-8 text-red-500" />
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => appliedQuery && adminSelectedCompanyId && fetchReadiness(appliedQuery, adminSelectedCompanyId)}
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

      {readinessResult && (
        <>
          <ReadinessStatusCard
            status={readinessResult.status}
            reasons={'reasons' in readinessResult ? readinessResult.reasons : undefined}
            t={t}
          />
          <ReadinessMetricsGrid
            metrics={readinessResult.metrics}
            loading={loading}
            t={t}
          />
          <ReadinessRatesGrid
            metrics={readinessResult.metrics}
            checks={readinessResult.checks}
            loading={loading}
            t={t}
          />
          {appliedQuery && (
            <TrustPolicyWarning
              trustPolicy={appliedQuery.trustPolicy}
              legacyUntrustedBatches={readinessResult.metrics.legacyUntrustedBatches}
              t={t}
            />
          )}
          <ReadinessChecksTable
            checks={readinessResult.checks}
            failedChecks={'failedChecks' in readinessResult ? readinessResult.failedChecks : undefined}
            t={t}
          />
          <ReadinessRecommendationBanner
            status={readinessResult.status}
            t={t}
          />
        </>
      )}
    </div>
  );
}
