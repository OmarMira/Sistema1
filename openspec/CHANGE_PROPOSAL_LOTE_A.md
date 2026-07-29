# CHANGE_PROPOSAL_LOTE_A — Resolver V3 vs V5.1 en design.md + Separar dominios Readiness

**Estado**: PROPUESTA (pendiente de aprobación)
**Fecha**: 2026-07-29
**Arquitecto**: Sistema1
**Documento target**: `openspec/accounting-readiness-center/design.md`
**Documentos secundarios**: `docs/glossary.md`

---

## 1. Declaración del conflicto

El archivo `design.md` (674 líneas) contiene **dos definiciones de contrato que coexisten sin relación documentada**:

### Contrato V3 (líneas 1–265, más secciones 2–8 desde línea 257 hasta el final)

Definiciones clave:
- `interface ReadinessAssessment` → `{ period: PeriodInfo, globalState, confidence: number, blockers: Blocker[], warnings: Warning[], primaryRecommendation, nextActions, healthScore, evaluatedAt }`
- `interface ActionRef` → `{ type: ActionType, entityId?, companyId?, periodId?, params? }`
- `interface Blocker` → `{ area, severity: 1|2|3, title, description, count, action, category }`
- `interface Warning` → `{ area, title, description, impact, action?, category }`
- `interface Finding` → `{ ruleId, type, severity, area, title, description, action?, estimatedImpact }`
- `interface HealthScore` → `{ total, deductions: HealthDeduction[], confidence, trend }`
- `interface DecisionTrace` → `{ rulesEvaluated, blockersFound, warningsFound, recommendationLog, confidenceFactors, durationMs }`
- Pipeline: `RulesEngine → PrioritizationEngine → RecommendationBuilder`
- `ConfidenceCalculator` implementado como clase separada
- Secciones 2–8: integridad como propiedad del dominio, endpoint, UI, plan de implementación, confianza, naming

### Contrato V5.1 (líneas 328–507)

Definiciones clave:
- `interface RuleDefinition` → `{ id, type, domain, dependsOn, predicate, actionBuilder }`
- `interface EvaluationSnapshot` → data frozen para evaluación pura (reemplaza EvaluationContext)
- `interface AssessmentFinding` → unifica Blocker + Warning (reemplaza Blocker, Warning, Finding individuales)
- `interface ActionRef` → `{ command, requiredCapability, params }` — ESTRUCTURA DIFERENTE a V3
- `interface Recommendation` → `{ priority, action, reasonCode, blockingRuleIds, estimatedImpact }`
- `interface HealthScore` → `{ score, deductions, bonuses, calculationVersion, version }` — ESTRUCTURA DIFERENTE a V3
- `interface ReadinessAssessment` → `{ periodId, globalState, confidence: { score, reasons[] }, blockers: AssessmentFinding[], warnings: AssessmentFinding[], primaryRecommendation, nextActions, healthScore }` — ESTRUCTURA DIFERENTE a V3
- `interface ReadinessResponse` → `{ assessment, version: { contractVersion, engineVersion, ruleSetVersion }, trace? }`
- `interface HealthScoreRule` → reglas declarativas con condition/explanation

---

## 2. Análisis de impacto

### 2.1 Impacto en arquitectura base

| Aspecto | V3 | V5.1 | Diferencia |
|---|---|---|---|
| `ActionRef.type` (dominio) | `'close_fiscal_period'`, `'classify_entities'`, etc. | `'OPEN_RECONCILIATION'`, `'OPEN_ENTITY_CLASSIFICATION'`, etc. | **Ruptura total** — naming y estructura distintos |
| `ActionRef.params` | `Record<string, string>` | `Record<string, string \| undefined>` | Compatible |
| HealthScore | `total` (100 - deductions), tiene `trend` | `score` (100 + deductions + bonuses), tiene `version` | **Ruptura parcial** — cálculo diferente |
| Confidence | `number` (0-1) escalar | `{ score: number, reasons: string[] }` objeto | **Ruptura total** — tipo diferente |
| Blocker / Warning | Interfaces separadas | Unificadas en `AssessmentFinding` | **Ruptura total** — modelo diferente |
| ReadinessResponse | No existe como tipo separado | Envuelve assessment + version + trace | **Adición** (compatible hacia adelante) |
| EvaluationSnapshot | `EvaluationContext` (objeto mutable) | `EvaluationSnapshot` (foto congelada) | **Ruptura conceptual** — cambia paradigma |
| `dependsOn` en reglas | No existe | `RuleDefinition.dependsOn: RuleId[]` | **Adición** |
| `sourceModule` en findings | No existe | `AssessmentFinding.sourceModule: RuleModule` | **Adición** |
| `blockingRuleIds` en recs | No existe | `Recommendation.blockingRuleIds` | **Adición** |
| Bonuses en HealthScore | Solo deductions | Deductions + bonuses | **Adición** |
| Version tracking | No existe | `HealthScore.calculationVersion` + `ReadinessResponse.version` | **Adición** |

### 2.2 Impacto en contratos de módulos

Si se elige **V5.1 como canónico**, los siguientes módulos ven afectados sus contratos:

- **`src/lib/readiness/readiness.service.ts`**: El `assess()` debe devolver `ReadinessAssessment` con confidence como objeto, no como número
- **`src/lib/readiness/rules/`**: Las reglas deben implementar `RuleDefinition.predicate(snapshot)` en lugar de `condition(ctx)`
- **`src/lib/readiness/rules-engine.ts`**: Debe aceptar `EvaluationSnapshot` en lugar de `EvaluationContext`
- **`src/lib/readiness/prioritization-engine.ts`**: Debe rankear `AssessmentFinding[]` en lugar de `Finding[]`
- **`src/lib/readiness/recommendation-builder.ts`**: Debe producir `Recommendation` con `blockingRuleIds`
- **`src/lib/readiness/confidence-calculator.ts`**: Eliminar o refactorizar — V5.1 no lo usa (confidence se construye desde reasons[])
- **Frontend `ActionMapper`**: Debe mapear `command` (mayúsculas) en lugar de `type` (snake_case)
- **Endpoint**: Debe devolver `ReadinessResponse` con metadatos de versión

### 2.3 Impacto en glosario

No hay términos en el glosario actual que choquen con V3 o V5.1. El glosario existente (`docs/glossary.md`) no cubre readiness. Se agregarán dos entradas nuevas (ver sección 5).

### 2.4 Impacto en código implementado

**No hay código implementado para Accounting Readiness Center.** El código existente en `src/lib/readiness/` es de Shadow Rules Readiness y no debe mezclarse. Esto significa que **elegir entre V3 y V5.1 no rompe ningún código existente** — es una decisión puramente de diseño.

### 2.5 Impacto en prompts / reglas de IA

Los agentes que carguen `design.md` verán dos contratos simultáneos. Esto ya causó ambigüedad (ver sección 3). La resolución debe ser visible para futuros agentes vía el Document Authority Map.

---

## 3. Detección de conflictos

### C3.1 — V5.1 contradice V3 en tipos fundamentales

| Elemento | V3 dice | V5.1 dice | ¿Son compatibles? |
|---|---|---|---|
| `confidence` | `number` (0-1) | `{ score: number, reasons: string[] }` | **No** — son tipos distintos |
| `HealthScore` | `{ total, deductions, confidence, trend }` | `{ score, deductions: { ruleId, points, reasonCode }[], bonuses[], calculationVersion, version }` | **No** — estructura, campos y semántica distintos |
| `ActionRef` | `{ type, entityId?, companyId?, periodId?, params? }` | `{ command, requiredCapability, params }` | **No** — campos y valores distintos |
| `Blocker` / `Warning` | Interfaces separadas | `AssessmentFinding` unificado | **No** — modelo diferente |
| `ReadinessAssessment.period` | `PeriodInfo` (objeto rico) | `periodId: string` solo | **No** — se pierde metadata |
| `ReadinessAssessment` | Tiene `evaluatedAt: string` | No tiene `evaluatedAt` | **Parcial** — se pierde campo |

**Conclusión**: V5.1 **no es una evolución compatible** de V3. Es un **rediseño**. No se pueden conservar ambos.

### C3.2 — V3 tiene secciones que V5.1 no cubre

| Sección V3 | ¿Cubierta por V5.1? |
|---|---|
| Section 2: Integridad como propiedad del dominio | No — pero es independiente de los tipos, describe el patrón arquitectónico |
| Section 4: Endpoint | Parcialmente — V5.1 tiene `ReadinessResponse` pero no describe el endpoint en sí |
| Section 5: UI / ActionMapper | No — V5.1 no toca frontend |
| Section 6: Plan de implementación | No — V5.1 no toca plan |
| Section 7: Confianza (definición conceptual) | No — V5.1 cambia el tipo pero no define el concepto |
| Section 8: Naming | No — V5.1 no toca naming |
| `DecisionTrace` | Parcialmente — V5.1 tiene `trace` en `ReadinessResponse` pero con estructura diferente |
| Pipeline `RulesEngine → PrioritizationEngine → RecommendationBuilder` | No explícitamente — V5.1 define los tipos pero no el flujo |

**Conclusión**: V5.1 solo cubre las definiciones de tipos. El resto del documento (secciones 2, 4, 5, 6, 7, 8) sigue siendo válido y debe preservarse.

### C3.3 — V5.1 introduce tipos que V3 no tiene

- `ReadinessResponse.version` — concepto nuevo (versionamiento del motor/reglas)
- `RuleDefinition.dependsOn` — dependencias entre reglas
- `AssessmentFinding.sourceModule` — trazabilidad del módulo origen
- `HealthScore.bonuses` — bonificaciones en health score
- `HealthScore.calculationVersion` — versionamiento del cálculo

**Conclusión**: V5.1 es más completo en tipos, pero falta integrar con el resto del documento.

### C3.4 — ¿Algún documento posterior depende de V3?

No se encontraron dependencias externas de V3. Los documentos S7 (s7-05c, s7-06) pertenecen a Shadow Rules Readiness, un dominio diferente. Los documentos en `openspec/accounting-readiness-center/` son todos posteriores a V5.1.

