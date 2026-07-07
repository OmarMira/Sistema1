'use client';

import { ConversationalRuleBuilder } from '@/components/learning/ConversationalRuleBuilder';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Brain } from 'lucide-react';
import { logger } from '@/lib/logger';

export function AIRulesGeneratorTab() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  // Guard: Sin empresa seleccionada
  if (!activeCompany?.id) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        {t('settings.aiRules.selectCompanyFirst')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="size-5 text-violet-500" />
            {t('settings.aiRules.title')}
          </CardTitle>
          <CardDescription>{t('settings.aiRules.conversationalDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* ÚNICO componente activo: el asistente conversacional */}
          <ConversationalRuleBuilder
            companyId={activeCompany.id}
            onComplete={(ruleData) => {
              logger.info('✅ Regla creada con contexto:', { data: ruleData });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
