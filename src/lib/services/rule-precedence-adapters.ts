import type { RuleMatchOutput } from './rule-precedence-engine';

export interface ImportRuleResolution {
  matchedRuleId: string | null;
  glAccountId: string | null;
}

export interface AdapterRule {
  id: string;
  name?: string;
  glAccountId?: string | null;
  debitGlAccountId?: string | null;
  creditGlAccountId?: string | null;
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
): { ruleId: string; ruleName: string | undefined; glAccountId: string | null } | null {
  if (!match.winner) return null;

  const rule = rules.find((r) => r.id === match.winner!.ruleId);
  if (!rule) return null;

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    glAccountId: rule.glAccountId ?? rule.debitGlAccountId ?? rule.creditGlAccountId ?? null,
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
