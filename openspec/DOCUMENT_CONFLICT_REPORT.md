# Document Conflict Report — AccountExpress

Generado: 2026-07-29

## C1 — Accounting Readiness Center: V3 vs V5.1 contract overlap

**Severidad**: CRITICAL → **RESUELTO (2026-07-29)**
**Archivo**: `openspec/accounting-readiness-center/design.md`

**Hallazgo**: El mismo archivo contenía dos definiciones de contrato que se superponen:
- **V3** (anterior): Define `RuleEvaluation`, `AccountingEvaluation`, `HealthIndicator`, `ReadinessSnapshot`, `ReadinessOverview`, `ReadinessDetail`
- **V5.1** (actual): Define `EvaluationSnapshot`, `RuleDefinition`, `AssessmentFinding`, `ActionRef`, `Recommendation`, `HealthScore`, `ReadinessAssessment`, `ReadinessResponse`

**Resolución**:
- V5.1 adoptado como contrato canónico
- V3 movido a sección Historical Contracts como REPLACED, con motivo documentado
- Secciones arquitectónicas válidas de V3 preservadas (integridad, pipeline, endpoint, UI, plan, naming)
- Detalle completo en `openspec/CHANGE_PROPOSAL_LOTE_A.md`

**Riesgo mitigado**: El error era silencioso (TypeScript no detectaba el conflicto por nombres diferentes). Ahora hay un solo contrato activo.

---

## C2 — Readiness: dos dominios diferentes con el mismo nombre

**Severidad**: MEDIA → **RESUELTO (2026-07-29)**
**Archivos**: `openspec/changes/s7-05c-canonical-readiness/`, `openspec/changes/s7-06-readiness-dashboard/`, `src/lib/readiness/`, `openspec/accounting-readiness-center/`

**Hallazgo**: Existen dos conceptos completamente distintos llamados "readiness":
- **Shadow Rules Readiness** (existente): `s7-05c`, `s7-06`, `src/lib/readiness/`, `canonical-readiness-service.ts` — evalúa si un modelo de IA en shadow mode está listo para promoverse a activo. Admin-facing.
- **Accounting Period Readiness** (propuesto): `openspec/accounting-readiness-center/` — evalúa si un período contable está listo para cerrarse. User-facing (Centro Contable).

**Resolución**:
- `docs/glossary.md` actualizado con ambas entradas y regla arquitectónica explícita
- Regla: "Estos dominios no deben compartir contratos, servicios ni terminología sin mapeo explícito"
- `DOCUMENT_AUTHORITY_MAP.md` actualizado con tabla de dominios

---

## C3 — Operation Controller: 4 documentos en conflicto

**Severidad**: ALTA → **RESUELTO (2026-07-29)**
**Archivos**:
1. `openspec/operation-controller/` — CANONICAL (congelado)
2. `openspec/archive/operation-controller-v4-exploration.md` — REPLACED_BY openspec
3. `openspec/archive/operation-controller-v3.1.md` — REPLACED_BY openspec (histórico)
4. `PHASE3_BASELINE.md` — IMPLEMENTATION_PLAN (subordinado)

**Hallazgo**: Cuatro documentos describiendo el mismo componente a diferentes versiones. v3.1 contenía Planner, Plan Guard, retry/rollback y stateHash — decisiones deliberadamente descartadas en openspec. v4 era una exploración que eliminó el Execution Contract.

**Resolución**:
- DESIGN-v4.md archivado como exploración descartada
- operation-controller-v3.1.md archivado como histórico REPLACED
- openspec/operation-controller/ ratificado como CANONICAL
- PHASE3_BASELINE.md mantenido en raíz como IMPLEMENTATION_PLAN
- `src/internal/operation-controller/` auditado: 100% alineado con openspec (sin Planner, sin Plan Guard, sin retry/rollback, sin stateHash)

**Riesgo mitigado**: No hay divergencia entre código y diseño. Los documentos históricos están marcados como REPLACED y no representan decisiones vigentes.

---

## C4 — docs/architecture/rule-engine.md (Draft) vs implementación existente

