// §GAP9 — Minimal sanitized DTO for transaction decision explanation
// Derived from final-decision-trace (Gap #8); no schema change; no audit exposure

export type DecisionSource =
  | 'KNOWLEDGE'
  | 'RULE'
  | 'AI_HUMAN_APPROVED'
  | 'USER_CORRECTION'
  | 'IMPORT_CORRECTION';

export interface DecisionExplanationDto {
  source: DecisionSource;
  label: string;
  ruleName?: string;
}
