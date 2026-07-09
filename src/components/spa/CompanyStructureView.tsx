'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ROLE_LABELS, type EntityRole } from '@/lib/constants/entity-roles';
import {
  Loader2,
  Users,
  Building2,
  CreditCard,
  Globe,
  LayoutDashboard,
  RefreshCw,
  ChevronRight,
  CheckCircle2,
  Landmark,
} from 'lucide-react';

interface EntityContextItem {
  id: string;
  pattern: string;
  role: string;
}

interface CategoryColor {
  border: string;
  bg: string;
  iconBg: string;
  iconText: string;
  badge: string;
  check: string;
}

interface CategoryConfig {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
  roles: string[];
  color: CategoryColor;
}

const CATEGORY_COLORS: Record<string, CategoryColor> = {
  people: {
    border: 'border-sky-500/40',
    bg: 'bg-sky-500/5',
    iconBg: 'bg-sky-500/10 border-sky-500/20',
    iconText: 'text-sky-500',
    badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
    check: 'text-sky-500',
  },
  companies: {
    border: 'border-violet-500/40',
    bg: 'bg-violet-500/5',
    iconBg: 'bg-violet-500/10 border-violet-500/20',
    iconText: 'text-violet-500',
    badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    check: 'text-violet-500',
  },
  financial: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/5',
    iconBg: 'bg-amber-500/10 border-amber-500/20',
    iconText: 'text-amber-500',
    badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    check: 'text-amber-500',
  },
  platforms: {
    border: 'border-cyan-500/40',
    bg: 'bg-cyan-500/5',
    iconBg: 'bg-cyan-500/10 border-cyan-500/20',
    iconText: 'text-cyan-500',
    badge: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
    check: 'text-cyan-500',
  },
  other: {
    border: 'border-slate-500/40',
    bg: 'bg-slate-500/5',
    iconBg: 'bg-slate-500/10 border-slate-500/20',
    iconText: 'text-slate-500',
    badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    check: 'text-slate-500',
  },
};

