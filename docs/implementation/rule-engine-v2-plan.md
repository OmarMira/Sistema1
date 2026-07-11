# Rule Engine v2 — Implementation Plan

**Based on:** ADR-009 (Accepted)
**Status:** Plan — ready for sprint execution

---

## Sprint 1: Empty Deterministic Pipeline

Construir la estructura del motor sin lógica de ranking.

### Files to create

| File | Purpose |
|---|---|
| `src/lib/rule-engine/pipeline.ts` | Evaluation pipeline orchestrator (Step 1–4) |
| `src/lib/rule-engine/types.ts` | `Candidate`, `EvaluatedCondition`, `Decision`, `RuleInput`, `RuleOutput` |
| `src/lib/rule-engine/errors.ts` | Error types for the engine |
| `tests/rule-engine/pipeline.test.ts` | Pipeline unit tests |

### Files to modify

| File | Change |
|---|---|
| `src/lib/rule-engine/index.ts` | Public API entry point |

### Acceptance (from ADR-009)

- AC#4: Sin reglas → `NO_MATCH`
- AC#9: Motor no modifica transacción original
- AC#11: Misma entrada → mismo resultado

### Deliverable

Pipeline que acepta input, filtra reglas activas, evalúa condiciones, descarta inválidas, y produce `Candidate[]`. Sin ranking todavía.

---

## Sprint 2: Ranking — Specificity, MatchQuality, Sort, Ambiguity

### Files to create

| File | Purpose |
|---|---|
| `src/lib/rule-engine/specificity.ts` | `computeSpecificity(candidate): number` |
| `src/lib/rule-engine/match-quality.ts` | `computeMatchQuality(candidate): number` |
| `src/lib/rule-engine/ranking.ts` | Sort + tie-breaking + ambiguity resolution |
| `tests/rule-engine/specificity.test.ts` | Specificity tests |
| `tests/rule-engine/match-quality.test.ts` | Match quality tests |
| `tests/rule-engine/ranking.test.ts` | Ranking + ambiguity tests |

### Acceptance (from ADR-009)

- AC#1: Regla matchea → specificity > 0
- AC#2: Dos reglas → gana la de mayor specificity
- AC#3: Igual specificity → gana la de mayor match quality
- AC#5: Dos reglas cercanas (delta < threshold) → `AMBIGUOUS`
- AC#8: Priority solo desempata si specificity y match quality son iguales
- AC#10: Una sola candidata → nunca `AMBIGUOUS`

### Deliverable

Ranking completo: specificity score → match quality → sort → priority → ambiguity resolution.

---

## Sprint 3: Integration with Import System

### Files to modify

| File | Change |
|---|---|
| `src/lib/services/import.service.ts` | Replace inline classification with Rule Engine call |
| `src/lib/bank-profiles/*.ts` | Ensure bank profiles pass correct data to engine |

### Files to create

| File | Purpose |
|---|---|
| `tests/integration/rule-engine-import.test.ts` | End-to-end: import → pipeline → ranking → classification |

### Acceptance

- A importar un extracto, las transacciones pasan por el Rule Engine
- Reglas activas se aplican automáticamente
- Reglas en Testing se evalúan pero no autoaplican
- `AuditLog` contiene candidateList completa

### Deliverable

Rule Engine reemplaza la clasificación inline actual. El sistema importa y clasifica usando el nuevo motor.

---

## Sprint 4: Explainability, Audit, Metrics

### Files to create

| File | Purpose |
|---|---|
| `src/lib/rule-engine/explain.ts` | `generateExplanation(decision, candidates): string` |
| `src/lib/rule-engine/audit.ts` | `buildAuditLog(decision, engineVersion): AuditLogEntry` |
| `tests/rule-engine/explain.test.ts` | Explanation tests |
| `tests/rule-engine/audit.test.ts` | Audit log tests |

### Files to modify

| File | Change |
|---|---|
| `src/lib/services/import.service.ts` | Wire audit log after engine decision |
| `prisma/schema.prisma` | Add `engineVersion` field to AuditLog if missing |

### Acceptance (from ADR-009)

- AC#7: AuditLog contiene candidateList completa
- Todo `AuditLog` incluye `engineVersion`
- Cada escenario de explainability produce mensaje legible

### Deliverable

Motor trazable: cada decisión se explica y se audita con candidateList + engineVersion.

---

## Sprint 5: AI as Fallback

### Files to create

| File | Purpose |
|---|---|
| `src/lib/rule-engine/ai-bridge.ts` | Bridge que recibe `NO_MATCH`/`AMBIGUOUS` y llama a AI |
| `tests/rule-engine/ai-bridge.test.ts` | AI bridge tests |

### Files to modify

| File | Change |
|---|---|
| `src/lib/rule-engine/index.ts` | Wire AI bridge after ranking |
| `src/lib/services/import.service.ts` | Ensure AI proposals go to pending, not auto-approved |

### Acceptance (from ADR-009)

- AC#6: IA recibe solo `NO_MATCH` o `AMBIGUOUS`
- IA nunca modifica scores, prioridades ni decisión del motor
- Propuesta de IA requiere aprobación humana

### Deliverable

IA conectada como fallback exclusivo, sin capacidad de influir en el motor determinista.

---

## Migration Strategy

No hay breaking changes. El motor actual se reemplaza progresivamente:

1. Sprint 1–2: motor nuevo en paralelo, sin integrar
2. Sprint 3: reemplazar clasificación inline con nuevo motor
3. Sprint 4–5: auditoría y AI encima del motor nuevo

En cualquier punto se puede revertir al comportamiento anterior desactivando el flag de feature.

---

## Open implementation questions

| Question | Resolved by |
|---|---|
| `DELTA` valor inicial | Definir en Sprint 2 con caso real |
| `aggregate()` fórmula inicial | Empezar con `min` en Sprint 2, ajustar con datos |
| Testing → Active transición | Manual en v1.0, automática en v2.1 |
| engineVersion string | `"2.0.0"` para primera release |
