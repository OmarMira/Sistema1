# ADR-009: Deterministic Rule Engine Contract

**Status:** Proposed

---

## Problem and Context

El sistema clasifica transacciones bancarias usando reglas (`BankRule`) pero carece de un motor determinista formal. Hoy:

- Las reglas se evalúan sin orden explícito
- No hay un contrato definido entre entrada y salida
- No existe concepto de `Specificity Score` ni `Match Quality`
- La IA puede proponer clasificaciones incluso cuando hay reglas aplicables
- No hay trazabilidad de "por qué ganó esta regla"

Se necesita un motor determinista que evalúe reglas en orden, resuelva conflictos, puntúe matches, delegue a IA solo cuando corresponde, y explique cada decisión.

---

## Exact Input

```
{
  transaction: {
    id: string
    date: Date
    description: string
    amount: number
    bankAccountId: string
    companyId: string
  },
  context: {
    availableRules: BankRule[]
    entityContexts: EntityContext[]
    historicalMatches: HistoricalMatch[]
  }
}
```

---

## Exact Output

```
{
  decision: {
    type: "rule" | "history" | "entity" | "ai" | "manual"
    ruleId?: string
    candidateList: Candidate[]
    classification: {
      entityId?: string
      category: string
      glAccountId?: string
    }
    explanation: string
  }
}
```

Donde `Candidate`:

```
{
  ruleId: string
  specificity: number
  matchQuality: number
  confidence: number
  conditions: EvaluatedCondition[]
}

EvaluatedCondition {
  type: string
  score: number  // 0..1
  match: boolean
  detail: string
}
```

---

## Rule Model

```
BankRule {
  id: string
  companyId: string
  priority: number           // menor = mayor prioridad. Solo se evalúa después
                             // de specificity y matchQuality. Si ambas son
                             // iguales, priority determina el ganador.
  conditions: Condition[]    // AND lógico entre condiciones
  action: {
    category: string
    entityId?: string
    glAccountId?: string
  }
  isActive: boolean
}
```

### Condition Types

| Type | Description | Example |
|---|---|---|
| `entity_eq` | Entidad específica | `entityId: "..."` |
| `amount_eq` | Monto exacto | `-120.00` |
| `description_matches` | Regex sobre descripción | `/CHECK #\d+/` |
| `description_contains` | Descripción contiene substring | `"DEPOSIT"` |
| `amount_range` | Rango de montos | `[100, 500]` |
| `amount_lt` | Menor que | `< 0` |
| `date_before` | Fecha tope | `2026-01-01` |
| `date_after` | Fecha desde | `2026-01-01` |

**Open question:** ¿soporte para NOT conditions? ¿soporte para OR entre grupos de condiciones?

---

## Rule Lifecycle

Toda regla atraviesa estos estados. Cada estado determina cómo participa en el pipeline.

```
Draft → Testing → Active → Deprecated → Archived
```

| Estado | Auto-aplica | Participa en pipeline | Editable |
|---|---|---|---|
| **Draft** | No | No | Sí |
| **Testing** | No | Sí (simulación, resultados visibles) | Sí |
| **Active** | Sí | Sí | No |
| **Deprecated** | No | Sí (solo read, alerta) | No |
| **Archived** | No | No | No |

Reglas:

- Una regla **Draft** nunca participa en el pipeline de evaluación real
- Una regla **Testing** se evalúa pero no autoaplica — permite ver qué pasaría sin riesgo
- Una regla **Active** participa y autoaplica si cumple los umbrales
- Una regla **Deprecated** aún aparece en candidateList (read) pero no puede ganar ni autoaplicar
- Una regla **Archived** se excluye completamente del pipeline

**Open question:** ¿transición automática de Testing a Active tras N días sin falsos positivos?

---

## Evaluation Pipeline

El pipeline genera los candidatos. Cada paso produce el input del siguiente.

```
Step 1  Collect candidate rules
        └── Filtrar reglas activas de la compañía

Step 2  Evaluate conditions
        └── Por cada regla, evaluar cada condición contra la transacción

Step 3  Discard invalid rules
        └── Descartar reglas donde alguna condición no matchea

Step 4  Produce Candidate for each surviving rule
        └── Cada candidato contiene: ruleId, conditionScores, specificity, matchQuality
```

El output del pipeline es una `Candidate[]`.

---

## Ranking Algorithm

El ranking decide el ganador entre los candidatos producidos por el pipeline.

### Specificity Score

Mide **cuán específica** es una regla. Se calcula como suma ponderada de las condiciones que la componen.

