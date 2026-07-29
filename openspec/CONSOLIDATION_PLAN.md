# Sprint 0: Consolidation Proposal

## Principios
1. No se elimina nada — se mueve o se marca
2. Ningún cambio sin justificación documentada
3. Aprobación requerida antes de ejecutar cada acción

---

## LOTE A — Crítico (bloquea avance del Accounting Readiness Center) ✅ COMPLETADO

### A1: Resolver V3 vs V5.1 en `design.md`
**Acción**: V5.1 adoptado como canónico, V3 movido a Historical Contracts como REPLACED
**Estado**: COMPLETADO (2026-07-29)
**Evidencia**: `openspec/CHANGE_PROPOSAL_LOTE_A.md`, `design.md` actualizado

### A2: Separar conceptos "Readiness" en documentación
**Acción**: Glosario actualizado con ambas entradas + regla arquitectónica
**Estado**: COMPLETADO (2026-07-29)
**Evidencia**: `docs/glossary.md` actualizado

---

## LOTE B — Operation Controller (congelado, postergable)

### B1: Archivar documentos huérfanos
**Acción**: Mover a `openspec/archive/`:
- `DESIGN-v4.md` → `openspec/archive/operation-controller-v4-design.md`
- `PHASE3_BASELINE.md` → `openspec/archive/operation-controller-phase3-baseline.md`
- `docs/architecture/operation-controller-v3.1.md` → `openspec/archive/operation-controller-v3.1.md`
**Propuesta**: Cada archivo con nota de cabecera: "FROZEN — subordinado a openspec/operation-controller/"
**Requiere aprobación**: SÍ

---

## LOTE C — Documentos no trackeados

### C1: Audit Contract
**Acción**: Decidir si trackear o mover a `docs/external/`
**Propuesta**: Trackear con commit inicial y nota de origen
**Requiere aprobación**: SÍ

### C2: agent-ctx/ — revisión de documentos 11-15
**Acción**: Revisar uno por uno, marcar estado
**Propuesta**: Prioridad media — postergar hasta después de A y B
**Requiere aprobación**: SÍ (para la revisión)

---

## LOTE D — Mejoras continuas (no bloqueantes)

### D1: Referencias cruzadas entre docs canónicos
**Acción**: Agregar `See also` en documentos principales
**Prioridad**: Baja — después de A, B, C

### D2: Documentar dependencias S7
**Acción**: Agregar columna `Depends on` en cada spec
**Prioridad**: Baja — después de A, B, C

### D3: Rule Engine Draft
**Acción**: Decidir si actualizar o archivar
**Prioridad**: Baja