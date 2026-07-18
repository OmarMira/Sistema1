import type { RuleMatchOutput } from './rule-precedence-engine';

export interface RuleResolution {
  matchedRuleId: string | null;
}

export interface ImportRuleResolution extends RuleResolution {
  glAccountId: string | null;
}

export interface AdapterRule {
  id: string;
  name?: string;
  priority?: number;
  glAccountId?: string | null;
  debitGlAccountId?: string | null;
  creditGlAccountId?: string | null;
}

export interface ApplyAllResolvedRule {
  id: string;
  name: string;
  priority: number;
  glAccountId: string | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
}

export interface ApplyAllRuleResolution extends RuleResolution {
  resolvedRule: ApplyAllResolvedRule | null;
}

export function importAdapter(
  match: RuleMatchOutput,
  rules: AdapterRule[],
): ImportRuleResolution {
  if (!match.winner) return { matchedRuleId: null, glAccountId: null };

  const rule = rules.find((r) => r.id === match.winner!.ruleId);
  return {
    matchedRuleId: match.winner.ruleId,
    glAccountId: rule?.glAccountId ?? rule?.debitGlAccountId ?? rule?.creditGlAccountId ?? null,
  };
}

export function applyAllAdapter(
  match: RuleMatchOutput,
  rules: AdapterRule[],
): ApplyAllRuleResolution {
  if (!match.winner) return { matchedRuleId: null, resolvedRule: null };

  const rule = rules.find((r) => r.id === match.winner!.ruleId);
  if (!rule) return { matchedRuleId: match.winner.ruleId, resolvedRule: null };

  return {
    matchedRuleId: match.winner.ruleId,
    resolvedRule: {
      id: rule.id,
      name: rule.name ?? '',
      priority: rule.priority ?? 0,
      glAccountId: rule.glAccountId ?? null,
      debitGlAccountId: rule.debitGlAccountId ?? null,
      creditGlAccountId: rule.creditGlAccountId ?? null,
    },
  };
}

export function previewAdapter(match: RuleMatchOutput): boolean {
  return match.winner !== undefined;
}

export function reconAdapter(
  match: RuleMatchOutput,
  rules: AdapterRule[],
): { ruleId: string; glAccountId: string | null } | null {
  if (!match.winner) return null;

  const rule = rules.find((r) => r.id === match.winner!.ruleId);
  if (!rule) return null;

  return {
    ruleId: rule.id,
    glAccountId: rule.glAccountId ?? rule.debitGlAccountId ?? rule.creditGlAccountId ?? null,
  };
}