| Condition Type | Weight |
|---|---|
| `entity_eq` | 5 |
| `description_matches` | 4 |
| `amount_eq` | 3 |
| `description_contains` | 2 |
| `amount_range` | 1 |
| `amount_lt`, `date_before`, `date_after` | 1 |

```
specificity = sum(weights of matched conditions)
```

**Open question:** ¿deberían organizarse las condiciones en tiers jerárquicos? Esto evitaría que N condiciones débiles sumen más que una condición muy fuerte, pero es una decisión de negocio que necesita validación con casos reales.

### Match Quality

No es un valor fijo por tipo de condición. Cada condición produce un **conditionScore** (0..1) que depende del resultado específico del match.

| Condition | conditionScore |
|---|---|
| `entity_eq` | 1.0 si coincide, 0 si no |
| `amount_eq` | 1.0 si coincide exactamente, 0 si no |
| `description_matches` | Proporción de la descripción cubierta por el regex (0..1) |
| `description_contains` | `length(match) / length(description)` (0..1) |
| `amount_range` | `max(0, 1 - \|amount - midpoint\| / range)` |
| `amount_lt` | 1.0 si cumple, 0 si no |
| `date_before/after` | 1.0 si cumple, 0 si no |

```
matchQuality = aggregate(conditionScores)
```

**Open question:** ¿qué función aggregate usar? Posibles candidatos: min, weighted average, product, o custom. Se definirá durante el desarrollo del motor.

### Sort

Los candidatos se ordenan por:

1. **Mayor specificity** — la regla más específica primero
2. **Mayor match quality** — desempate por calidad de match (solo si specificity es igual)
3. **Mayor priority** (menor número) — desempate por decisión del usuario (solo si specificity Y match quality son iguales)
4. **Fecha de creación más reciente** — último recurso

`priority` solo se evalúa después de `specificity` y `match quality`. Si ambas son iguales entre dos reglas, `priority` determina el ganador. No overridea la especificidad técnica bajo ninguna circunstancia.

### Ambiguity Resolution

```
winner.score - second.score < DELTA → AMBIGUOUS
winner.score - second.score >= DELTA → winner claro
```

| Escenario | Resultado |
|---|---|
| Una regla domina: score 20 vs 5 | Winner claro |
| Dos reglas muy cercanas: score 18 vs 17 | Ambiguo (delta = 1) |
| Una sola regla candidata: score 15 vs — | Winner claro (no hay segunda) |
| Ninguna regla | `NO_MATCH` |

---

## Confidence

Son **tres métricas independientes**:

| Métrica | Rango | Descripción |
|---|---|---|
| `specificity` | number | Suma ponderada de condiciones matcheadas |
| `matchQuality` | 0..1 | Qué tan bien matchea contra esta transacción |
| `confidence` | 0..1 | Métrica compuesta (definible después, no afecta selección) |

El output siempre expone las tres. El cálculo de `confidence` puede cambiar en el futuro sin afectar el ranking ni la selección.

---

## No Auto-Apply Policy

El motor **nunca** autoaplica una regla si:

- El resultado de ambiguity resolution es `AMBIGUOUS` (distancia entre candidatos < DELTA)
- Hay más de una regla candidata sin un ganador claro
- La transacción ya fue clasificada previamente (por regla o manual)
- La regla fue creada hace menos de N horas (período de prueba — **open question**)

En esos casos, la transacción queda en estado `pending` hasta decisión humana.

---

## IA Role (Hard Boundary)

**La IA JAMÁS participa en el algoritmo de selección del motor determinista.**

- Nunca desempata entre reglas
- Nunca modifica scores ni prioridades
- Nunca altera la decisión del motor
- Nunca se consulta durante el pipeline de evaluación ni el ranking

Su única función es **proponer una clasificación** cuando el motor devuelve exclusivamente `NO_MATCH` o `AMBIGUOUS`. Y esa propuesta siempre requiere aprobación humana.

---

## Explainability

El motor produce una explicación legible para cada decisión:

| Scenario | Explanation |
|---|---|
| Winner claro | `"Rule 'Depósitos > 500' won (specificity=6, quality=1.0, confidence=0.85). Candidates: [Rule A: 6, Rule B: 3]. Conditions: description contains 'DEPOSIT' AND amount > 500"` |
| Empate resuelto por priority | `"Tie between 'Cheque > 1000' and 'Pago proveedores' (both specificity=5, quality=0.8). Resolved by user priority: 1 vs 2"` |
| Ambiguo | `"Ambiguous: Rule A (score 18) vs Rule B (score 17) — delta 1 < threshold 3. Manual classification required"` |
| Sin regla → IA | `"No rule matched. Delegated to AI. AI proposed: 'Software subscription' (confidence 78%)"` |
| Sin regla → sin IA | `"No rule matched and no AI configured. Flagged for manual classification"` |

