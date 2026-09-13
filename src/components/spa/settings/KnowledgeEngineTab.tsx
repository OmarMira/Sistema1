'use client';

import { Brain, AlertTriangle, Sparkles } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';

/**
 * Knowledge Engine control surface entry (KE-NAV-INTEGRATION-001).
 *
 * Pure navigation: links to the EXISTING productive surfaces published in
 * KE-CONFLICT-UI-001 and KE-GENERALIZATION-UI-001. No KE logic here — the
 * destination pages enforce their own SSR context and the APIs enforce
 * company_admin RBAC server-side. Plain anchors match the existing
 * company-knowledge page-link precedent.
 */

interface KE_SURFACE {
  href: string;
  icon: React.ElementType;
  titleKey: string;
  descKey: string;
  testId: string;
}

const SURFACES: KE_SURFACE[] = [
  {
    href: '/company-knowledge/conflicts',
    icon: AlertTriangle,
    titleKey: 'knowledgeEngine.conflictsTitle',
    descKey: 'knowledgeEngine.conflictsDescription',
    testId: 'ke-conflicts-link',
  },
  {
    href: '/company-knowledge/structural-candidates',
    icon: Sparkles,
    titleKey: 'knowledgeEngine.generalizationTitle',
    descKey: 'knowledgeEngine.generalizationDescription',
    testId: 'ke-generalization-link',
  },
];

export function KnowledgeEngineTab() {
  const t = useLanguageStore((s) => s.t);

  return (
    <div className="space-y-4" data-testid="knowledge-engine-tab">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10">
          <Brain className="size-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{t('knowledgeEngine.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('knowledgeEngine.subtitle')}</p>
        </div>
      </div>

      <div className="grid gap-3">
        {SURFACES.map((surface) => {
          const Icon = surface.icon;
          return (
            <a
              key={surface.href}
              href={surface.href}
              data-testid={surface.testId}
              className="flex items-start gap-3 rounded-xl border bg-card p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center justify-center size-9 rounded-lg bg-primary/10 shrink-0">
                <Icon className="size-4 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">{t(surface.titleKey)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t(surface.descKey)}</p>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
