# Document Authority Map — AccountExpress

Generado: 2026-07-29
Propósito: Única fuente de verdad sobre el estado y autoridad de cada documento del proyecto.

## CANONICAL (autoridad vigente)

| Documento | Dominio | Última modificación |
|---|---|---|
| `docs/architecture/overview.md` | Arquitectura general | 2026-07-11 |
| `docs/architecture/bank-import.md` | Importación bancaria | 2026-07-11 |
| `docs/architecture/ai-decision-model.md` | Modelo de decisión de IA | 2026-07-11 |
| `docs/business-rules.md` | Reglas de negocio | 2026-07-11 |
| `docs/invariants.md` | Invariantes del sistema | 2026-07-11 |
| `docs/glossary.md` | Glosario | 2026-07-11 |
| `docs/domain/accounting-invariants.md` | Invariantes contables (INV-001) | 2026-07-16 |
| `docs/process/engineering-principles.md` | Principios de ingeniería | 2026-07-11 |
| `docs/process/governance.md` | Gobernanza del proyecto (GOV-001) | 2026-07-16 |
| `docs/process/runtime-data-policy.md` | Política datos runtime (RDP-001) | 2026-07-16 |
| `docs/releases/v0.9.0.md` | Release notes v0.9.0 | 2026-07-11 |
| `RELEASE_NOTES.md` | Release notes | 2026-07-11 |
| `SECURITY_AUDIT.md` | Auditoría de seguridad | 2026-07-10 |
| `SECURITY_HARDENING_REPORT.md` | Reporte de hardening | 2026-07-10 |
| `TRANSACTIONAL_INTEGRITY_AUDIT.md` | Auditoría integridad transaccional | 2026-07-23 |
| `docs/adr/ADR-001` a `ADR-009` | Decisiones arquitectónicas | 2026-07-11 |
| `engineering-rules/ux-boundary.md` | Límite UX | 2026-07-06 |

## SUPERSEDED (reemplazados, mantener por referencia histórica)

| Documento | Reemplazado por | Nota |
|---|---|---|
| `docs/archive/entity-onboarding-process-legacy.md` | Código actual + openspec | Histórico de feat/entities-bank-rules |
| `openspec/archive/sprint-4-failed-attempt-2026-07-13/` | N/A | Intento fallido, referencia histórica |
| `openspec/changes/archive/*` | openspec/changes/archive/ | Archivado como completado |

## DRAFT (en diseño, sin implementar)

| Documento | Riesgo |
|---|---|
| `docs/architecture/rule-engine.md` | Status: Draft — puede divergir de implementación existente |
| `openspec/changes/s5-01-transaction-invariants/` | Diseño completo, 40 tareas sin ejecutar |
| `openspec/changes/S7-10-enforcement-foundations/` | Solo design.md |
| `openspec/changes/S7-10A-interaction-model/` | Solo design.md |
| `openspec/changes/S7-11A-apply-all-enforcement-contract/` | Solo contract.md |
| `openspec/changes/s7-15-interactive-ambiguity-resolution/` | Solo design.md |

## IN PROGRESS (cambios activos con tareas pendientes)

| Documento | Estado |
|---|---|
| `openspec/changes/s7-04b-apply-all-resolver/` | Spec + tasks |
| `openspec/changes/s7-04c-functional-divergence/` | Spec + tasks |
| `openspec/changes/s7-05a-apply-all-use-case/` | Spec + tasks |
| `openspec/changes/s7-05b-shadow-metrics-reporting/` | Spec + tasks |
| `openspec/changes/s7-05c-canonical-readiness/` | Spec + tasks |
| `openspec/changes/s7-06-readiness-dashboard/` | Spec + tasks |
| `openspec/changes/s7-07-operational-policy-service/` | Spec + tasks |
| `openspec/changes/s7-08-observational-policy-apply-all/` | Spec + design + tasks |
| `openspec/changes/S7-09/` | Proposal + spec + design + tasks |
| `openspec/changes/sprint-1-pipeline-determinista/` | Sprint 1 + 2 documents |
| `openspec/changes/sprint-3-audit-explainability/` | Completed (verify-report.md presente) |
| `openspec/changes/s7-14-transparent-rule-matching/` | **COMPLETED** (último commit) |
| `openspec/accounting-readiness-center/` | **EN DISEÑO — CONFLICTO INTERNO** |

## UNTRACKED (sin historial git)

| Documento | Dominio |
|---|---|
| `AUDIT_CONTRACT.md` | Auditoría (558 líneas, v1.0) |
| `DESIGN-v4.md` | Operation Controller v4 |
| `PHASE3_BASELINE.md` | Operation Controller Fase 3 |
| `docs/architecture/operation-controller-v3.1.md` | Operation Controller v3.1 |
| `agent-ctx/15-audit-migration-design.md` | Migración Audit Contract |

## FROZEN

| Documento | Motivo |
|---|---|
| `openspec/operation-controller/` | Congelado indefinidamente por decisión del arquitecto |
| `DESIGN-v4.md` | De facto congelado por la decisión anterior |
| `PHASE3_BASELINE.md` | De facto congelado por la decisión anterior |
| `docs/architecture/operation-controller-v3.1.md` | De facto congelado por la decisión anterior |

## OBSOLETO / REDUNDANTE (requiere verificación)

| Documento | Problema |
|---|---|
| `openspec/changes/2026-07-05-ux-hardening/sprint.md` | Sprint completado, mantener como referencia |
| `openspec/changes/2026-07-06-company-structure/sprint.md` | Sprint completado, mantener como referencia |

## Resolved (Sprint 0)

| Documento | Resolución |
|---|---|
| `openspec/accounting-readiness-center/design.md` | CONSOLIDADO: V5.1 canónico, V3 histórico REPLACED |
| `openspec/DOCUMENT_CONFLICT_REPORT.md` | C1 marcado como RESOLVED |
| `docs/glossary.md` | Entradas agregadas: Shadow Rules Readiness + Accounting Readiness con regla arquitectónica |
| `openspec/DOCUMENT_AUTHORITY_MAP.md` | Este archivo actualizado |

## Nota: dominios Readiness

| Documento | Dominio |
|---|---|
| `openspec/changes/s7-05c-canonical-readiness/` | Shadow Rules Readiness |
| `openspec/changes/s7-06-readiness-dashboard/` | Shadow Rules Readiness |
| `src/lib/readiness/` + `canonical-readiness-service.ts` | Shadow Rules Readiness (implementado) |
| `src/lib/accounting-readiness/` (propuesto) | Accounting Period Readiness |
| `openspec/accounting-readiness-center/` | Accounting Period Readiness |

**Regla**: No compartir contratos, servicios ni terminología sin mapeo explícito.