**Severidad**: BAJA (por ahora)
**Archivos**: `docs/architecture/rule-engine.md` (Draft), código existente en `src/lib/rules/`

**Hallazgo**: El documento de arquitectura del rule engine está en estado Draft. Si la implementación real diverge del documento, se pierde la fuente de verdad.

**Acción requerida**: Sin acción urgente. Incluir en plan de consolidación como prioridad baja: actualizar o archivar el draft.

---

## C5 — AUDIT_CONTRACT.md no trackeado vs documentos de openspec/

**Severidad**: MEDIA
**Archivos**: `AUDIT_CONTRACT.md`, `openspec/changes/sprint-3-audit-explainability/`, `agent-ctx/15-audit-migration-design.md`

**Hallazgo**: `AUDIT_CONTRACT.md` es un documento de 558 líneas que establece un "contrato de auditoría" con reglas estrictas ("No modificar durante Fase A"). No tiene historial git. Existe además `agent-ctx/15-audit-migration-design.md` que describe una migración del Audit Contract pero tampoco está trackeado. Es posible que sea un documento generado externamente.

**Riesgo**: Sin historial git, no se puede rastrear cuándo ni por qué se creó. Las reglas que impone ("No modificar") bloquean cambios que podrían ser necesarios.

**Acción requerida**: Determinar origen y propósito. Si es parte del proyecto, trackearlo con commit. Si es externo, moverlo a `docs/external/`.

---

## C6 — agent-ctx/: documentos con instrucciones potencialmente obsoletas

**Severidad**: MEDIA
**Archivos**: `agent-ctx/*.md`

**Hallazgo**: La carpeta `agent-ctx/` contiene 15 documentos con instrucciones para agentes de IA, incluyendo diseños (11, 12, 13), specs de auditoría (14, 15), y contexto de cambios previos. Algunos pueden contener instrucciones que contradicen decisiones actuales (ej: Phase 3 congelado vs activo).

**Riesgo**: Un agente futuro que cargue estos documentos podría actuar sobre instrucciones obsoletas.

**Acción requerida**: Como parte de Sprint 0, revisar cada documento de `agent-ctx/` y marcarlo como `CANONICAL`, `SUPERSEDED_BY: <ref>`, o `ARCHIVED`. Priorizar documentos 11-15 que contienen diseño arquitectónico.

---

## C7 — Faltan referencias cruzadas entre documentos canónicos

**Severidad**: BAJA
**Hallazgo**: Los documentos canónicos (`docs/architecture/*`, `docs/domain/*`, `docs/process/*`) existen pero no tienen referencias cruzadas explícitas entre sí. Por ejemplo, `glossary.md` no referencia a `accounting-invariants.md`, y `invariants.md` no referencia a `business-rules.md`.

**Riesgo**: Bajo para el desarrollo inmediato. Los documentos son independientes y autocontenidos.

**Acción requerida**: Incluir en plan de consolidación como mejora de calidad (prioridad baja).

---

## C8 — S7 series: múltiples specs abiertas con dependencias no documentadas

**Severidad**: BAJA
**Hallazgo**: Hay 10+ cambios S7 abiertos (`s7-04b` a `s7-15`) con dependencias implícitas. Por ejemplo, `s7-06-readiness-dashboard` probablemente depende de `s7-05c-canonical-readiness`, pero no está documentado en los specs.

**Acción requerida**: Documentar dependencias entre cambios S7 como parte del plan de consolidación. Prioridad baja — no bloquea.

---

## C9 — DESIGN-v4.md: posible conflicto con openspec/operation-controller/

**Severidad**: BAJA (congelado)
**Archivos**: `DESIGN-v4.md` (raíz), `openspec/operation-controller/`

**Hallazgo**: `DESIGN-v4.md` en la raíz del proyecto menciona Operation Controller v4. `openspec/operation-controller/` contiene el diseño oficial (probablemente v3). Sin historial git, no se sabe si v4 fue un diseño exploratorio o una versión posterior descartada.

**Acción requerida**: Migrar a `openspec/archive/` con nota de congelamiento. No requiere decisión arquitectónica.