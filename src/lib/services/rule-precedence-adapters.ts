import type { RuleMatchOutput } from './rule-precedence-engine';

export interface RuleResolution {
  matchedRuleId: string | null;
}

export interface AiProposalData {
  role: string;
  glAccountCode: string;
  glAccountId: string | null;
  conditions?: { field: string; operator: string; value: string | number }[];
  suggestSubAccount: boolean;
  subAccountName: string | null;
}

export interface ImportRuleResolution extends RuleResolution {
  glAccountId: string | null;
  deterministicResult?: 'winner' | 'no_match' | 'ambiguous';
  aiProposal?: AiProposalData;
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

export interface AmbiguousCandidate {
  ruleId: string;
  ruleName: string;
  confidenceLabel: 'high' | 'medium' | 'low';
  matchQuality: number;
  specificityScore: number;
  evaluatedConditions: { type: string; detail: string }[];
}

export interface ApplyAllRuleResolution extends RuleResolution {
  resolvedRule: ApplyAllResolvedRule | null;
  confidenceLabel?: 'high' | 'medium' | 'low';
  matchQuality?: number;
  specificityScore?: number;
  evaluatedConditions?: { type: string; detail: string }[];
  ambiguousCandidates?: AmbiguousCandidate[];
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
  if (!match.winner) {
    return {
      matchedRuleId: null,
      resolvedRule: null,
      ambiguousCandidates: match.ambiguous
        ? match.candidates.map((c) => {
            const ruleInfo = rules.find((r) => r.id === c.ruleId);
            return {
              ruleId: c.ruleId,
              ruleName: ruleInfo?.name ?? c.ruleId,
              confidenceLabel: c.confidenceLabel,
              matchQuality: c.matchQuality,
              specificityScore: c.specificityScore,
              evaluatedConditions: c.evaluatedConditions,
            };
          })
        : undefined,
    };
  }

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
    confidenceLabel: match.winner.confidenceLabel,
    matchQuality: match.winner.matchQuality,
    specificityScore: match.winner.specificityScore,
    evaluatedConditions: match.winner.evaluatedConditions,
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
