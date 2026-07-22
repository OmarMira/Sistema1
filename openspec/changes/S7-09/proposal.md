# S7-09 — Operational Policy Observation en Import

## Problema

Solo Apply All consume OperationalPolicyDecision. Import, Reconciliation y Single Apply están fuera del sistema de política. Sin una segunda implementación real, no podemos decidir si existe un patrón compartido o si cada contexto necesita su propio adaptador.

## Objetivo

Integrar OperationalPolicyDecision en el flujo de Import de forma exclusivamente observacional, best-effort y sin modificar el comportamiento productivo.

## Alcance

### Dentro
- Evaluación observacional en importTransactions()
- Config propia (IMPORT_OBSERVATION_CONFIG)
- Flag independiente OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED
- policyObservation en ImportResult (backend + frontend)
- `PolicyObservationResponse` como tipo canónico en `operational-policy/types.ts`
- Migración tipada de `apply-all-observer.ts` al tipo canónico (elimina duplicación local)
- Audit log con payload compacto
- Best-effort: nunca rompe el flujo productivo

### Fuera
- UI, WARN, componentes visuales
- PolicyConsumptionService compartido
- Reconciliation, Single Apply
- Helpers compartidos (postergado)
- Enforcement o bloqueo
- Timeout (medir primero)

## Decisiones Arquitectónicas

### AD-1: Invariante de integración

Operational Policy MUST observe the same persisted shadow state that will be visible to future consumers. The observation executes only after shadow metrics persistence is complete.

### AD-2: Flag independiente

OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED — independiente de Apply All, Shadow, Adapter.

### AD-3: Config dedicada

IMPORT_OBSERVATION_CONFIG con source: 'IMPORT', mismo OBSERVATIONAL_POLICY_PROFILE, mismos thresholds, 90d window. Sin acoplamiento a APPLY_ALL_OBSERVATION_CONFIG.

### AD-4: Audit log

Mismo action: 'OPERATIONAL_POLICY_OBSERVATION' que S7-08.
entity: 'BankStatement', entityId: result.statementId.
Payload compacto: policySchemaVersion, context, profileId, profileVersion, action, reasonCode, readinessStatus, metricsWindow.
No incluye CanonicalReadiness (misma política que S7-08).

### AD-5: Response contract

policyObservation?: PolicyObservationResponse en ambas definiciones de ImportResult (backend + frontend).

Es opcional por contrato. El campo puede estar ausente cuando:
- la flag está deshabilitada
- la observación no aplica
- el flujo termina antes del punto de observación

Si la flag está habilitada y se intenta evaluar:
- éxito → { status: 'AVAILABLE', decision }
- fallo → { status: 'UNAVAILABLE', errorCode }

### AD-6: Una observación por importación

Cada ejecución de importTransactions() genera como máximo una observación. El statementId es el correlator con las transacciones, el shadow summary y los audit logs de validación de titular.

## Archivos

Crear:
- src/lib/operational-policy/import-observation-config.ts

Modificar:
- src/lib/operational-policy/types.ts (agregar tipos canónicos)
- src/lib/operational-policy/apply-all-observer.ts (migrar al tipo canónico, eliminar duplicación local)
- src/lib/services/import.service.ts
- src/lib/rule-engine/flag.ts
- src/lib/types/import-page.tsx
- tests/services/shadow-mode-import.test.ts

No tocar: policy-service, apply-all-use-case, apply-all-observation-config, reconciliation, prisma, components, bank-rules

## Riesgos

| # | Riesgo | Mitigación |
|---|--------|------------|
| 1 | Latencia: evaluación antes del HTTP return | Medir con observabilidad existente. Timeout en S7-10+ si hace falta. |
| 2 | Consistencia de shadow: ambos operan sobre PostgreSQL, escritura visible inmediatamente | Riesgo bajo — misma DB transaccional. |
| 3 | Test existente que rompe: shadow-mode-import.test.ts:273 keys exactas | Actualizar keys esperadas. |
| 4 | Duplicación accidental entre Apply All e Import: crear helpers compartidos prematuramente solo porque dos consumidores tienen código similar | Objetivo explícito de S7-09: observar diferencias, no eliminarlas. Cualquier helper compartido queda fuera de alcance. |

## Criterios de éxito

1. Flag OFF → ImportResult semánticamente idéntico (excepto ausencia de policyObservation). Mismos datos, mismos tests.
2. Flag ON → policyObservation en response + audit log con payload compacto.
3. 427+ tests verdes (todos los existentes + nuevos).
4. Zero cambios en DB, UI, o flujos no-Import.
5. Dos implementaciones observacionales (Apply All + Import) sin abstracción compartida.
