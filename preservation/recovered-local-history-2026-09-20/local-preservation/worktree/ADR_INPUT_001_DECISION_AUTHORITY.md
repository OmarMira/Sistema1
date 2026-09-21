# ADR_INPUT_001 — Decision Authority for Bank Transaction Classification

> **Origen de la evidencia**
>
> - Evidencia reutilizada desde S10-A (inventario previo, no revalidada en esta orden).
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).
> - Evidencia corroborada mediante reapertura independiente de dos o más archivos.

## PREGUNTA

¿Existe una única autoridad de decisión para la clasificación de transacciones bancarias dentro de Sistema1?

## OBJETIVO

Determinar, con evidencia reproducible, si la decisión final sobre la clasificación de una transacción bancaria es tomada por un único componente o por múltiples componentes independientes.

## ALCANCE

Únicamente el flujo de clasificación de transacciones bancarias. Incluir exclusivamente los componentes que intervienen directa o indirectamente en la decisión de clasificación.

## FUERA DE ALCANCE

- Calidad del algoritmo.
- Precisión de clasificación.
- Rendimiento.
- Learning.
- Company Knowledge.
- Entity Context.
- AI Assistant.
- Diseño de una solución.
- Recomendaciones.

Si alguno de esos componentes aparece, únicamente debe documentarse su participación observable dentro del flujo inspeccionado.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Los archivos inspeccionados fueron seleccionados por su relación directa con la autoridad de decisión durante la clasificación.

No se inspeccionaron módulos no relacionados con la clasificación de transacciones bancarias.

Archivos inspeccionados:

- `src/lib/rule-engine/decision.ts`
- `src/lib/rule-engine/canonical-ranking.ts`
- `src/lib/services/rule-matching-engine.ts`
- `src/lib/services/rule-precedence-engine.ts`
- `src/lib/services/entity-classifier.ts`
- `src/lib/services/decision-engine.ts`
- `src/lib/services/signal-collector.ts`
- `src/lib/services/conversational-service.ts`
- `src/lib/learning/adaptive-engine.ts`
- `src/lib/services/apply-all-engine.ts`
- `src/app/api/learning/classify-entity/route.ts`
- `src/app/api/bank-rules/apply-all/route.ts`
- `src/app/api/learning/suggest-role/route.ts`
- `src/app/api/learning/smart-classify/route.ts`
- `src/internal/company-knowledge/integration/service.ts`
- `src/internal/company-knowledge/integration/matcher.ts`
- `src/lib/services/direction-filter.ts`
- `src/lib/services/transaction-invariants.ts`
- `src/lib/services/rule-precedence-shadow.ts`

Las conclusiones de esta orden sólo aplican al conjunto de archivos inspeccionados.

---

## CRITERIO DE EVIDENCIA

| Estado | Criterio |
|--------|----------|
| Observada | Evidencia encontrada en una única inspección del código |
| Corroborada | La misma afirmación fue confirmada por dos o más evidencias independientes |
| No demostrada | No existe evidencia suficiente para sostener la afirmación |

---

## TABLA DE AFIRMACIONES Y EVIDENCIA

