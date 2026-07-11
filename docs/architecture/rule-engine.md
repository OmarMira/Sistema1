# Rule Engine

**Status:** Draft — en diseño para el próximo sprint.

---

## Problem

<!-- Pendiente: describir el problema que resuelve el motor de reglas -->

---

## Goals

<!-- Pendiente: objetivos medibles del motor de reglas -->

---

## Non-Goals

<!-- Pendiente: qué está explícitamente fuera de alcance -->

---

## Current state

El proyecto tiene reglas (`BankRule` model + `rules/` JSON) pero no un motor determinista autónomo. Actualmente:

- Reglas básicas por empresa (match por descripción, monto)
- Clasificación AI como fallback cuando no hay regla
- Sin pipeline formalizado de evaluación

---

## Known problems

| Problema | Detalle |
|---|---|
| **Orden de evaluación** | No está definido explícitamente el orden de prioridad entre reglas |
| **Condiciones compuestas** | No soporta AND/OR entre condiciones |
| **Match parcial** | No hay fuzzy matching ni patrones tipo regex |
| **Testing** | Sin suite dedicada para el engine |
| **Performance** | Sin índices ni caché para evaluaciones frecuentes |

---

## Agreed decisions

- **Deterministic before AI**: toda regla explícita tiene prioridad sobre clasificación probabilística
- **Reglas por empresa**: cada `BankRule` pertenece a una compañía
- **Config externalizada**: reglas en DB, no hardcodeadas

---

## Input Contract

<!-- Pendiente: formato exacto de la transacción de entrada -->

---

## Output Contract

<!-- Pendiente: formato exacto de la regla matched y su confidence -->

---

## Evaluation Pipeline

<!-- Pendiente: orden de evaluación, cómo se recorren las reglas, stopping criteria -->

---

## Conflict Resolution

<!-- Pendiente: qué pasa cuando dos reglas matchean la misma transacción -->

---

## Confidence

<!-- Pendiente: cómo se calcula el nivel de confianza de un match -->

---

## Explainability

<!-- Pendiente: cómo el motor explica por qué matcheó una regla -->

---

## Acceptance Tests

<!-- Pendiente: escenarios de prueba clave del motor -->

---

## Open questions

- ¿Formato de condiciones: JSON estructurado o DSL?
- ¿Orden de evaluación: prioridad numérica o topological sort?
- ¿Soporte para reglas globales (sin companyId)?
- ¿Rollback / simulación antes de aplicar reglas nuevas?

---

## Contract (not yet approved)

```
Input:  BankTransaction (sin clasificar)
Output: BankRule (match) + confidence

Rule:
  - conditions: []       # condiciones AND/OR
  - action:              # clasificación a aplicar
      - entityId
      - category
      - glAccountId
  - priority: number
  - companyId: string?
```

---

## Future Work

<!-- Pendiente: mejoras post-v1, integraciones, UI -->

---

## Next steps

1. Definir formato de condiciones
2. Implementar pipeline de evaluación ordenada
3. Agregar fuzzy matching
4. Suite de tests dedicada
5. UI para crear/ordenar reglas
