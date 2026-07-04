import type { Signal, HeuristicSignal, AISignal } from '@/lib/types/reasoning';
import { serverT } from '@/lib/server-i18n';

export function collectEntityContextSignal(
  entityContext: { role: string | null; glAccountId: string | null; glAccount?: { code: string; name: string } | null } | null,
  locale?: string,
): Signal {
  if (!entityContext) {
    return {
      source: 'entity_context',
      role: null,
      glAccountCode: null,
      confidence: 0,
      reasoning: serverT(locale, 'reasoning.uncertaintyNoContext'),
    };
  }

  const hasGlAccount = entityContext.glAccount && entityContext.glAccount.code;
  const confidence = hasGlAccount ? 0.95 : 0.75;

  return {
    source: 'entity_context',
    role: entityContext.role,
    glAccountCode: hasGlAccount ? entityContext.glAccount!.code.trim() || null : null,
    confidence,
    reasoning: hasGlAccount
      ? `${serverT(locale, 'reasoning.entityContextHigh').replace('{role}', entityContext.role ?? '').replace('{confidence}', String(Math.round(confidence * 100)))}`
      : `${serverT(locale, 'reasoning.entityContextMedium').replace('{role}', entityContext.role ?? '').replace('{confidence}', String(Math.round(confidence * 100)))}`,
  };
}

export function collectHeuristicSignal(
  userInput: string,
  assistantConfig: { heuristics: Array<{ keywords: string[]; role: string; glAccountCode: string; direction: string }> },
  locale?: string,
): HeuristicSignal | Signal {
  const text = userInput.toLowerCase().trim();
  const rules = assistantConfig.heuristics ?? [];

  for (const rule of rules) {
    const allKeywords = rule.keywords ?? [];
    const matchedKeyword = allKeywords.find((kw) => text.includes(kw.toLowerCase()));
    if (matchedKeyword) {
      const isExactRoleName = matchedKeyword.toLowerCase() === rule.role.toLowerCase();
      const confidence = isExactRoleName ? 0.9 : 0.7;
      return {
        source: 'heuristic',
        role: rule.role,
        glAccountCode: rule.glAccountCode,
        confidence,
        reasoning: `${serverT(locale, 'reasoning.heuristicMatch').replace('{role}', rule.role).replace('{matchedKeyword}', matchedKeyword).replace('{confidence}', String(Math.round(confidence * 100)))}`,
        metadata: { matchedKeyword },
      };
    }
  }

  return {
    source: 'heuristic',
    role: null,
    glAccountCode: null,
    confidence: 0,
    reasoning: serverT(locale, 'reasoning.uncertaintyNoHeuristic'),
  };
}

export function collectAISignal(
  aiResponse: { role?: string; glAccountCode?: string } | null,
  locale?: string,
): AISignal | Signal {
  if (!aiResponse || !aiResponse.role) {
    return {
      source: 'ai',
      role: null,
      glAccountCode: null,
      confidence: 0,
      reasoning: serverT(locale, 'reasoning.uncertaintyNoAI'),
    };
  }

  const rawCode = aiResponse.glAccountCode?.trim() ?? '';
  const hasGlAccountCode = rawCode.length > 0;
  const confidence = hasGlAccountCode ? 0.85 : 0.6;

  return {
    source: 'ai',
    role: aiResponse.role,
    glAccountCode: rawCode || null,
    confidence,
    reasoning: `${serverT(locale, 'reasoning.aiSuggestion').replace('{role}', aiResponse.role).replace('{confidence}', String(Math.round(confidence * 100)))}`,
    metadata: { rawResponse: undefined },
  };
}

export function collectSignals(
  sources: {
    entityContext: { role: string | null; glAccountId: string | null; glAccount?: { code: string; name: string } | null } | null
    userInput: string
    direction: 'debit' | 'credit' | 'mixed'
    assistantConfig: { heuristics: Array<{ keywords: string[]; role: string; glAccountCode: string; direction: string }> }
    aiResponse: { role?: string; glAccountCode?: string } | null
  },
  locale?: string,
): Signal[] {
  return [
    collectEntityContextSignal(sources.entityContext, locale),
    collectHeuristicSignal(sources.userInput, sources.assistantConfig, locale),
    collectAISignal(sources.aiResponse, locale),
  ];
}
