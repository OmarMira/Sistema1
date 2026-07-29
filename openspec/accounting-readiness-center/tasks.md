# Sprint Tasks: Accounting Readiness Center — Phase 1 (MVP)

Basado en `openspec/accounting-readiness-center/design.md` V3 y verificación contra el repositorio real.

---

## T-0A: Auditoría de src/lib/readiness/ existente

| Campo | Valor |
|---|---|
| **Objetivo** | Revisar el directorio `src/lib/readiness/` (5 archivos existentes: build-policy-query-params.ts, build-readiness-query-params.ts, default-readiness-profile.ts, parse-readiness-query.ts, rate-check-mapper.ts) y determinar qué es reutilizable, qué requiere adaptación, y qué puede eliminarse. |
| **Archivos existentes** | `src/lib/readiness/*` (5 archivos), `src/lib/services/canonical-readiness-service.ts`, `src/lib/services/shadow-metrics-reader.ts` |
| **Archivos nuevos** | Ninguno — solo análisis |
| **Dependencias** | Ninguna |
| **Criterios de aceptación** | 1. Documentar cada archivo existente: qué hace, qué exporta, si tiene consumidores actuales. 2. Identificar superposición con el diseño V3 (tipos, perfiles, reglas). 3. Decidir para cada archivo: reutilizar tal cual / adaptar / deprecar. 4. Estimar impacto de cambios en consumidores existentes. |
| **Pruebas** | No aplica (es análisis) |
| **Riesgo técnico** | Bajo |
| **Duración estimada** | 1–2 horas |

---

## T-0B: Decisión de reutilización vs reemplazo

| Campo | Valor |
|---|---|
| **Objetivo** | A partir de la auditoría T-0A, decidir la estrategia arquitectónica: (a) extender los archivos existentes de readiness, (b) crear nuevos módulos y deprecar los viejos, o (c) adaptar los existentes para compatibilidad. Debe incluir plan de migración si la decisión es (b). |
| **Archivos existentes** | Los mismos que T-0A |
| **Archivos nuevos** | Ninguno — solo decisión documentada |
| **Dependencias** | T-0A |
| **Criterios de aceptación** | 1. Decisión explícita documentada (reutilizar / reemplazar / adaptar). 2. Si hay consumidores actuales de `canonical-readiness-service`, plan de compatibilidad. 3. Si se decide reutilizar, diseño V3 ajustado para reflejar la estructura real. 4. Sin cambios que rompan código existente. |
| **Pruebas** | No aplica (decisión arquitectónica) |
| **Riesgo técnico** | Bajo |
| **Duración estimada** | 1 hora |

**Nota:** Las T-0A y T-0B son requisito previo para TODO el resto del sprint. No empezar T-1 sin resolver la estrategia de reutilización.

---

## T-1: Crear HealthScoreRule[] declarativas

| Campo | Valor |
|---|---|
| **Objetivo** | Definir las reglas de health score como datos declarativos (`id`, `weight`, `condition`, `explanation`), no hardcodeadas en el algoritmo. |
| **Archivos existentes** | `src/lib/readiness/default-readiness-profile.ts` (depende de T-0A/B: posible reutilización o adaptación) |
| **Archivos nuevos** | `src/lib/readiness/rules/health-score-rules.ts` (o dentro de estructura existente según T-0B) |
| **Dependencias** | T-0A, T-0B |
| **Criterios de aceptación** | 1. Las reglas son una lista de objetos con `id`, `category`, `weight`, `condition`, `explanation`. 2. Una regla de backup, una de clasificación, una de conciliación. 3. Las reglas se pueden agregar/sacar sin modificar el motor de cómputo. 4. `condition` acepta `EvaluationSnapshot` y devuelve `boolean \| number`. |
| **Pruebas** | Unit test: cada regla se evalúa correctamente con contexto controlado. Test de integración: lista completa de reglas no tira errores. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | No incluye el motor que ejecuta las reglas (T-3). Solo la declaración de reglas. |

---

## T-2: Crear BlockerRules[] y WarningRules[] declarativas