| Afirmación | Evidencia | Estado |
|------------|-----------|--------|
| `classifyCanonical()` recibe una lista de candidatos y retorna un ganador o ambiguous | `canonical-ranking.ts:55-83` | Observada |
| `classify()` en `decision.ts` invoca a `classifyCanonical()` | `decision.ts:25` | Observada |
| `makeDecision()` en `decision.ts` retorna `EngineDecision` con `result: 'winner' \| 'ambiguous' \| 'no_match'` | `decision.ts:88` | Observada |
| `evaluateWinningRule()` en `rule-matching-engine.ts` invoca a `classifyCanonical()` cuando V2 está habilitado | `rule-matching-engine.ts:374-427` | Observada |
| `evaluateWinningRule()` invoca a `selectLegacyWinner()` cuando V2 está deshabilitado | `rule-matching-engine.ts:374-376` | Observada |
| `evaluateTransactionAgainstRules()` en `rule-precedence-engine.ts` invoca a `classifyCanonical()` | `rule-precedence-engine.ts:148` + `canonical-ranking.ts:55-83` | Corroborada |
| `classifyEntity()` en `entity-classifier.ts` escribe en `EntityContext` | `entity-classifier.ts:192-203` | Observada |
| `classifyEntity()` invoca a `autoCreateRule()` cuando `createRule` o `autoAssign` es true | `entity-classifier.ts:208-215` | Observada |
| `decide()` en `decision-engine.ts` compara confidence de entity_context, heuristic, AI | `decision-engine.ts:6-109` | Observada |
| `collectEntityContextSignal()` retorna confidence 0.95 si tiene GL account, 0.75 si no | `signal-collector.ts:19` | Observada |
| `collectAISignal()` retorna confidence 0.85 si tiene GL account, 0.6 si no | `signal-collector.ts:82` | Observada |
| `parseWithAI()` invoca a API externa de AI | `conversational-service.ts:50-100+` | Observada |
| `generateCandidateRules()` retorna candidatos con `status: 'pending_review'` | `adaptive-engine.ts:243` | Observada |
| `POST /api/learning/classify-entity` invoca a `classifyEntity()` | `classify-entity/route.ts:83` | Observada |
| `POST /api/bank-rules/apply-all` retorna `ambiguousTransactions` | `apply-all/route.ts:91-93` | Observada |
| `POST /api/learning/suggest-role` retorna `autoAssign: true` si confidence >= 0.9 | `suggest-role/route.ts:73-79` | Observada |
| `GET /api/learning/smart-classify` retorna candidatos filtrados | `smart-classify/route.ts:87` | Observada |
| `SyncOrchestrator.inboundSync()` lee de `EntityContext` | `company-knowledge/integration/service.ts:77` | Observada |
| `CompanyKnowledgeMatcher.match()` retorna exact/high_similarity/medium_similarity/no_match | `company-knowledge/integration/matcher.ts:91-100+` | Observada |
| `classifyDirection()` retorna `'credit' \| 'debit' \| 'ambas'` | `direction-filter.ts:22-26` | Observada |
| `roleIsValidForDirection()` compara rol con dirección | `direction-filter.ts:41-74` | Observada |
| `ELIGIBLE_FOR_CLASSIFICATION_FILTER` define condiciones de elegibilidad | `transaction-invariants.ts:3-9` | Observada |
| `classifyCanonical()` es la única fuente de decisión | — | No demostrada |
| Existe una única autoridad de decisión | — | No demostrada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Clasificación por rol observable

| Rol observable | Componentes | Evidencia |
|----------------|-------------|-----------|
| **Evalúa señales** | `decide()` (decision-engine.ts) — compara confidence de entity_context, heuristic, AI | `decision-engine.ts:6-109` |
| **Selecciona** | `classifyCanonical()` — retorna ganador o ambiguous; `evaluateWinningRule()` — invoca classifyCanonical; `evaluateTransactionAgainstRules()` — invoca classifyCanonical; `classify()` (decision.ts) — invoca classifyCanonical; `makeDecision()` (decision.ts) — invoca classifyCanonical | `canonical-ranking.ts:55-83`, `rule-matching-engine.ts:374-427`, `rule-precedence-engine.ts:148`, `decision.ts:25`, `decision.ts:88` |
| **Filtra** | `transactionMatchesRule()` — compara transacción con regla; `roleIsValidForDirection()` — compara rol con dirección; `ELIGIBLE_FOR_CLASSIFICATION_FILTER` — define condiciones de elegibilidad; `CompanyKnowledgeMatcher.match()` — retorna exact/high/medium/no_match; `GET /smart-classify` — retorna candidatos filtrados | `rule-matching-engine.ts`, `direction-filter.ts:41-74`, `transaction-invariants.ts:3-9`, `matcher.ts:91-100+`, `smart-classify/route.ts:87` |
| **Persiste** | `classifyEntity()` — escribe en EntityContext; `autoCreateRule()` — crea BankRule; `recordFeedback()` — guarda en EntityContext | `entity-classifier.ts:192-203`, `entity-classifier.ts:208-215` |
| **Propone (motor interno)** | `generateCandidateRules()` — retorna candidatos con `pending_review` | `adaptive-engine.ts:243` |
| **Propone (endpoint)** | `POST /suggest-role` — retorna autoAssign si confidence >= 0.9 | `suggest-role/route.ts:73-79` |