const CATEGORIES: CategoryConfig[] = [
  { id: 'people', icon: Users, labelKey: 'companyStructure.categoryPeople', roles: ['SOCIO', 'EMPLEADO', 'INQUILINO'], color: CATEGORY_COLORS.people },
  { id: 'companies', icon: Building2, labelKey: 'companyStructure.categoryCompanies', roles: ['CLIENTE', 'PROVEEDOR'], color: CATEGORY_COLORS.companies },
  { id: 'financial', icon: CreditCard, labelKey: 'companyStructure.categoryFinancial', roles: ['TARJETA_CREDITO', 'PRESTAMO'], color: CATEGORY_COLORS.financial },
  { id: 'platforms', icon: Globe, labelKey: 'companyStructure.categoryPlatforms', roles: [], color: CATEGORY_COLORS.platforms },
  { id: 'other', icon: LayoutDashboard, labelKey: 'companyStructure.categoryOther', roles: ['INGRESO', 'GASTO_OPERATIVO', 'OTRO'], color: CATEGORY_COLORS.other },
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

const CARD_W = 210;
const CARD_GAP = 20;
const COMPANY_W = 280;
const COMPANY_H = 88;
const COMPANY_Y = 10;
const ARROW_PAD = 6;
const CATEGORY_START_Y = COMPANY_Y + COMPANY_H + 80;
const ROW_H = 170;

export function CompanyStructureView() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const [entities, setEntities] = useState<EntityContextItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<CategoryConfig | null>(null);

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

  const COLS = activeCategories.length || 1;
  const totalRows = 1;
  const containerW = COLS * (CARD_W + CARD_GAP) - CARD_GAP;
  const containerH = CATEGORY_START_Y + totalRows * ROW_H;
  const companyX = (containerW - COMPANY_W) / 2;

  const companyCenterX = companyX + COMPANY_W / 2;
  const companyBottom = COMPANY_Y + COMPANY_H;

  function getCategoryX(index: number) {
    return index * (CARD_W + CARD_GAP);
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="pb-4 border-b border-border/30">
        <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-primary to-indigo-500 bg-clip-text text-transparent">
          {activeCompany?.legalName ?? t('companyStructure.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('companyStructure.subtitle')}</p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="w-[280px] rounded-xl border border-border/40 bg-card/50 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-9 rounded-lg" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3">
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
        <div className="flex items-center gap-3 rounded-xl border border-border/40 bg-card/50 p-3">
          <Building2 className="size-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium">{t('companyStructure.emptyTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('companyStructure.emptyDescription')}</p>
          </div>
        </div>
      )}

      {/* Structure View — Flow Chart */}
      {!loading && !error && hasData && (
        <div className="w-full flex justify-center overflow-x-auto">
          <div className="relative shrink-0" style={{ width: `${containerW}px`, height: `${containerH}px` }}>
            {/* SVG Connections — rendered first, behind cards */}
            <svg
              className="absolute pointer-events-none z-0"
              width={containerW}
              height={containerH}
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <marker
                  id="struct-arrow"
                  viewBox="0 0 10 10"
                  refX="6"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#10b981" />
                </marker>
              </defs>
              {activeCategories.map((cat, index) => {
                const catX = getCategoryX(index) + CARD_W / 2;
                const catTop = CATEGORY_START_Y - ARROW_PAD;
                const midY = companyBottom + (catTop - companyBottom) / 2;
                return (
                  <path
                    key={cat.id}
                    d={`M ${companyCenterX} ${companyBottom} V ${midY} H ${catX} V ${catTop}`}
                    fill="none"
                    className="stroke-[2] stroke-emerald-500/60 drop-shadow-[0_0_3px_rgba(16,185,129,0.4)]"
                    markerEnd="url(#struct-arrow)"
                  />
                );
              })}
            </svg>

            {/* Company Card */}
            <div
              className="absolute z-10"
              style={{ left: `${companyX}px`, top: `${COMPANY_Y}px`, width: `${COMPANY_W}px` }}
            >
              <div className="flex items-center gap-3 rounded-xl p-3 border border-emerald-500/40 bg-emerald-500/5 shadow-sm">
                <div className="p-2 rounded-lg flex items-center justify-center border bg-emerald-500/10 border-emerald-500/20 text-emerald-500">
                  <Landmark className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">
                    {t('companyStructure.title')}
                  </span>
                  <h4 className="text-[11px] font-bold tracking-tight text-foreground truncate">
                    {activeCompany?.legalName}
                  </h4>
                  <p className="text-[9px] text-muted-foreground truncate">
                    {totalEntities} {t('companyStructure.totalEntities')}
                  </p>
                </div>
                <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />
              </div>
            </div>

            {/* Category Cards — only active */}
            {activeCategories.map((category, index) => {
              const items = categoryMap.get(category.id) ?? [];
              const Icon = category.icon;
              const x = getCategoryX(index);
              const { color } = category;

              return (
                <div
                  key={category.id}
                  onClick={() => setSelectedCategory(category)}
                  className={cn(
                    'absolute z-10 flex flex-col rounded-xl p-2.5 border shadow-sm cursor-pointer transition-all duration-200 hover:shadow-md hover:scale-[1.02]',
                    color.border,
                    color.bg,
                  )}
                  style={{ left: `${x}px`, top: `${CATEGORY_START_Y}px`, width: `${CARD_W}px` }}
                >
                  {/* Header */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className={cn('p-1.5 rounded-lg flex items-center justify-center border shrink-0', color.iconBg, color.iconText)}>
                      <Icon className="size-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[11px] font-bold tracking-tight text-foreground truncate">
                        {t(category.labelKey)}
                      </h3>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={cn('inline-flex items-center rounded-sm px-1 py-0.2 text-[7px] font-bold border uppercase tracking-wide', color.badge)}>
                        {items.length}
                      </span>
                      <CheckCircle2 className={cn('size-3', color.check)} />
                    </div>
                  </div>

                  {/* Entity List */}
                  <ul className="space-y-0.5 flex-1">
                    {items.slice(0, 3).map((item) => (
                      <li key={item.id}>
                        <span className="block rounded px-1.5 py-1 text-[9px] text-muted-foreground truncate">
                          {capitalizeName(item.pattern)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* View More */}
                  {items.length > 3 && (
                    <span className={cn('mt-1 flex w-full items-center gap-1 rounded px-1.5 py-1 text-[9px] font-medium', color.iconText)}>
                      {t('companyStructure.andMore', { count: items.length - 3 })}
                      <ChevronRight className="size-2.5" />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Category Detail Modal */}
      <Dialog open={!!selectedCategory} onOpenChange={(open) => !open && setSelectedCategory(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedCategory && (
                <>
                  <span className={cn('p-1.5 rounded-lg border', selectedCategory.color.iconBg, selectedCategory.color.iconText)}>
                    <selectedCategory.icon className="size-4" />
                  </span>
                  {selectedCategory && t(selectedCategory.labelKey)}
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedCategory && (
            <ul className="space-y-1 max-h-[300px] overflow-y-auto">
              {(categoryMap.get(selectedCategory.id) ?? []).map((item) => (
                <li key={item.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50">
                  <span className="text-sm font-medium truncate">{capitalizeName(item.pattern)}</span>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">
                    {ROLE_LABELS[item.role as EntityRole] ?? item.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