| Campo | Valor |
|---|---|
| **Objetivo** | Definir reglas de bloqueo (B1–B6) y advertencia (W1–W5) como datos declarativos, no funciones dispersas. |
| **Archivos existentes** | Ninguno (depende de T-0B: decidir ubicación dentro de estructura existente o nueva) |
| **Archivos nuevos** | `src/lib/readiness/rules/blocker-rules.ts`, `src/lib/readiness/rules/warning-rules.ts` (o dentro de estructura existente según T-0B) |
| **Dependencias** | T-0A, T-0B |
| **Criterios de aceptación** | 1. B1: detecta período anterior abierto. 2. B2: detecta transacciones sin clasificar > 0. 3. B3: detecta partidas sin conciliar > 0. 4. B4: detecta libro desbalanceado. 5. B5: detecta transacciones huérfanas. 6. B6: detecta período sin importaciones (si edad > N días). 7. W1–W5 según diseño. 8. Cada regla devuelve `Finding \| null`. |
| **Pruebas** | Unit test: cada regla con contexto favorable y desfavorable. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | No incluye el motor que ejecuta las reglas (T-3). Solo la declaración. |

---

## T-3: Crear RulesEngine (evaluate → Finding[])

| Campo | Valor |
|---|---|
| **Objetivo** | Motor que itera BlockerRules + WarningRules, ejecuta `evaluate(snapshot)` y recolecta `Finding[]`. |
| **Archivos existentes** | Ninguno |
| **Archivos nuevos** | `src/lib/readiness/rules-engine.ts` |
| **Dependencias** | T-1, T-2 (las reglas), T-0A/B (definición de EvaluationSnapshot), T-8A–T-8E (métodos de dominio para armar el snapshot) |
| **Criterios de aceptación** | 1. `evaluate(context)` ejecuta todas las reglas. 2. Devuelve `Finding[]` con type='blocker' o 'warning'. 3. Si una regla falla (throw), se loggea y se omite (no derrumba toda la evaluación). 4. Una regla que devuelve null no genera Finding. 5. Usa las reglas de T-1 y T-2. |
| **Pruebas** | Unit test: mock rules que producen findings conocidos. Test de integración: rulesEngine + reglas reales. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | No incluye priorización ni recomendación (T-4, T-6). |

---

## T-4: Crear PrioritizationEngine (rank → RankedFinding[])

| Campo | Valor |
|---|---|
| **Objetivo** | Ordenar Findings por impacto: primero los que desbloquean otros blockers, luego los de integridad, luego operativos, luego warnings. |
| **Archivos existentes** | Ninguno |
| **Archivos nuevos** | `src/lib/readiness/prioritization-engine.ts` |
| **Dependencias** | T-3 (RulesEngine produce los Findings) |
| **Criterios de aceptación** | 1. Bloqueantes con `severity: 1` van primero. 2. Si un blocker desbloquea a otro, va antes. 3. Warnings van después de todos los bloqueantes. 4. Empates se resuelven por estimatedImpact.healthScoreDelta descendente. |
| **Pruebas** | Unit test: findings mock en distintos órdenes, verificar ranking resultante. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | No construye el mensaje de recomendación (T-6). |

---

## T-5: Crear HealthScoreCalculator

| Campo | Valor |
|---|---|
| **Objetivo** | Calcular health score: base = 100, aplicar deducciones según HealthScoreRule[], devolver `HealthScore` con deducciones detalladas. |
| **Archivos existentes** | `src/lib/readiness/default-readiness-profile.ts` (posible reutilización según T-0B) |
| **Archivos nuevos** | `src/lib/readiness/health-score-calculator.ts` |
| **Dependencias** | T-1 (health score rules), T-8A–T-8E (EvaluationSnapshot con datos reales) |
| **Criterios de aceptación** | 1. Base = 100. 2. Cada regla aplica deducción si condition > 0. 3. Deducción = weight * valor de condition. 4. Resultado mínimo 0. 5. deductions[] incluye ruleId, points, reason. 6. trend se calcula contra health score anterior si existe (si no, 'stable'). |
| **Pruebas** | Unit test: contexto sin problemas → score 100. Contexto con backup antiguo → score 90. Contexto con múltiples problemas → score < 80. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | Persistencia de health score histórico. |

---

## T-6: Crear RecommendationBuilder (build → primary + nextActions)

| Campo | Valor |
|---|---|
| **Objetivo** | Tomar rankedFindings y construir `Recommendation` para cada uno, eligiendo la primaryRecommendation como la primera del ranking. |
| **Archivos existentes** | Ninguno |
| **Archivos nuevos** | `src/lib/readiness/recommendation-builder.ts` |
| **Dependencias** | T-4 (PrioritizationEngine), T-8A–T-8E (para armar ActionRef) |
| **Criterios de aceptación** | 1. primaryRecommendation es el primer elemento del ranking. 2. nextActions incluye primary + hasta 2 más. 3. Cada recomendación tiene title, reason, estimatedImpact, action (ActionRef). 4. Si no hay findings, la recomendación es "Cerrar período" o "Generar reporte". |
| **Pruebas** | Unit test: ranking con findings → primary es el primero. Ranking vacío → recomendación default. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | No ejecuta las acciones, solo las describe. |