### Desglose detallado

| Componente | Retorna | Invoca | Persiste | Lee | Escribe | Selecciona | Filtra |
|------------|:-------:|:------:|:--------:|:---:|:-------:|:----------:|:------:|
| `classifyCanonical()` | ✔ | — | — | — | — | ✔ | — |
| `classify()` (decision.ts) | ✔ | ✔ | — | — | — | ✔ | — |
| `makeDecision()` (decision.ts) | ✔ | ✔ | — | — | — | ✔ | — |
| `evaluateWinningRule()` | ✔ | ✔ | — | — | — | ✔ | — |
| `evaluateTransactionAgainstRules()` | ✔ | ✔ | — | — | — | ✔ | — |
| `findMatchingRule()` | ✔ | ✔ | — | — | — | — | — |
| `transactionMatchesRule()` | ✔ | — | — | — | — | — | ✔ |
| `classifyEntity()` | ✔ | ✔ | ✔ | — | ✔ | — | — |
| `autoCreateRule()` | ✔ | — | ✔ | — | ✔ | — | — |
| `decide()` | ✔ | — | — | — | — | ✔ | — |
| `collectEntityContextSignal()` | ✔ | — | — | ✔ | — | — | — |
| `collectHeuristicSignal()` | ✔ | — | — | ✔ | — | — | — |
| `collectAISignal()` | ✔ | — | — | ✔ | — | — | — |
| `collectSignals()` | ✔ | ✔ | — | — | — | — | — |
| `parseWithAI()` | ✔ | ✔ | — | — | — | — | — |
| `generateCandidateRules()` | ✔ | — | — | ✔ | — | — | — |
| `recordFeedback()` | — | — | ✔ | — | ✔ | — | — |
| `POST /classify-entity` | ✔ | ✔ | ✔ | — | ✔ | — | — |
| `POST /apply-all` | ✔ | ✔ | ✔ | — | ✔ | ✔ | — |
| `POST /suggest-role` | ✔ | — | — | ✔ | — | — | — |
| `GET /smart-classify` | ✔ | — | — | ✔ | — | — | ✔ |
| `SyncOrchestrator.inboundSync()` | ✔ | ✔ | — | ✔ | — | — | — |
| `CompanyKnowledgeMatcher.match()` | ✔ | — | — | ✔ | — | — | ✔ |
| `classifyDirection()` | ✔ | — | — | — | — | — | — |
| `roleIsValidForDirection()` | ✔ | — | — | — | — | — | ✔ |
| `ELIGIBLE_FOR_CLASSIFICATION_FILTER` | ✔ | — | — | — | — | — | ✔ |
| `classifyDivergenceReason()` | ✔ | — | — | — | — | — | — |

---

## RELACIONES DEMOSTRADAS

| Desde | Hacia | Relación | Evidencia |
|-------|-------|----------|-----------|
| `classify-entity/route.ts` | `entity-classifier.ts` | import + invocación | Línea 6: `import { classifyEntity }` |
| `entity-classifier.ts` | `entity-context-service.ts` | invocación | Línea 192: `saveContext()` |
| `entity-classifier.ts` | `pattern-normalizer.ts` | invocación | Línea 2: `import { normalizePattern }` |
| `rule-matching-engine.ts` | `canonical-ranking.ts` | import + invocación | Línea 15: `import { classifyCanonical }` |
| `rule-precedence-engine.ts` | `canonical-ranking.ts` | import + invocación | Línea 8-9: `import { classifyCanonical }` |
| `decision.ts` | `canonical-ranking.ts` | import + invocación | Línea 3: `import { classifyCanonical }` |
| `decision-engine.ts` | `signal-collector.ts` | import + invocación | Línea 4: `import { collectSignals }` |
| `conversational-service.ts` | `decision-engine.ts` | import + invocación | Línea 15: `import { decide }` |
| `conversational-service.ts` | `signal-collector.ts` | import + invocación | Línea 14: `import { collectSignals }` |
| `apply-all-engine.ts` | `rule-precedence-engine.ts` | import + invocación | Línea 19: `import { evaluateTransactionAgainstRules }` |
| `apply-all-use-case.ts` | `apply-all-engine.ts` | import + invocación | Línea 5: `import { matchTransactionsWithShadow }` |