### C3.5 — Conceptos duplicados con nombres distintos

| Concepto | Nombre en V3 | Nombre en V5.1 |
|---|---|---|
| Hallazgo de regla | `Finding` + `Blocker` + `Warning` | `AssessmentFinding` |
| Datos de evaluación | `EvaluationContext` | `EvaluationSnapshot` |
| Puntaje de salud | `HealthScore.total` | `HealthScore.score` |
| Confianza | `ReadinessAssessment.confidence: number` | `ReadinessAssessment.confidence: { score, reasons[] }` |
| Metadatos de evaluación | `DecisionTrace` | `ReadinessResponse.trace` |

---

## 4. Recomendación

**Se propone adoptar V5.1 como contrato canónico** y reemplazar V3 por las siguientes razones:

### A favor de V5.1
1. **EvaluationSnapshot** (foto congelada) es un mejor patrón arquitectónico que EvaluationContext (objeto mutable) — funciones puras, testables, serializables
2. **AssessmentFinding unificado** reduce la complejidad de tipos (3 interfaces → 1)
3. **ActionRef con capabilities** es más expresivo y permite control de autorización server-side
4. **Version tracking** en ReadinessResponse y HealthScore permite evolucionar el motor sin romper clientes
5. **HealthScore con bonuses** permite reconocer configuraciones proactivas (backup diario, conciliación automática)
6. **Confidence como objeto con reasons** es más informativo que un número solo
7. **Dependencias entre reglas** (`RuleDefinition.dependsOn`) permite grafos de reglas complejos

### A favor de V3 (y que debe preservarse en el documento resultante)
1. El **pipeline** (RulesEngine → PrioritizationEngine → RecommendationBuilder) debe mantenerse como documentación del flujo
2. El **ActionMapper** del frontend y las rutas son independientes del tipo ActionRef
3. El **plan de implementación** (Fase 1, 2, 3) debe mantenerse
4. La **definición conceptual de confidence** (sección 7) es valiosa pero debe adaptarse al nuevo tipo
5. **DecisionTrace** debe preservarse como concepto (aunque con estructura V5.1)
6. **Section 2: Integridad como propiedad del dominio** debe preservarse — describe el patrón, no depende de los tipos

### Resolución propuesta

```
design.md resultante tendrá:

1. Contrato V5.1 como tipos canónicos (única definición de interfaces)
2. Secciones preservadas de V3:
   - Section 1 Domain Model → reemplazada por V5.1 contracts
   - Section 2 Integrity → preservada (no depende de tipos)
   - Section 3 Rules Engine → reemplazada por V5.1 RuleDefinition
   - Section 4 Endpoint → preservar, adaptar respuesta a ReadinessResponse
   - Section 5 UI / ActionMapper → preservar (adaptar ActionRef.command)
   - Section 6 Implementation Plan → preservar
   - Section 7 Confidence definition → preservar, adaptar al nuevo tipo
   - Section 8 Naming → preservar
3. Pipeline: RulesEngine → PrioritizationEngine → RecommendationBuilder → preservado
4. DecisionTrace → preservado como parte de ReadinessResponse.trace
5. V3 interfaces: marcadas como REPLACED_BY V5.1
```

---

## 5. Propuesta de glosario

Se agregarán al final de `docs/glossary.md`:

```markdown
## Readiness (Shadow Rules)
La evaluación del motor de reglas sobre un modelo de IA en shadow mode para determinar si está listo para promoverse a modo activo. Dominio: admin/sre. Módulo: `src/lib/readiness/`.

## Readiness (Accounting Period)
La evaluación del estado de un período contable para determinar si está listo para cerrarse. Incluye blockers, warnings, health score y recomendaciones. Dominio: contable. Módulo: `src/lib/accounting-readiness/`.
```

---

## 6. Riesgos de no hacer nada

1. **Un desarrollador implementa contra V3**, descubre que V5.1 existe, duplica trabajo
2. **La IA de desarrollo lee ambos contratos** y genera código inconsistente (mitad V3, mitad V5.1)
3. **El error es silencioso** — TypeScript no detecta el conflicto porque ambos contratos son tipos diferentes con nombres diferentes; no hay errores de compilación, solo de lógica
4. **Se pierde trazabilidad** — dentro de 3 semanas nadie recordará por qué hay dos contratos

---

## 7. Acciones propuestas

| # | Acción | Depende de |
|---|---|---|
| 1 | Aprobar esta propuesta | — |
| 2 | Editar `design.md`: eliminar V3 contracts, preservar V5.1 como único contrato | #1 |
| 3 | Editar `design.md`: integrar secciones V3 preservadas con contratos V5.1 | #2 |
| 4 | Editar `design.md`: agregar nota de versión y changelog interno | #3 |
| 5 | Agregar entradas de glosario para ambos dominios Readiness | #1 |
| 6 | Actualizar `DOCUMENT_AUTHORITY_MAP.md` para reflejar el cambio | #4, #5 |
| 7 | Actualizar `DOCUMENT_CONFLICT_REPORT.md`: marcar C1 como RESUELTO | #6 |

---

**Estado**: PENDIENTE DE APROBACIÓN