---

## T-7: Crear ConfidenceCalculator

| Campo | Valor |
|---|---|
| **Objetivo** | Calcular qué tan confiable es la evaluación según la completitud de los datos de entrada. |
| **Archivos existentes** | Ninguno |
| **Archivos nuevos** | `src/lib/readiness/confidence-calculator.ts` |
| **Dependencias** | T-8A–T-8E (para determinar si hay errores de servicio, importaciones parciales, etc.) |
| **Criterios de aceptación** | 1. Base = 1.0. 2. Importaciones parciales → -0.15. 3. Errores de servicio → -0.20. 4. Módulos deshabilitados → -0.10 c/u. 5. El resultado no baja de 0. 6. Definición estricta según sección 7 del design. |
| **Pruebas** | Unit test: contexto completo → 1.0. Contexto con error de servicio → 0.80. Contexto con múltiples factores → valor compuesto. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | No influye en el estado global. Es metadata de la evaluación. |

---

## T-8A: FiscalPeriod — getActive + checkPeriodGaps + checkDuplicateClosures

| Campo | Valor |
|---|---|
| **Objetivo** | Agregar métodos de consulta de estado e integridad para períodos fiscales. **Nota:** el repo tiene helpers fragmentados en `src/lib/fiscal-period/` pero no una clase unificada. Esta tarea debe decidir si consolidar en un servicio o extender los helpers existentes. |
| **Archivos existentes** | `src/lib/fiscal-period/utils.ts`, `src/lib/fiscal-period/types.ts`, `src/lib/fiscal-period-guard.ts` |
| **Archivos nuevos** | Potencialmente `src/lib/fiscal-period/fiscal-period.service.ts` (si se decide consolidar) o modificar `utils.ts` (si se decide extender) |
| **Dependencias** | T-0B (decisión de estructura) |
| **Criterios de aceptación** | 1. `getActive(companyId)` devuelve el período fiscal activo (último no cerrado) con toda la metadata de PeriodInfo. 2. `checkPeriodGaps(companyId)` devuelve IntegrityCheck sobre gaps entre fechas. 3. `checkDuplicateClosures(companyId)` devuelve IntegrityCheck. 4. Sin cambios en la API pública existente de `fiscal-period/`. |
| **Pruebas** | Test de integración con DB. |
| **Riesgo técnico** | Bajo |
| **PR independiente** | Sí — no bloquea ni es bloqueado por T-8B, T-8C, T-8D, T-8E |

---

## T-8B: Entity — countPending + checkLowConfidence

| Campo | Valor |
|---|---|
| **Objetivo** | Agregar método para contar entidades sin clasificar en un período. **Nota:** el repo tiene servicios fragmentados (`entity-context-service.ts`, `entity-detector.ts`, `entity-classifier.ts`) pero no un EntityService unificado. Esta tarea debe decidir si consolidar o extender. |
| **Archivos existentes** | `src/lib/services/entity-context-service.ts`, `src/lib/services/entity-detector.ts`, `src/lib/services/entity-classifier.ts`, `src/lib/services/entity-context-crud-service.ts` |
| **Archivos nuevos** | Potencialmente `src/lib/services/entity-service.ts` (si se decide consolidar) o modificar archivo existente |
| **Dependencias** | T-0B (decisión de estructura) |
| **Criterios de aceptación** | 1. `countPending(companyId, periodId)` cuenta entidades sin clasificar en el período. 2. Consulta DB directamente (Prisma). 3. Sin cambios en APIs públicas existentes. |
| **Pruebas** | Test de integración con DB. |
| **Riesgo técnico** | Bajo |
| **PR independiente** | Sí |

---

## T-8C: Reconciliation — getStatus + checkOrphanTransactions + checkForeignKeyReferences

| Campo | Valor |
|---|---|
| **Objetivo** | Extender `ReconciliationService` (clase existente) con métodos de consulta de estado e integridad. |
| **Archivos existentes** | `src/lib/services/reconciliation.service.ts` (clase existente, solo tiene `reconcile()`) |
| **Archivos nuevos** | Ninguno — solo modificar el existente |
| **Dependencias** | Ninguna |
| **Criterios de aceptación** | 1. `getStatus(companyId, periodId)` devuelve conteo de conciliadas, pendientes, ignoradas. 2. `checkOrphanTransactions(companyId)` detecta transacciones sin statementId. 3. `checkForeignKeyReferences(companyId)` verifica FKs. 4. `reconcile()` sigue funcionando sin cambios. |
| **Pruebas** | Test de integración con DB. |
| **Riesgo técnico** | Bajo |
| **PR independiente** | Sí |

