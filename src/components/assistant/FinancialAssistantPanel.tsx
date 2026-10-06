'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle, Info, TrendingUp } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useRBAC } from '@/hooks/useRBAC';
import { useAuthStore } from '@/store/auth-store';

import { useLanguageStore } from '@/store/language-store';

// Human-readable labels for the known insight.context keys produced by
// insight-engine.ts (cash_trend, budget_alert, recon_alert).
const CONTEXT_KEY_LABELS: Record<string, { es: string; en: string }> = {
  code: { es: 'Cuenta', en: 'Account' },
  budget: { es: 'Presupuesto', en: 'Budget' },
  actual: { es: 'Real', en: 'Actual' },
  variance: { es: 'Desviación', en: 'Variance' },
  count: { es: 'Pendientes', en: 'Pending' },
};

function formatInsightContext(context: Record<string, unknown>, language: string): string {
  const lang: 'es' | 'en' = language === 'en' ? 'en' : 'es';
  const locale = lang === 'es' ? 'es-AR' : 'en-US';
  const fmtNumber = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  return Object.entries(context)
    .map(([key, value]) => {
      const label = CONTEXT_KEY_LABELS[key]?.[lang] ?? key;
      if (key === 'variance' && typeof value === 'number') {
        return `${label}: ${fmtNumber(value * 100)}%`;
      }
      if (typeof value === 'number') return `${label}: ${fmtNumber(value)}`;
      return `${label}: ${String(value)}`;
    })
    .join(' · ');
}

export function FinancialAssistantPanel({ companyId }: { companyId: string }) {
  const { user } = useAuth();
  const language = useLanguageStore((s) => s.language) || 'es';

  const translations = {
    es: {
      loading: 'Cargando asistente...',
      noAlerts: 'Sin alertas activas. Sistema estable.',
      title: 'Asistente Financiero',
      severity: { info: 'INFO', warning: 'AVISO', critical: 'CRÍTICO' },
    },
    en: {
      loading: 'Loading assistant...',
      noAlerts: 'No active alerts. Stable system.',
      title: 'Financial Assistant',
      severity: { info: 'INFO', warning: 'WARNING', critical: 'CRITICAL' },
    },
  }[language];

  // Tenant authority lives in the active company membership — never in User.role.
  // Only trust the active company's role when it matches this panel's companyId.
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const tenantRole = activeCompany?.id === companyId ? (activeCompany?.role ?? null) : null;

  const authCtx = user
    ? {
        userId: user.id,
        companyId,
        role: user.role === 'super_admin' ? 'super_admin' : (tenantRole ?? 'none'),
      }
    : null;

  const canView = useRBAC(authCtx, 'reports', 'read');

  const { data, isLoading } = useQuery({
    queryKey: ['assistant-insights', companyId],
    queryFn: () => fetch(`/api/assistant/insights?companyId=${companyId}`).then((r) => r.json()),
    enabled: !!canView && !!companyId,
    refetchInterval: 300000, // 5 min
  });

  if (!canView) return null;
  if (isLoading)
    return <div className="p-6 text-muted-foreground animate-pulse">{translations.loading}</div>;
  if (!data?.insights?.length)
    return (
      <div className="p-6 text-muted-foreground flex items-center gap-2">
        <CheckCircle className="text-green-500 size-5" /> {translations.noAlerts}
      </div>
    );

  const severityConfig = {
    info: { icon: <Info className="text-blue-500 size-4 mt-0.5" />, badge: 'outline' },
    warning: {
      icon: <AlertCircle className="text-yellow-500 size-4 mt-0.5" />,
      badge: 'secondary',
    },
    critical: {
      icon: <AlertCircle className="text-red-500 size-4 mt-0.5" />,
      badge: 'destructive',
    },
  } as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-bold">
          <TrendingUp className="size-5 text-primary" /> {translations.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.insights.map((insight: { id: string; severity: string; message: string; context?: Record<string, unknown> }) => {
          const cfg =
            severityConfig[insight.severity as keyof typeof severityConfig] || severityConfig.info;
          return (
            <div
              key={insight.id}
              className="flex items-start gap-3 p-3 rounded-md border bg-card hover:bg-muted/50 transition-colors"
            >
              {cfg.icon}
              <div className="flex-1 min-w-0">
                <p className="text-sm leading-snug">{insight.message}</p>
                {insight.context && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    {formatInsightContext(insight.context, language)}
                  </p>
                )}
              </div>
              <Badge variant={cfg.badge} className="shrink-0 font-semibold">
                {(
                  translations.severity[
                    insight.severity as keyof typeof translations.severity
                  ] ?? insight.severity.toUpperCase()
                )}
              </Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
