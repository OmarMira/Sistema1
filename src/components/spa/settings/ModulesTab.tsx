'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { useNavEntitlements } from '@/hooks/use-nav-entitlements';
import {
  MODULE_CATALOG,
  type ImplementationStatus,
  type ModuleKey,
} from '@/lib/constants/module-catalog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

/**
 * Commercial module configuration for the active company.
 *
 * Data model: commercial state comes from GET /api/company/entitlements
 * (shared query with 11C navigation via useNavEntitlements). Effective state,
 * reason and missingDependencies are ALWAYS derived from the current rows
 * using the same client rules 11C already ships — no per-module engine
 * results are retained, so dependents recompute whenever any row changes.
 * The 11E-A PATCH response is consumed only for immediate error feedback;
 * successful mutations rely on the shared query's immediate refetch.
 *
 * No pricing is rendered here: the catalog's placeholder values are
 * deliberately never read by this component.
 */

type EntitlementReason =
  | 'EFFECTIVE_ENABLED'
  | 'NOT_CONFIGURED'
  | 'COMMERCIALLY_DISABLED'
  | 'IMPLEMENTATION_UNAVAILABLE'
  | 'MISSING_DEPENDENCY';

interface ModuleViewState {
  commercialEnabled: boolean;
  effectiveEnabled: boolean;
  reason: EntitlementReason;
  missingDependencies: ModuleKey[];
}

function displayNameOf(moduleKey: ModuleKey): string {
  return MODULE_CATALOG.find((entry) => entry.key === moduleKey)?.displayName ?? moduleKey;
}

/**
 * Client read-model for the stable visible state — mirrors the 11C nav rules
 * (isModuleEffective) plus the engine's reason precedence over the CURRENT
 * GET rows, so disabling a dependency immediately recomputes dependents.
 * It never drives writes: mutations always go through the 11E-A endpoint.
 */
