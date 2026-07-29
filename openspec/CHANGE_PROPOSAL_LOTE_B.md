# CHANGE_PROPOSAL_LOTE_B — Operation Controller: autoridad documental

**Estado**: PROPUESTA (pendiente de aprobación)
**Fecha**: 2026-07-29
**Documentos en conflicto**:
1. `openspec/operation-controller/` (design.md + spec.md + explore.md + mvp-backlog.md + spike-report.md) — **oficial congelado**
2. `DESIGN-v4.md` (raíz del proyecto) — no trackeado
3. `docs/architecture/operation-controller-v3.1.md` — no trackeado
4. `PHASE3_BASELINE.md` (raíz del proyecto) — no trackeado

---

## 1. Inventario de documentos

### Documento 1: `openspec/operation-controller/` (5 archivos)

| Archivo | Líneas | Propósito |
|---|---|---|
| `design.md` | 224 | Kernel: pipeline Intent → Policy → Execution Contract → Execute → Verify + Evidence transversal |
| `spec.md` | 173 | Invariantes (I1-I15), requisitos funcionales (RF01-RF14), no funcionales (RNF01-RNF10), criterios de aceptación (CA01-CA18) |
| `explore.md` | — | Exploración previa al diseño |
| `mvp-backlog.md` | — | Backlog de MVP |
| `spike-report.md` | — | Reporte de spike técnico |

**Estado actual**: CANONICAL (congelado). Es el diseño oficial aprobado. Tiene spec, invariantes, requisitos, amenazas, manejo de errores.

**Pipeline**: `Intent → Policy → Execution Contract → Execute → Verify`
**Estados**: `Requested → [Denied | PendingApproval | Authorized] → Executing → Executed → [Verified → Completed | Failed]`
**Componentes**: Intent, Policy, Execution Contract, Execute, Verify, Evidence (transversal)
**Principios**: Sin retry, sin rollback, fail-closed, append-only evidence

---

### Documento 2: `DESIGN-v4.md` (318 líneas, no trackeado)

**Estado actual**: SUPERSEDED o EXPLORATORY — sin relación documentada con el diseño openspec

**Pipeline**: `Intent → Policy → Execute → Verify`
**Estados**: `Requested → [Denied | Authorized] → Executing → Executed → [Verified → Completed | Failed]`
**Ausencia clave**: No tiene **Execution Contract**. Policy pasa directamente a Execute.
**Ausencia clave**: No tiene **PendingApproval** — solo Denied o Authorized.
**Similitud**: Amenazas (10), principios (no retry/rollback), estructura general — casi idéntico al openspec excepto por la falta de Contract.

**Hipótesis**: DESIGN-v4.md parece ser una **versión intermedia descartada** entre el diseño openspec y alguna exploración. Es más simple que openspec (menos componentes) pero se presenta como "v4", lo que podría indicar que intentó simplificar el kernel eliminando el Execution Contract.

---

### Documento 3: `docs/architecture/operation-controller-v3.1.md` (479 líneas, no trackeado)

**Estado actual**: HISTÓRICO (v3.1 → anterior al diseño openspec)

**Pipeline**: `Request/Intent → Planner → Plan Guard → Policy Engine → Executor → Verifier → Evidence`
**Estados**: `Requested → Planned → [Authorized | Rejected] → Executing → [Executed → Verified → Completed | Failed]`
**Componentes**: 6 en kernel (Request/Intent, Planner, Plan Guard, Policy Engine, Executor, Verifier) + Evidence como state machine + Resource Registry (fuera)

**Diferencias fundamentales con openspec**:
- Tiene **Planner** (produce Execution Plan con Operations + Budget)
- Tiene **Plan Guard** (valida scope, budget, permisos antes de autorizar)
- Policy Engine **fusiona autorización + política de negocio**
- **Permite retry y rollback** (openspec lo prohíbe explícitamente)
- **Evidence con stateHash chain** para auditoría (openspec no lo tiene)
- **Resource Registry contract** definido (ID, type, driver, capabilities, limits)
- **Driver interface** definida (execute, verify, getLimits)
- **9 estados** vs 8 del openspec (incluye Planned y Rejected)
- Mucho más detallado — describe implementación, no solo kernel

---

### Documento 4: `PHASE3_BASELINE.md` (177 líneas, no trackeado)

**Estado actual**: PLAN DE INTEGRACIÓN — no es un diseño alternativo

**Propósito**: Documentar cómo integrar Operation Controller con OpenCode (custom tool en `.opencode/tools/`, modificar `opencode.json`, etc.)

**Contenido**:
- Flujo actual (sin OC): edición directa por herramientas nativas + shell bypass
- Flujo propuesto (con OC): `operation-controller-write` custom tool → pipeline OC → escritura
- Código existente: `src/internal/operation-controller/` (FileResource, controller.ts)
- `verificationScope: 'scoped'` como decisión deliberada (FULL no implementado)
- opencode.json: edit=deny, bash=deny, task=deny