---

## T-8D: Journal — getBalance + checkBalanced + checkCompleteEntries

| Campo | Valor |
|---|---|
| **Objetivo** | Extender `JournalService` (clase existente) con métodos de consulta de balance e integridad. |
| **Archivos existentes** | `src/lib/services/journal.service.ts` (clase existente, solo tiene `create()`) |
| **Archivos nuevos** | Ninguno — solo modificar el existente |
| **Dependencias** | Ninguna |
| **Criterios de aceptación** | 1. `getBalance(companyId, periodId)` devuelve suma de débitos y créditos del período. 2. `checkBalanced(companyId, periodId)` verifica libro balanceado (reutilizando lógica interna de `create()`). 3. `checkCompleteEntries(companyId, periodId)` verifica que todo JE tenga ≥1 línea. 4. `create()` sigue funcionando sin cambios. |
| **Pruebas** | Test de integración con DB. |
| **Riesgo técnico** | Bajo |
| **PR independiente** | Sí |

---

## T-8E: Backup — getLatest

| Campo | Valor |
|---|---|
| **Objetivo** | Agregar wrapper `getLatest()` que aproveche `listBackups()` existente. |
| **Archivos existentes** | `src/lib/backup.ts` (funciones sueltas, incluye `listBackups()`) |
| **Archivos nuevos** | Ninguno — modificar `src/lib/backup.ts` |
| **Dependencias** | Ninguna |
| **Criterios de aceptación** | 1. `getLatest(companyId)` devuelve el backup más reciente o null si no hay. 2. `listBackups()` sigue funcionando sin cambios. |
| **Pruebas** | Unit test con backups mock. |
| **Riesgo técnico** | Muy bajo |
| **PR independiente** | Sí |

---

## T-9: Crear ReadinessService (orquestador)

| Campo | Valor |
|---|---|
| **Objetivo** | Orquestador que compone RulesEngine, HealthScoreCalculator, PrioritizationEngine, RecommendationBuilder, ConfidenceCalculator y las llamadas a servicios existentes. Es el punto de entrada único. |
| **Archivos existentes** | `src/lib/readiness/` (según resultado de T-0A/B) |
| **Archivos nuevos** | `src/lib/readiness/readiness.service.ts` |
| **Dependencias** | T-3 (RulesEngine), T-4 (PrioritizationEngine), T-5 (HealthScoreCalculator), T-6 (RecommendationBuilder), T-7 (ConfidenceCalculator), T-8A–T-8E (métodos de dominio), T-0A/B (estructura de readiness) |
| **Criterios de aceptación** | 1. `assess(companyId, periodId)` devuelve `ReadinessAssessment`. 2. Integra datos de 5+ servicios existentes en paralelo (Promise.all). 3. Si un servicio falla, loggea el error y continúa (confianza se reduce). 4. El resultado incluye todos los campos del modelo de dominio. 5. Sin llamadas HTTP internas. |
| **Pruebas** | Test de integración con servicios reales + DB de prueba. Test unitario con servicios mock. |
| **Riesgo técnico** | Medio — punto de integración más complejo |
| **Fuera de alcance** | Cacheo de resultados. Endpoint (T-10). |

---

## T-10: Crear endpoint GET /api/accounting/readiness

| Campo | Valor |
|---|---|
| **Objetivo** | Endpoint que expone ReadinessService como API REST. **El contrato del endpoint se congela antes de comenzar la UI.** La UI nunca condiciona cambios en el contrato. |
| **Archivos existentes** | Estructura de rutas en `src/app/api/` |
| **Archivos nuevos** | `src/app/api/accounting/readiness/route.ts` |
| **Dependencias** | T-9 (ReadinessService) |
| **Criterios de aceptación** | 1. `GET /api/accounting/readiness?companyId=x&periodId=y` → 200 + `ReadinessAssessmentResponse`. 2. Con `?trace=true` → incluye `decisionTrace`. 3. Autenticación via `apiHandler` + `requireCompanyContext`. 4. 400 si faltan parámetros. 5. 401 si no autenticado. 6. Respuesta < 500ms. |
| **Pruebas** | Test de integración: request HTTP mock. Test de autenticación: sin token → 401. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | La UI (T-12). |

---

## T-11: Crear ActionMapper en frontend