function deriveModuleView(
  moduleKey: ModuleKey,
  rows: ReadonlyMap<string, boolean>,
  visited: ReadonlySet<ModuleKey>,
): { effectiveEnabled: boolean; reason: EntitlementReason; missingDependencies: ModuleKey[] } {
  const entry = MODULE_CATALOG.find((candidate) => candidate.key === moduleKey);
  if (!entry || entry.implementationStatus === 'UNAVAILABLE') {
    return { effectiveEnabled: false, reason: 'IMPLEMENTATION_UNAVAILABLE', missingDependencies: [] };
  }
  if (!rows.has(moduleKey)) {
    return { effectiveEnabled: false, reason: 'NOT_CONFIGURED', missingDependencies: [] };
  }
  if (rows.get(moduleKey) !== true) {
    return { effectiveEnabled: false, reason: 'COMMERCIALLY_DISABLED', missingDependencies: [] };
  }
  if (visited.has(moduleKey)) {
    return { effectiveEnabled: true, reason: 'EFFECTIVE_ENABLED', missingDependencies: [] };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(moduleKey);
  const missingDependencies: ModuleKey[] = [];
  for (const dependency of entry.dependencies) {
    const dependencyState = deriveModuleView(dependency, rows, nextVisited);
    if (!dependencyState.effectiveEnabled) {
      missingDependencies.push(dependency);
    }
  }
  if (missingDependencies.length > 0) {
    return { effectiveEnabled: false, reason: 'MISSING_DEPENDENCY', missingDependencies };
  }
  return { effectiveEnabled: true, reason: 'EFFECTIVE_ENABLED', missingDependencies: [] };
}

function badgeVariant(status: ImplementationStatus): 'default' | 'secondary' | 'outline' {
  if (status === 'AVAILABLE') return 'default';
  if (status === 'PARTIAL') return 'secondary';
  return 'outline';
}

export function ModulesTab() {
  const t = useLanguageStore((s) => s.t);
  const user = useAuthStore((s) => s.user);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;
  const tenantRole = activeCompany?.role ?? null;
  const queryClient = useQueryClient();

  const { rows, isLoading, error } = useNavEntitlements(companyId);

  const [pendingKey, setPendingKey] = useState<ModuleKey | null>(null);
  const [moduleErrors, setModuleErrors] = useState<Partial<Record<ModuleKey, string>>>({});

  // WHO_CAN_EDIT: company membership role, plus the established super-admin
  // UI precedent (same rule SettingsPage uses for diagnostics).
  const canEdit = tenantRole === 'company_admin' || user?.role === 'super_admin';

  const rowsByModule = new Map((rows ?? []).map((row) => [row.moduleKey, row.enabled]));

  async function handleToggle(moduleKey: ModuleKey, next: boolean) {
    if (!companyId || pendingKey) return;
    setPendingKey(moduleKey);
    try {
      const res = await fetch(
        `/api/company/entitlements/${moduleKey}?companyId=${encodeURIComponent(companyId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        },
      );
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        const message = data?.error || t('settings.modules.activationError');
        setModuleErrors((previous) => ({ ...previous, [moduleKey]: message }));
        toast.error(t('settings.modules.activationError'), { description: message });
        return;
      }
      setModuleErrors((previous) => ({ ...previous, [moduleKey]: undefined }));
      // Refresh module rows and the 11C navigation query (same query key).
      // The stable visible state is always derived from the refreshed rows —
      // no PATCH result is retained, so dependents recompute correctly.
      await queryClient.invalidateQueries({ queryKey: ['module-nav-entitlements', companyId] });
    } catch {
      const message = t('settings.modules.activationError');
      setModuleErrors((previous) => ({ ...previous, [moduleKey]: message }));
      toast.error(t('settings.modules.activationError'));
    } finally {
      setPendingKey(null);
    }
  }

  function viewStateFor(entry: (typeof MODULE_CATALOG)[number]): ModuleViewState {
    const derived = deriveModuleView(entry.key, rowsByModule, new Set());
    return {
      commercialEnabled: rowsByModule.get(entry.key) === true,
      effectiveEnabled: derived.effectiveEnabled,
      reason: derived.reason,
      missingDependencies: derived.missingDependencies,
    };
  }

  if (!companyId) {
    return <p className="text-sm text-muted-foreground">{t('common.noData')}</p>;
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="modules-loading">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.modulesTab')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.modules.description')}</p>
        {!canEdit && (
          <p className="text-sm text-muted-foreground mt-1" data-testid="modules-readonly">
            {t('settings.modules.readOnly')}
          </p>
        )}
        {error !== undefined && error !== null && (
          <p role="alert" className="text-sm text-destructive mt-2" data-testid="modules-load-error">
            {t('common.error')}
          </p>
        )}
      </div>

      <div className="space-y-4" data-testid="modules-list">
        {MODULE_CATALOG.map((entry) => {
          const state = viewStateFor(entry);
          const statusKey = entry.implementationStatus;
          const toggleDisabled =
            !canEdit || statusKey === 'UNAVAILABLE' || pendingKey === entry.key;
          const errorMessage = moduleErrors[entry.key];
          return (
            <Card key={entry.key} data-testid={`module-card-${entry.key}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      {entry.displayName}
                      <Badge
                        variant={badgeVariant(statusKey)}
                        data-testid={`module-status-${entry.key}`}
                      >
                        {t(`settings.modules.status.${statusKey}`)}
                      </Badge>
                      {pendingKey === entry.key && <Loader2 className="size-4 animate-spin" />}
                    </CardTitle>
                    <CardDescription>
                      {t(`settings.modules.statusDescription.${statusKey}`)}
                    </CardDescription>
                  </div>
                  <Switch
                    checked={state.commercialEnabled}
                    disabled={toggleDisabled}
                    onCheckedChange={(next) => void handleToggle(entry.key, next)}
                    aria-label={`${entry.displayName} ${state.commercialEnabled ? t('settings.modules.enabled') : t('settings.modules.disabled')}`}
                    data-testid={`module-toggle-${entry.key}`}
                  />
                </div>
              </CardHeader>
              <CardContent className="pb-4 space-y-1.5">
                {entry.dependencies.length > 0 && (
                  <p className="text-sm text-muted-foreground" data-testid={`module-deps-${entry.key}`}>
                    {t('settings.modules.dependsOn')}:{' '}
                    {entry.dependencies.map((dependency) => displayNameOf(dependency)).join(', ')}
                  </p>
                )}
                <p className="text-sm" data-testid={`module-state-${entry.key}`}>
                  {t(`settings.modules.reason.${state.reason}`)}
                </p>
                {state.reason === 'MISSING_DEPENDENCY' && state.missingDependencies.length > 0 && (
                  <p className="text-sm text-amber-600" data-testid={`module-missing-${entry.key}`}>
                    {t('settings.modules.missingDependency')}:{' '}
                    {state.missingDependencies.map((dependency) => displayNameOf(dependency)).join(', ')}
                  </p>
                )}
                {errorMessage && (
                  <p role="alert" className="text-sm text-destructive" data-testid={`module-error-${entry.key}`}>
                    {errorMessage}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