**No está en conflicto** con los otros documentos — describe implementación, no diseño. Pero referencia decisiones de diseño no documentadas (verificationScope, snapshot).

---

## 2. Análisis de impacto

### 2.1 Relación entre documentos

```
v3.1 (docs/architecture/) [479 líneas, detallado]
  │  Diseño original con Planner + Plan Guard + retry/rollback
  │
  ├──→ openspec/operation-controller/ [oficial, congelado]
  │     Kernel simplificado: sin Planner, sin Plan Guard, sin retry
  │     Agrega: Execution Contract, PendingApproval
  │     Evidence simplificado (sin stateHash)
  │
  ├──→ DESIGN-v4.md [exploración descartada]
  │     Simplificación adicional: sin Execution Contract
  │     Similar al openspec pero más simple
  │     Posible propuesta de simplificación que no se adoptó
  │
  └──→ PHASE3_BASELINE.md [plan de integración]
        Implementación concreta, referencia a código existente
        No es un diseño, es un plan de acción
```

### 2.2 Decisiones divergentes entre versiones

| Decisión | v3.1 | openspec | v4 |
|---|---|---|---|
| **Execution Contract** | No existe | **Sí**, entre Policy y Execute | No existe |
| **Planner** | Sí (produce ExecutionPlan) | No | No |
| **Plan Guard** | Sí (valida scope/budget/permisos) | No | No |
| **PendingApproval state** | No (solo Authorized/Rejected) | **Sí** | No |
| **Retry / rollback** | Sí (permite) | **No** (explícitamente prohibido) | No (explícitamente prohibido) |
| **Evidence stateHash** | Sí (SHA256 chain) | No | No |
| **Resource Registry** | Sí (contrato definido) | Fuera de alcance | Fuera de alcance |
| **Driver interface** | Sí (execute/verify/getLimits) | No definida | No definida |
| **Budget en Intent** | En ExecutionPlan | En Execution Contract | Sí, como metadata |
| **Verification triple** | Structural + Functional + Policy | Contract compliance | Contract compliance |
| **Threat model** | No tiene tabla explícita | **Sí** (10 amenazas) | **Sí** (10 amenazas, casi idéntico) |

### 2.3 Impacto en código existente

El código en `src/internal/operation-controller/` incluye:
- `controller.ts` — ejecuta el pipeline y se usa en tests
- `resources/file-resource.ts` — FileResource con execute() y snapshot()

Por `PHASE3_BASELINE.md`:
- `FileResource.snapshot()` existe y funciona (workspace completo)
- `FileResource.snapshotObserved(paths)` existe para producción
- `verificationScope: 'scoped'` está hardcodeado en la implementación
- `controller.ts` implementa el pipeline pero no está claro qué versión sigue

El código existente puede estar implementando una mezcla de openspec y decisiones propias de PHASE3_BASELINE. No se modificará durante este Lote B (solo consolidación documental).

### 2.4 Impacto en prompts / reglas de IA

Los agentes futuros que carguen agent-ctx/ pueden encontrar referencias a Planner, Plan Guard o v4 que ya no existen en el diseño canónico. La consolidación debe hacer visibles estas diferencias.

---

## 3. Detección de conflictos

### C1 — Execution Contract: openspec lo exige, v3.1 y v4 no lo tienen

El openspec introduce **Execution Contract** como separación entre Policy y Execute. Es un artefacto inmutable que describe exactamente qué quedó autorizado. v3.1 no lo tiene (Planner produce ExecutionPlan, Policy autoriza, Executor ejecuta). v4 no lo tiene (Policy autoriza directamente a Execute).

**Riesgo**: Un futuro implementador podría saltarse el Execution Contract porque "v3.1 no lo necesita" o "v4 no lo tiene".

**Severidad**: ALTA (pero mitigada por congelamiento del openspec)

### C2 — Retry y rollback: v3.1 lo permite, openspec lo prohíbe

v3.1 explícitamente permite retry y rollback (con política configurable). openspec lo prohíbe: "El kernel no intenta recuperarse de ningún error".

**Riesgo**: Esta no es una diferencia menor. Es una **decisión arquitectónica fundamental**. Si alguien implementa retry basándose en v3.1, viola el diseño openspec.

**Severidad**: ALTA (decisión arquitectónica incompatible)

### C3 — Planner: existe en v3.1, ausente en openspec

v3.1 tiene un Planner que produce un Execution Plan con operaciones, budget y dependencias. openspec no tiene Planner — Policy recibe el Intent directamente y produce un Execution Contract.

**Riesgo**: No hay riesgo inmediato (openspec es el canónico), pero la ausencia de Planner significa que la responsabilidad de "planificar" la ejecución recae en otro lugar (¿el requester? ¿el Driver?).

**Severidad**: MEDIA (diferencia arquitectónica importante, pero openspec es claro)

### C4 — Evidence con stateHash: solo v3.1 lo tiene

v3.1 tiene `stateHash` (SHA256 del estado post-transición) para detectar manipulación del registro. openspec no lo tiene.

