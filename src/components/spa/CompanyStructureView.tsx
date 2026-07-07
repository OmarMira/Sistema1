'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Loader2,
  Users,
  Building2,
  CreditCard,
  Globe,
  LayoutDashboard,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';

interface EntityContextItem {
  id: string;
  pattern: string;
  role: string;
}

interface CategoryConfig {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  roles: string[];
  borderColor: string;
  iconColor: string;
}

const CATEGORIES: CategoryConfig[] = [
  { id: 'people', icon: <Users className="size-4" />, labelKey: 'companyStructure.categoryPeople', roles: ['SOCIO', 'EMPLEADO', 'INQUILINO'], borderColor: 'border-emerald-500/30', iconColor: 'text-emerald-400' },
  { id: 'companies', icon: <Building2 className="size-4" />, labelKey: 'companyStructure.categoryCompanies', roles: ['CLIENTE', 'PROVEEDOR'], borderColor: 'border-teal-500/30', iconColor: 'text-teal-400' },
  { id: 'financial', icon: <CreditCard className="size-4" />, labelKey: 'companyStructure.categoryFinancial', roles: ['TARJETA_CREDITO', 'PRESTAMO'], borderColor: 'border-cyan-500/30', iconColor: 'text-cyan-400' },
  { id: 'platforms', icon: <Globe className="size-4" />, labelKey: 'companyStructure.categoryPlatforms', roles: [], borderColor: 'border-sky-500/30', iconColor: 'text-sky-400' },
  { id: 'other', icon: <LayoutDashboard className="size-4" />, labelKey: 'companyStructure.categoryOther', roles: ['INGRESO', 'GASTO_OPERATIVO', 'OTRO'], borderColor: 'border-violet-500/30', iconColor: 'text-violet-400' },
];

const ROLE_TO_CATEGORY = new Map<string, string>();
for (const cat of CATEGORIES) {
  for (const role of cat.roles) {
    ROLE_TO_CATEGORY.set(role, cat.id);
  }
}

function capitalizeName(name: string): string {
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CompanyStructureView() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);
  const [entities, setEntities] = useState<EntityContextItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEntities = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/entity-context?limit=1000&sortBy=role&sortDir=asc&companyId=${activeCompany.id}`,
      );
      if (!res.ok) throw new Error('Failed to load entities');
      const data = await res.json();
      setEntities(data.data ?? []);
    } catch {
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [activeCompany, t]);

  useEffect(() => {
    fetchEntities();
  }, [fetchEntities]);

  const categoryMap = new Map<string, EntityContextItem[]>();
  for (const cat of CATEGORIES) categoryMap.set(cat.id, []);
  for (const entity of entities) {
    const catId = ROLE_TO_CATEGORY.get(entity.role) ?? 'other';
    categoryMap.get(catId)?.push(entity);
  }

  const activeCategories = CATEGORIES.filter((c) => (categoryMap.get(c.id)?.length ?? 0) > 0);
  const totalEntities = entities.length;
  const hasData = totalEntities > 0;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-lg font-bold tracking-tight text-foreground truncate">
            {activeCompany?.legalName ?? t('companyStructure.title')}
          </h1>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t('companyStructure.subtitle')}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchEntities} disabled={loading} className="gap-1.5 shrink-0">
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
        </Button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="w-[280px] rounded-lg border border-border/40 bg-card/50 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-7 rounded-md" />
                <Skeleton className="h-3.5 w-20" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
          <Loader2 className="size-4 text-destructive shrink-0" />
          <p className="text-sm text-muted-foreground flex-1">{error}</p>
          <Button variant="ghost" size="sm" onClick={fetchEntities} className="gap-1.5">
            <RefreshCw className="size-3.5" />
            {t('common.retry')}
          </Button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && !hasData && (
        <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/50 p-3">
          <Building2 className="size-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium">{t('companyStructure.emptyTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('companyStructure.emptyDescription')}</p>
          </div>
        </div>
      )}

      {/* Cards */}
      {!loading && !error && hasData && (
        <div className="flex flex-wrap gap-3">
          {activeCategories.map((category) => {
            const items = categoryMap.get(category.id) ?? [];
            return (
              <div
                key={category.id}
                className={`w-[280px] rounded-lg border bg-card/50 p-3 transition-colors hover:bg-card ${category.borderColor}`}
              >
                {/* Header */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={category.iconColor}>{category.icon}</span>
                  <h3 className="text-sm font-semibold text-foreground">
                    {t(category.labelKey)}
                  </h3>
                  <span className="ml-auto text-xs text-muted-foreground">
                    ({items.length})
                  </span>
                </div>

                {/* Lista */}
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 italic">—</p>
                ) : (
                  <ul className="space-y-0.5">
                    {items.slice(0, 4).map((item) => (
                      <li key={item.id}>
                        <button
                          className="w-full rounded px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground truncate"
                          title={item.pattern}
                        >
                          {capitalizeName(item.pattern)}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {items.length > 4 && (
                  <button
                    onClick={() => setCurrentView('entity-management')}
                    className="mt-1 flex w-full items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-primary/70 transition-colors hover:text-primary"
                  >
                    {t('companyStructure.andMore', { count: items.length - 4 })}
                    <ChevronRight className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