| Campo | Valor |
|---|---|
| **Objetivo** | Mapper centralizado que convierte `ActionRef` (del backend) en rutas de navegación del frontend. |
| **Archivos existentes** | Ninguno |
| **Archivos nuevos** | `src/lib/readiness/action-mapper.ts` |
| **Dependencias** | T-10 (contrato del endpoint, incluye los ActionType definidos) |
| **Criterios de aceptación** | 1. `mapToUrl({ type: 'close_fiscal_period', entityId: 'p-1' })` → `/fiscal-periods/p-1/close`. 2. Cubre todos los ActionType del diseño. 3. Tipo desconocido → null. |
| **Pruebas** | Unit test: cada ActionType produce la URL esperada. |
| **Riesgo técnico** | Muy bajo |

---

## T-12: Crear página Centro Contable (UI)

| Campo | Valor |
|---|---|
| **Objetivo** | Página que renderiza el estado contable a partir de `ReadinessAssessment`. Un componente por sección del modelo de dominio. Sin lógica de negocio en frontend. |
| **Archivos existentes** | Componentes de dashboard existentes (posible reutilización visual) |
| **Archivos nuevos** | `src/app/accounting-center/page.tsx`, `src/app/accounting-center/_components/` (global-state-badge, primary-recommendation-card, blocker-list, warning-section, health-score-panel, revalidate-button) |
| **Dependencias** | T-10 (endpoint), T-11 (ActionMapper) |
| **Criterios de aceptación** | 1. Muestra período actual y estado global. 2. Recomendación principal como tarjeta destacada. 3. Cada blocker/warning es link navegable (via ActionMapper). 4. Health Score con deducciones visibles. 5. Botón "Re-validar ahora". 6. La UI no contiene reglas de negocio. |
| **Pruebas** | Component test: renderizar con assessment mock. |
| **Riesgo técnico** | Bajo |
| **Fuera de alcance** | Botón "Cerrar período" (Fase 2). Alertas (Fase 3). |

---

## Mapa de dependencias entre tareas

```
T-0A (auditoría readiness)
  └── T-0B (decisión reutilización)
        │
        ├── T-8A (FiscalPeriod) ──┐
        ├── T-8B (Entity) ────────┤
        ├── T-8C (Reconciliation) ─┼── T-3 (RulesEngine) ── T-4 (Prioritization) ── T-6 (Recommendation)
        ├── T-8D (Journal) ───────┤        │
        ├── T-8E (Backup) ────────┘        │
        │                                  │
        ├── T-1 (HealthScoreRules) ────────┤
        ├── T-2 (Blocker/WarningRules) ────┘
        │
        ├── T-5 (HealthScoreCalculator) ───┐
        ├── T-7 (ConfidenceCalculator) ────┤
        │                                  │
        └──────────────────────────────────┴── T-9 (ReadinessService) ── T-10 (endpoint)
                                                                              │
                                                                         ┌───┴───┐
                                                                     T-11 (ActionMapper)
                                                                         │
                                                                     T-12 (UI)
```

**Camino crítico:** T-0A → T-0B → T-8A–T-8E → T-3 → T-4 → T-6 → T-9 → T-10 → T-12.
T-1, T-2, T-5, T-7 son paralelizables con T-3 después de T-8.

---

## Resumen del sprint

| Tarea | Archivos nuevos | Archivos modificados | PR independiente | Riesgo |
|---|---|---|---|---|
| T-0A | 0 | 0 (solo análisis) | — | bajo |
| T-0B | 0 | 0 (solo decisión) | — | bajo |
| T-1 | 1 | 0 (o adapta existente) | sí | bajo |
| T-2 | 2 | 0 | sí | bajo |
| T-3 | 1 | 0 | No (depende de T-1,T-2,T-8) | bajo |
| T-4 | 1 | 0 | No (depende de T-3) | bajo |
| T-5 | 1 | 0 | sí | bajo |
| T-6 | 1 | 0 | No (depende de T-4) | bajo |
| T-7 | 1 | 0 | sí | bajo |
| T-8A | 0–1 | 0–1 | **sí** | bajo |
| T-8B | 0–1 | 0–1 | **sí** | bajo |
| T-8C | 0 | 1 | **sí** | bajo |
| T-8D | 0 | 1 | **sí** | bajo |
| T-8E | 0 | 1 | **sí** | muy bajo |
| T-9 | 1 | 0 | No (depende de todos) | medio |
| T-10 | 1 | 0 | No (depende de T-9) | bajo |
| T-11 | 1 | 0 | sí | muy bajo |
| T-12 | 8 | 0 | No (depende de T-10,T-11) | bajo |

**Total:** ~19–21 archivos nuevos, ~4–7 modificados. 6 PRs independientes (T-8A a T-8E, T-11) que pueden ir en paralelo.