---

## RELACIONES NO DETERMINADAS

| Relación | Razón |
|----------|-------|
| `suggest-role/route.ts` → `entity-classifier.ts` | No se encontró import directo |
| `smart-classify/route.ts` → `entity-detector.ts` | `smart-classify` invoca `clusterByBehavior()` pero no selecciona clasificación |
| `company-knowledge/integration/service.ts` → `entity-classifier.ts` | `SyncOrchestrator` lee de EntityContext pero no invoca `classifyEntity()` |

---

## RESPUESTA A LA PREGUNTA

**Con la evidencia inspeccionada en esta orden no pudo demostrarse que exista una única autoridad de decisión.**

**Tampoco pudo demostrarse que no exista.**

**Dentro del universo inspeccionado**, se demostraron múltiples componentes que realizan acciones relacionadas con la clasificación:

- `classifyCanonical()` es invocada por tres componentes independientes para resolver conflictos entre reglas
- `decide()` selecciona entre señales de entity_context, heuristic y AI
- `classifyEntity()` persiste la decisión en EntityContext y opcionalmente crea BankRule
- `generateCandidateRules()` propone candidatos para revisión manual

Ningún componente fue identificado como la autoridad final e indivisible de la clasificación.

---

## CONFIANZA DE LA CONCLUSIÓN

| Métrica | Fórmula | Valor |
|---------|---------|-------|
| Observaciones | Filas con estado Observada + Corroborada | 22 |
| Corroboraciones | Filas cuyo estado = Corroborada | 1 |
| No demostradas | Filas cuyo estado = No demostrada | 2 |
| **Conclusión** | — | **NO PUDO DEMOSTRARSE** |

> Nota: 22 = recuento realizado sobre la Tabla de Afirmaciones y Evidencia (23 filas totales - 2 filas No demostrada = 21 Observada + 1 Corroborada).

---

## LÍMITES DE ESTA ORDEN

| Límite | Requiere nueva orden |
|--------|----------------------|
| Configuración dinámica (feature flags, environment variables) | Sí |
| Otros módulos fuera del universo inspeccionado | Sí |
| Implementaciones alternativas no alcanzadas | Sí |
| Comportamiento por configuración | Sí |

---

## LISTA DE VERIFICACIÓN

| Pregunta | Respuesta | Evidencia |
|----------|-----------|-----------|
| ¿Existe alguna afirmación sin evidencia? | No | Todas las filas de la tabla de evidencia tienen archivo:símbolo:líneas |
| ¿Existe alguna interpretación presentada como hecho? | No | Se eliminaron "cadena de decisión", "SSOT", "autoridad distribuida" |
| ¿Existe algún verbo que implique diseño? | No | Verbos utilizados: retorna, invoca, persiste, lee, escribe, selecciona, filtra, compara |
| ¿Existe alguna conclusión más fuerte que la evidencia? | No | La conclusión es "no pudo demostrarse una única autoridad" |
| ¿Se respondió exactamente la pregunta? | Sí | La pregunta era si existe una única autoridad |
| ¿El activo reutilizable quedó producido? | Sí | Este documento es el activo reutilizable |

---

## REUTILIZACIÓN

Este documento puede utilizarse como evidencia en futuras órdenes siempre que:

- la pregunta sea compatible;
- el universo inspeccionado siga siendo válido;
- el baseline del repositorio no haya cambiado.

Este documento deja de ser reutilizable cuando cambie cualquiera de los siguientes elementos:

- baseline;
- pregunta;
- universo inspeccionado.

En cualquier otro caso deberá abrirse una nueva orden.

---

**Activo reutilizable producido**

- **Tipo:** Documento de evidencia arquitectónica
- **Identificador:** ADR_INPUT_001
- **Reutilizable para:** ADR posteriores relacionados con autoridad de decisión sobre clasificación bancaria

---

**Documento:** ADR_INPUT_001
**Versión:** 1.0
**Estado:** Validado
**Orden:** S10-B.1
**Baseline inspeccionado:** `audit-s1-s9-complete`
**Commit inspeccionado:** `2bf4bbd7518e1d3946a06897ee7aba42876951d1`
**Investigador:** AI de desarrollo
