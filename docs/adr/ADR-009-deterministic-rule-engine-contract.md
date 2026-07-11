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
  priority: number           // menor = evalúa primero (decisión humana)
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

| Type | Tier | Description | Example |
|---|---|---|---|
| `entity_eq` | 1 | Entidad específica | `entityId: "..."` |
| `amount_eq` | 2 | Monto exacto | `-120.00` |
| `description_matches` | 3 | Regex sobre descripción | `/CHECK #\d+/` |
| `description_contains` | 4 | Descripción contiene substring | `"DEPOSIT"` |
| `amount_range` | 4 | Rango de montos | `[100, 500]` |
| `amount_lt` | 5 | Menor que | `< 0` |
| `date_before` | 5 | Fecha tope | `2026-01-01` |
| `date_after` | 5 | Fecha desde | `2026-01-01` |

**Open question:** ¿soporte para NOT conditions? ¿soporte para OR entre grupos de condiciones?

---

## Evaluation Pipeline

El motor sigue exactamente estos pasos en orden. Cada paso es una etapa independiente y testeable.

```
Step 1  Collect candidate rules
        └── Filtrar reglas activas de la compañía

Step 2  Evaluate conditions
        └── Por cada regla, evaluar cada condición contra la transacción

Step 3  Discard invalid rules
        └── Descartar reglas donde alguna condición no matchea

Step 4  Compute condition scores
        └── Cada condición produce un conditionScore (0..1)

Step 5  Compute specificity
        └── Asignar tier jerárquico + pesos dentro del tier

Step 6  Compute match quality
        └── aggregate(conditionScores) para cada regla

Step 7  Sort by hierarchy
        └── 1. Tier más alto (más específico)
        └── 2. Mayor specificity dentro del tier
        └── 3. Mayor match quality

Step 8  Apply user priority
        └── El usuario puede overridear el orden vía priority
        └── Dos reglas del mismo tier: gana la de mayor priority

Step 9  Resolve ambiguity
        └── winner.score - second.score < delta → AMBIGUOUS
        └── Sino → winner

Step 10 Return decision
         └── type, winner, candidateList completa, explanation
```

---

## Specificity Score (Tier Hierarchy)

No es una suma lineal. El specificity se organiza en **tiers jerárquicos**. Una condición de tier superior siempre pesa más que cualquier combinación de tiers inferiores.

| Tier | Condition Type | Weight within tier |
|---|---|---|
| 1 (máximo) | `entity_eq` | 5 |
| 2 | `amount_eq` | 3 |
| 3 | `description_matches` | 4 |
| 4 | `description_contains`, `amount_range` | 2 |
| 5 (mínimo) | `amount_lt`, `date_before`, `date_after` | 1 |

```
specificity = (tier, sum(weights_in_tier))
```

Comparación: primero se compara `tier` (menor número = más específico). Si empatan en tier, se compara `sum(weights_in_tier)`.

Esto evita que cuatro condiciones débiles (tier 4) derroten una condición extremadamente específica (tier 1).

**Open question:** ¿los pesos intra-tier deben ser configurables?

---

## Match Quality

No es un valor fijo por tipo de condición. Cada condición produce un **conditionScore** (0..1) que depende del resultado específico del match.

### conditionScore por tipo

| Condition | conditionScore |
|---|---|
| `entity_eq` | 1.0 si coincide, 0 si no |
| `amount_eq` | 1.0 si coincide exactamente, 0 si no |
| `description_matches` | Proporción de la descripción cubierta por el regex (0..1) |
| `description_contains` | `length(match) / length(description)` (0..1) |
| `amount_range` | `max(0, 1 - \|amount - midpoint\| / range)` |
| `amount_lt` | 1.0 si cumple, 0 si no |
| `date_before/after` | 1.0 si cumple, 0 si no |

### matchQuality (aggregate)

```
matchQuality = min(conditionScores)

// O: promedio(conditionScores)
// O: producto(conditionScores)
```

**Open question:** ¿qué función aggregate usar? ¿mínimo, promedio o producto?

---

## Ambiguity Threshold

La ambigüedad no depende del valor absoluto del score. Depende de la **distancia entre el ganador y el segundo**.

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

**Open question:** ¿valor de DELTA global o configurable por empresa?

---

## Confidence

No se calcula como `specificity * matchQuality`. Son **tres métricas independientes**:

| Métrica | Rango | Descripción |
|---|---|---|
| `specificity` | (tier, weight) | Qué tan específica es la regla en abstracto |
| `matchQuality` | 0..1 | Qué tan bien matchea contra esta transacción |
| `confidence` | 0..1 | Métrica compuesta (definible después: ej. `matchQuality * (specificity.weight / maxWeight)`) |

El output siempre expone las tres. El cálculo de `confidence` puede cambiar en el futuro sin afectar el pipeline de selección.

---

## Tie-breaking Order

Después de aplicar la jerarquía de tiers y el priority del usuario, el desempate sigue este orden:

1. **Mayor specificity weight** (dentro del mismo tier)
2. **Mayor match quality**
3. **Mayor priority numérica** (menor número = mayor prioridad)
4. **Fecha de creación más reciente**

La prioridad del usuario **no** es parte del tie-breaking — se aplica como paso separado (Step 8) **antes** de resolver ambigüedad, para que un usuario pueda overridear la jerarquía técnica cuando sea necesario.

