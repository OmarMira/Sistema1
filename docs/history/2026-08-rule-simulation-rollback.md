# Rule Simulation and Rollback: August 2026 (BRE-013)

## Before

Aplicar reglas (apply-all y single-rule `action=apply`) persistía la clasificación contable
y los asientos sin un ancla transaccional durable: no había un registro que identificara UNA
ejecución ni relacionara transacciones y asientos con el apply que los produjo. No existía
reversión compensada y trazable. La simulación de reglas era solo un testeador orgánico de
condiciones, no un pronóstico fiel del apply.

## What was done

| Momento | Acción |
|---|---|
| **Ancla durable** | Nuevo modelo `RuleApplyRecord` (1 tabla, FKs nullable, `idempotencyKey` único), creado DENTRO de la transacción de apply |
| **Guard fiscal** | Validación de período fiscal por fecha dentro de apply y revert (sin TOCTOU); cualquier período cerrado aborta todo |
| **Rollback compensatorio** | Reversión por void de journals + recálculo de balances + desvinculación de FKs + CAS `applied → reverted`; idempotente; sin hard-delete ni `reversalOfId` |
| **Simulación read-only** | Pronóstico que reutiliza el matcher real; orden canónico determinista; sin claims contables; coexiste con la ruta legacy |
| **Entry point** | Ruta propia de rollback; `action=apply` crea registro classification-only |
| **Tests 4.1–4.10** | Unit (CAS 0-row, idempotencia), integración real-DB (atomicidad, rollback, fiscal, concurrencia de revert, classification), simulación, E2E apply→rollback→reapply |
| **Carrera apply-vs-apply** | Descubierta post-implementación: dos applies concurrentes sobre la MISMA fila podían persistir un `RuleApplyRecord` espurio — el perdedor trataba IDs candidatos como adquiridos, creaba un registro vacío y repuntaba `ruleApplyRecordId` |
| **Evidencia roja** | Tests deterministas reprodujeron el defecto en ambos caminos (engine y single-rule): registros espurios y `ruleApplyRecordId` apuntando al perdedor |
| **Correctivo** | Adquisición atómica vía `updateManyAndReturn`; el registro durable y el link se crean SOLO con filas realmente adquiridas; el perdedor sin adquisiciones no persiste nada |
| **Validación y publicación** | Tests concurrentes pasados al cierre; typecheck y validate OK; correctivo publicado en `origin/main` (`e1ffff7`) |

## Outcome

- BRE-013 implementado, corregido por concurrencia y publicado en `origin/main` al cierre.
- Tests concurrentes deterministas pasados en el cierre; suite BRE-013 validada.
- ESLint sin errores en los archivos productivos de BRE-013 revisados; quedan errores de lint
  preexistentes fuera del alcance.
- Los fallos de `apply-all-enforcement-contract` quedan fuera del alcance de BRE-013, como
  incidente separado contra `S7-11A`.

## What remains for the future

- Resolver el contrato de los tests de enforcement contra `S7-11A-apply-all-enforcement-contract`
  (requisito de la línea base verde previa a CI).
- Definir navegación relacional desde un registro revertido a sus transacciones originales SI surge
  una demanda forense.
- Evaluar escalabilidad de lote si aparece un caso de volumen.
