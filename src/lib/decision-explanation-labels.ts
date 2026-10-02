// §GAP9 — Deterministic label mapping (no AI generation)
import type { DecisionSource, DecisionExplanationDto } from './types/decision-explanation';

export function buildExplanationLabel(source: DecisionSource, ruleName?: string): string {
  switch (source) {
    case 'KNOWLEDGE':
      return 'Conocimiento confirmado de esta empresa';
    case 'RULE':
      return ruleName ? `Regla: ${ruleName}` : 'Regla automática';
    case 'AI_HUMAN_APPROVED':
      return 'Sugerencia de IA aprobada por usuario';
    case 'USER_CORRECTION':
      return 'Corrección previa del usuario';
    case 'IMPORT_CORRECTION':
      return 'Corrección realizada durante la revisión de importación';
    default:
      return 'Clasificación registrada';
  }
}

export function buildDecisionExplanation(
  source: DecisionSource,
  ruleName?: string,
): DecisionExplanationDto {
  return {
    source,
    label: buildExplanationLabel(source, ruleName),
    ...(ruleName ? { ruleName } : {}),
  };
}