---

## No Auto-Apply Policy

El motor **nunca** autoaplica una regla si:

- El resultado del Step 9 es `AMBIGUOUS` (distancia entre candidatos < DELTA)
- Hay más de una regla candidata sin un ganador claro
- La transacción ya fue clasificada previamente (por regla o manual)
- La regla fue creada hace menos de N horas (período de prueba — **open question**)

En esos casos, la transacción queda en estado `pending` hasta decisión humana.

---

## IA Role (Hard Boundary)

**La IA JAMÁS participa en el algoritmo de selección del motor determinista.**

- Nunca desempata entre reglas
- Nunca modifica scores, tiers ni prioridades
- Nunca altera la decisión del motor
- Nunca se consulta durante el pipeline de evaluación

Su única función es **proponer una clasificación** cuando el motor devuelve exclusivamente `NO_MATCH` o `AMBIGUOUS`. Y esa propuesta siempre requiere aprobación humana.

---

## Explainability

El motor produce una explicación legible para cada decisión:

| Scenario | Explanation |
|---|---|
| Winner claro | `"Rule 'Depósitos > 500' won (specificity=tier4/6, quality=1.0, confidence=0.85). Candidates: [Rule A: 6, Rule B: 3]. Conditions: description contains 'DEPOSIT' AND amount > 500"` |
| Empate resuelto por priority | `"Tie between 'Cheque > 1000' (tier4/5) and 'Pago proveedores' (tier4/5). Resolved by user priority: 1 vs 2"` |
| Ambiguo | `"Ambiguous: Rule A (score 18) vs Rule B (score 17) — delta 1 < threshold 3. Manual classification required"` |
| Sin regla → IA | `"No rule matched. Delegated to AI. AI proposed: 'Software subscription' (confidence 78%)"` |
| Sin regla → sin IA | `"No rule matched and no AI configured. Flagged for manual classification"` |

---

## Audit

No se guarda solo el ganador. Se guarda la **candidateList completa**:

```json
{
  "decision": "rule",
  "winner": { "ruleId": "A", "specificity": "tier4/6", "matchQuality": 0.9, "confidence": 0.85 },
  "candidates": [
    { "ruleId": "A", "specificity": "tier4/6", "matchQuality": 0.9 },
    { "ruleId": "B", "specificity": "tier4/5", "matchQuality": 0.7 },
    { "ruleId": "C", "specificity": "tier3/4", "matchQuality": 0.4 }
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

- Ninguna regla puede modificar transacciones históricas
- Un match con delta >= DELTA y matchQuality >= UMBRAL_CALIDAD se autoaplica
- Toda decisión (autoaplicada o no) queda registrada en `AuditLog` con candidateList completa
- Si no hay reglas y no hay IA, la transacción queda `pending` — nunca se pierde
- El motor nunca evalúa reglas inactivas
- El tie-breaking nunca puede producir "sin ganador" (siempre hay un resultado: winner, ambiguous, o no_match)
- La IA nunca modifica el estado interno del motor

---

## Out of Scope (v1.0)

- Reglas con condiciones anidadas (AND/OR tree) → v2.1
- Reglas globales (sin `companyId`) → v2.1
- Plugins o lógica personalizada en reglas → v2.1 (si se acepta)
- Rollback / simulación de reglas nuevas → v2.2
- Fuzzy matching sobre descripciones (levenshtein) → v2.2
- UI para crear/ordenar reglas → frontend sprint

---

## Acceptance Criteria

1. Dada una transacción y una regla que matchea, el motor devuelve la regla con tier > 0
2. Dada una transacción y dos reglas de distinto tier, gana la de tier más alto (ej. amount_eq sobre description_contains)
3. Dada una transacción y dos reglas del mismo tier, gana la de mayor weight dentro del tier
4. Dada una transacción sin reglas, el motor devuelve `NO_MATCH`
5. Dada una transacción con dos reglas cercanas (delta < threshold), el motor devuelve `AMBIGUOUS`
6. La IA recibe solo transacciones con resultado `NO_MATCH` o `AMBIGUOUS`
7. El AuditLog contiene la candidateList completa del proceso
8. Cambiar el priority de una regla cambia el resultado cuando hay empate intra-tier
9. El motor no modifica la transacción original bajo ninguna circunstancia
10. Dada una sola regla candidata, el motor nunca devuelve `AMBIGUOUS`

---

## Open Questions (pending approval)

| Pregunta | Impacto |
|---|---|
| ¿Pesos intra-tier configurables o fijos? | Si son configurables, requieren UI |
| ¿Función aggregate para matchQuality: min, avg, o product? | Afecta el score final en reglas multi-condición |
| ¿Soporte para NOT conditions? | Cambia el modelo de condition |
| ¿Soporte para OR entre grupos? | Requiere tree structure en conditions |
| ¿DELTA de ambigüedad global o por empresa? | Afecta granularidad de configuración |
| ¿Período de prueba para reglas nuevas? | Afecta política de auto-apply |
| ¿Reglas puramente declarativas o permiten lógica personalizada (plugins/scripts)? | **Crítico**: declarativas = motor mantenible. Plugins = cambia completamente la arquitectura |
| ¿Rollback de reglas aplicadas por error? | Requiere compensación manual |