**Riesgo**: Si se requiere auditoría forense, openspec no tiene mecanismo para detectar manipulación del registro de evidencia.

**Severidad**: BAJA (postergable — openspec prioriza simplicidad del kernel)

### C5 — DESIGN-v4.md es una anomalía: "v4" pero más simple que openspec

El título dice "v4" lo que sugiere que debería post-datar al openspec. Sin embargo, su contenido es **menos completo** (falta Execution Contract, PendingApproval). Las amenazas y principios son casi idénticos al openspec, lo que sugiere que **es una copia del openspec con secciones eliminadas**, no una evolución.

**Hipótesis más probable**: DESIGN-v4.md fue una **exploración de simplificación** que se creó durante el proceso de diseño pero no se adoptó. El openspec retuvo el Execution Contract.

**Severidad**: BAJA (el openspec es el canónico congelado, v4 es irrelevante)

### C6 — PHASE3_BASELINE.md contiene decisiones de implementación no documentadas en el openspec

PHASE3_BASELINE.md introduce conceptos que no están en el diseño openspec:
- `verificationScope: 'scoped'` vs `'full'`
- `snapshot()` vs `snapshotObserved(paths)`
- OpenCode integration pattern (custom tool, no MCP)

**Riesgo**: Estas decisiones de implementación podrían contradecir el diseño openspec sin que sea evidente. Por ejemplo, `verificationScope: 'scoped'` reduce la cobertura de Verify (no verifica mutaciones laterales fuera de observedPaths).

**Severidad**: MEDIA — requiere verificar que la implementación en `src/internal/operation-controller/` respeta el diseño openspec.

---

## 4. Recomendación

### 4.1 Autoridad documental propuesta

| Documento | Estado propuesto | Justificación |
|---|---|---|
| `openspec/operation-controller/` | **CANONICAL** (congelado, sin cambios) | Es el diseño oficial. Contiene spec, invariantes, requisitos, amenazas. |
| `docs/architecture/operation-controller-v3.1.md` | **REPLACED_BY** openspec | v3.1 fue reemplazado por openspec. Contiene decisiones (retry/rollback, Planner, Plan Guard) que el openspec deliberadamente descartó. |
| `DESIGN-v4.md` | **REPLACED_BY** openspec (o ARCHIVED como exploración) | Es una simplificación no adoptada. No aporta valor como documento activo. |
| `PHASE3_BASELINE.md` | **IMPLEMENTATION_PLAN** (subordinado al openspec) | No es un diseño alternativo, es un plan de integración. Debe moverse junto al código que documenta. |

### 4.2 Resolución de conflictos

| Conflicto | Resolución propuesta |
|---|---|
| C1 — Execution Contract | El openspec es canónico. Execution Contract se mantiene. v3.1 y v4 son históricos. |
| C2 — Retry/rollback | El openspec prohíbe retry/rollback. v3.1 es histórico. No implementar retry. |
| C3 — Planner | No existe en openspec. No implementar Planner. |
| C4 — Evidence stateHash | Postergable. Si se requiere en el futuro, debe agregarse al openspec mediante propuesta. |
| C5 — DESIGN-v4.md | Marcar como exploración descartada. Mover a `openspec/archive/`. |
| C6 — PHASE3_BASELINE.md | Mantener como plan de integración, verificar consistencia con openspec. |

Como v3.1 contiene mucha más profundidad técnica (interfaces, tipos, flujos detallados) que el openspec, conviene preservarlo como referencia histórica completa. No borrar.

### 4.3 Acciones propuestas

| # | Acción | Depende de |
|---|---|---|
| 1 | Aprobar esta propuesta | — |
| 2 | Mover `DESIGN-v4.md` → `openspec/archive/operation-controller-v4-exploration.md` con nota REPLACED_BY openspec | #1 |
| 3 | Mover `docs/architecture/operation-controller-v3.1.md` → `openspec/archive/operation-controller-v3.1.md` con nota REPLACED_BY openspec | #1 |
| 4 | Mover `PHASE3_BASELINE.md` → `openspec/archive/phase3-baseline.md` (nota: implementation plan, subordinado a openspec) o dejarlo donde está si documenta código activo | #1 |
| 5 | Verificar que `src/internal/operation-controller/` implementa el diseño openspec y no v3.1 | #4 |
| 6 | Actualizar `DOCUMENT_AUTHORITY_MAP.md` | #2, #3, #4 |
| 7 | Actualizar `DOCUMENT_CONFLICT_REPORT.md` (agregar entradas C1-C6) | #6 |

---

## 5. Riesgo de no hacer nada

1. Un desarrollador lee `DESIGN-v4.md` e implementa sin Execution Contract
2. Un desarrollador lee `v3.1.md` e implementa retry/rollback, violando el diseño openspec
3. PHASE3_BASELINE.md referencia código que podría estar implementando un diseño diferente al openspec
4. Dentro de 3 semanas, exactamente el mismo problema que Readiness: múltiples fuentes de verdad coexistiendo

---

**Estado**: PENDIENTE DE APROBACIÓN