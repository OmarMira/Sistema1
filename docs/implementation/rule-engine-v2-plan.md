# Rule Engine v2 — Implementation Plan

**Based on:** ADR-009 (Accepted)
**Status:** Plan — ready for sprint execution

---

## Sprint 0: Compatibility & Baseline

Auditar el estado actual antes de tocar código.

### Tasks

- Auditar modelo `BankRule` en Prisma: `conditions` actuales, `isActive`, `priority`
- Mapear reglas legacy al nuevo contrato (`condition` types, estados lifecycle)
- Definir feature flag `RULE_ENGINE_V2_ENABLED` (env var + default `false`)
- Definir `engineVersion` string format (ej. `"2.0.0"`)
- Confirmar si se necesita migración de DB (nuevos campos: `status`, etc.)
- Capturar casos reales de referencia para fixtures de test

### Files to create

| File | Purpose |
|---|---|
| `src/lib/rule-engine/flag.ts` | `isRuleEngineV2Enabled(): boolean` |
| `src/lib/rule-engine/compat.ts` | Mapeo de reglas legacy al nuevo modelo |

### Feature flag

```
RULE_ENGINE_V2_ENABLED=false (default)
  → sistema actual (sin cambios)

RULE_ENGINE_V2_ENABLED=true
  → nuevo motor activo
```

Comportamiento: el flag se lee una vez al arrancar. Requiere restart para cambiar. Tests deben verificar ambos caminos.

### Deliverable

Inventario de compatibilidad completo + feature flag operativo + fixtures reales listos.

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
| `src/lib/rule-engine/index.ts` | Public API entry point, gated by feature flag |

### Acceptance (from ADR-009)

- AC#4: Sin reglas → `NO_MATCH`
- AC#9: Motor no modifica transacción original
- AC#11: Misma entrada → mismo resultado

### Deliverable

Pipeline que acepta input, filtra reglas activas (según lifecycle), evalúa condiciones, descarta inválidas, y produce `Candidate[]`. Sin ranking todavía.

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

### Aggregate & DELTA definition

`aggregate()` y `DELTA` se definen al inicio del sprint **mediante casos reales y tests comparativos**, no por intuición. Posibles candidatos para aggregate: min, weighted average, product. Se elige el que mejor se comporte con los fixtures reales.

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
| `src/lib/services/import.service.ts` | Replace inline classification with Rule Engine call (gated by flag) |
| `src/lib/bank-profiles/*.ts` | Ensure bank profiles pass correct data to engine |

### Files to create

| File | Purpose |
|---|---|
| `tests/integration/rule-engine-import.test.ts` | End-to-end: import → pipeline → ranking → classification |

### Acceptance

- A importar un extracto, las transacciones pasan por el Rule Engine (si flag activo)
- Reglas activas se aplican automáticamente
- Reglas en Testing se evalúan pero no autoaplican
- Con flag `false`, el sistema se comporta exactamente como antes

### Deliverable

Rule Engine reemplaza la clasificación inline actual cuando el flag está activo. Convivencia segura con el sistema legacy.

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

Hipótesis: no debería haber breaking changes en el pipeline de datos. Se confirma en Sprint 0. El motor actual se reemplaza progresivamente:

1. Sprint 0: feature flag + compatibilidad auditada
2. Sprint 1–2: motor nuevo en paralelo, detrás del flag
3. Sprint 3: reemplazar clasificación inline (flag=true)
4. Sprint 4–5: auditoría y AI encima del motor nuevo

En cualquier punto se puede revertir al comportamiento anterior cambiando `RULE_ENGINE_V2_ENABLED=false`.