---

## Audit

No se guarda solo el ganador. Se guarda la **candidateList completa**:

```json
{
  "engineVersion": "2.0",
  "decision": "rule",
  "winner": { "ruleId": "A", "specificity": 6, "matchQuality": 0.9, "confidence": 0.85 },
  "candidates": [
    { "ruleId": "A", "specificity": 6, "matchQuality": 0.9 },
    { "ruleId": "B", "specificity": 5, "matchQuality": 0.7 },
    { "ruleId": "C", "specificity": 3, "matchQuality": 0.4 }
  ],
  "delta": 1,
  "threshold": 3,
  "result": "ambiguous",
  "explanation": "...",
  "timestamp": "..."
}
```

Esto permite auditar no solo qué ganó, sino **contra qué compitió**.

---

## Invariants

- **Determinismo**: misma entrada + mismas reglas + misma configuración → mismo resultado. Siempre.
- **Resultado único**: una transacción produce exactamente un resultado: `WINNER`, `AMBIGUOUS`, o `NO_MATCH`. Nunca dos al mismo tiempo.
- Ninguna regla puede modificar transacciones históricas
- Un match con delta >= DELTA se autoaplica
- Toda decisión (autoaplicada o no) queda registrada en `AuditLog` con candidateList completa
- Si no hay reglas y no hay IA, la transacción queda `pending` — nunca se pierde
- El motor nunca evalúa reglas inactivas
- La IA nunca modifica el estado interno del motor

---

## Out of Scope (v1.0)

- Reglas con condiciones anidadas (AND/OR tree) → v2.1
- Reglas globales (sin `companyId`) → v2.1
- Plugins o lógica personalizada en reglas → v2.1 (si se acepta)
- Rollback / simulación de reglas nuevas → v2.2
- Fuzzy matching sobre descripciones (levenshtein) → v2.2
- UI para crear/ordenar reglas → frontend sprint
- Tiers jerárquicos en specificity → future evaluation (requiere validación con casos reales)

---

## Acceptance Criteria

1. Dada una transacción y una regla que matchea, el motor devuelve la regla con specificity > 0
2. Dada una transacción y dos reglas, gana la de mayor specificity
3. Dada una transacción y dos reglas con igual specificity, gana la de mayor match quality
4. Dada una transacción sin reglas, el motor devuelve `NO_MATCH`
5. Dada una transacción con dos reglas cercanas (delta < threshold), el motor devuelve `AMBIGUOUS`
6. La IA recibe solo transacciones con resultado `NO_MATCH` o `AMBIGUOUS`
7. El AuditLog contiene la candidateList completa del proceso
8. Cambiar el priority de una regla cambia el resultado solo si hay empate en specificity y match quality
9. El motor no modifica la transacción original bajo ninguna circunstancia
10. Dada una sola regla candidata, el motor nunca devuelve `AMBIGUOUS`
11. Misma entrada + mismas reglas + misma configuración produce exactamente el mismo resultado en ejecuciones repetidas

---

## Open Questions (pending approval)

| Pregunta | Impacto |
|---|---|
| ¿Deberían organizarse las condiciones en tiers jerárquicos (ej. entity_eq siempre > amount_eq)? | **Crítico**: decisión de negocio que necesita validación con casos reales |
| ¿Función aggregate para matchQuality? Posibles: min, weighted average, product, custom | Afecta el score final en reglas multi-condición |
| ¿Transición automática de Testing a Active tras N días sin falsos positivos? | Afecta el Rule Lifecycle |
| ¿Soporte para NOT conditions? | Cambia el modelo de condition |
| ¿Soporte para OR entre grupos? | Requiere tree structure en conditions |
| ¿DELTA de ambigüedad global o configurable por empresa? | Afecta granularidad de configuración |
| ¿Período de prueba para reglas nuevas? | Afecta política de auto-apply |
| ¿Reglas puramente declarativas o permiten lógica personalizada (plugins/scripts)? | **Crítico**: declarativas = motor mantenible. Plugins = cambia completamente la arquitectura |
| ¿Rollback de reglas aplicadas por error? | Requiere compensación manual |
