# S7-15 — Interactive Ambiguity Resolution

## 1. Objetivo

Permitir que el usuario resuelva manualmente transacciones marcadas como `AMBIGUOUS` por el motor de precedencia, seleccionando explícitamente una regla candidata para aplicarla.

### Problema que resuelve

Hoy, si una transacción es `AMBIGUOUS`, el motor **no aplica ninguna regla** — la transacción queda sin asiento contable y el usuario no tiene forma de destrabarla desde la UI. S7-15 da al usuario el control para cerrar ese gap sin modificar el algoritmo de matching ni las reglas existentes.

---

## 2. Alcance

### Incluye

- Detección y presentación de transacciones `AMBIGUOUS` con sus candidatos
- Selección manual de una regla candidata por parte del usuario
- Validación completa de que la regla seleccionada sigue siendo candidata válida
- Ejecución del pipeline existente de creación de asientos para esa transacción
- Registro de auditoría con `resolutionSource: USER`
- Cancelación de la operación (no se persiste nada)

### Fuera de alcance

- Crear `POST /api/bank-rules/apply-one`
- Duplicar el pipeline de Apply All
- Cambiar el algoritmo V2 de matching
- Agregar tiebreakers
- Modificar prioridades de reglas
- Aprender automáticamente de decisiones manuales
- Entrenar o sugerir nuevas reglas
- S7-16 o cualquier otro sprint

---

## 3. Flujo UX

### 3.1 Detección de `AMBIGUOUS`

El usuario ejecuta Apply All (`POST /api/bank-rules/apply-all`). El motor responde:

```json
{
  "status": "CONFIRMATION_REQUIRED",
  "rulesApplied": [
    {
      "ruleId": "r1",
      "appliedCount": 0,
      "status": "AMBIGUOUS",
      "confidenceDistribution": { "high": 0, "medium": 0, "low": 0 },
      "candidates": [
        { "ruleId": "r2", "confidenceLabel": "medium", "matchQuality": 0.65, "specificityScore": 4 },
        { "ruleId": "r3", "confidenceLabel": "low", "matchQuality": 0.55, "specificityScore": 2 }
      ]
    }
  ]
}
```

Cada entrada con `status: AMBIGUOUS` incluye `candidates[]` con metadatos completos de confianza.

### 3.2 Presentación de candidatos

> **Condición**: la UI muestra las condiciones del motor, pero nunca las evalúa ni reconstruye. Es render-only. El motor produce las explicaciones, la UI solo las presenta. Esto elimina el riesgo de tener dos implementaciones distintas de la misma lógica.

```
Rule Engine
      │
      ├── winner
      ├── candidates
      └── evaluatedConditions
               │
               ▼
          UI (render-only)
```

La UI muestra, por cada transacción ambigua, una fila con `badge` coloreado por candidato:

```
┌───────────────────────────────────────────────┐
│ Transacción #TX-042   $12,500.00  2026-07-28 │
│                                               │
│  Candidatos disponibles:                      │
│  ┌────────┬──────────┬──────────┬──────────┐ │
│  │ Regla  │ Confianza│ Match    │ Especif. │ │
│  ├────────┼──────────┼──────────┼──────────┤ │
│  │ "Obra  │ 🟡 Media │ 65%      │ 4 factor │ │
│  │ Social"│          │          │          │ │
│  │ "Fondo │ 🔴 Baja  │ 55%      │ 2 factor │ │
│  │ Común" │          │          │          │ │
│  └────────┴──────────┴──────────┴──────────┘ │
│                                               │
│  [Seleccionar] [Cancelar]                     │
└───────────────────────────────────────────────┘
```

Al expandir un candidato (clic en la fila), se muestran **las condiciones del motor que generaron el match**:

```
▼ Obra Social
  ✓ descripción contiene "APORTE"
  ✓ importe dentro del rango ($5K-$20K)
  ✓ dirección contable: CRÉDITO
  ✓ frecuencia: 3 apariciones en 60 días

  [Aplicar esta regla]
```

El motor ya evalúa cada condición individualmente durante `resolveApplyAllRule` (ver `evaluateSingleCondition` → `EvaluatedCondition` con `type`, `score`, `match`, `detail` en línea 144 de `rule-precedence-engine.ts`). Sin embargo, hoy esos resultados individuales **no se persisten** en `RankedCandidate` — solo se usa el agregado `matchQuality`.

Para exponerlos en la UI hay que:

1. Agregar `evaluatedConditions: { type: string; detail: string }[]` a `RankedCandidate`
2. Poblar el array desde `evaluated` en `evaluateTransactionAgainstRules` (línea 144, antes del `every` filter)
3. Propagar por la cadena API → response → UI

Esto es trabajo real pero bien acotado: el dato ya se computa, solo no se guarda. Se incorpora como subobjetivo explícito del sprint.

No requiere IA ni procesamiento adicional — solo exponer lo que el motor ya evaluó.

### 3.3 Selección manual

El usuario hace clic en "Seleccionar" sobre una regla candidata. La UI solicita confirmación:

> "¿Aplicar regla 'Obra Social' a la transacción #TX-042?"
> **[Aplicar]** **[Cancelar]**

### 3.4 Cancelación

Si el usuario cancela en cualquier paso:

- No se persiste ningún registro
- No se modifica ninguna transacción
- La UI vuelve al estado anterior

### 3.5 Confirmación del resultado

Si el usuario confirma, la API procesa y la UI refresca:

```
Apply All: COMPLETED
┌──────────────────────────────────────────┐
│ ✅ TX-042 → "Obra Social"    Asiento #J-89 │
│    resuelta manualmente                     │
└──────────────────────────────────────────┘
```

Si falla validación, se muestra el error específico con opción de reintentar.

---

## 4. Contrato propuesto: extensión de `executeApplyAllUseCase`

> **Restricción arquitectónica**: el comportamiento de `mode: 'single'` debe ser funcionalmente equivalente a ejecutar el pipeline batch sobre una única transacción. Cualquier cambio futuro en el pipeline (validaciones, pasos de auditoría, política operacional) debe aplicarse automáticamente a ambos modos.

No se crea un endpoint nuevo. Se extiende el caso de uso existente y su ruta API con parámetros opcionales:

### Entrada (extensión del body existente)

```ts
// POST /api/bank-rules/apply-all  (body existente + opcionales)
{
  confirmed?: boolean;       // ya existe
  mode?: 'batch' | 'single'; // nuevo, default 'batch'
  transactionId?: string;    // requerido si mode='single'
  forcedRuleId?: string;      // requerido si mode='single'
}
```

### Comportamiento por modo

| mode    | Comportamiento |
|---------|---------------|
| `batch` | Comportamiento actual (aplica a todas las transacciones no matcheadas) |
| `single`| Corre matching solo para la transacción indicada, valida forcedRuleId como candidato, la usa como selección manual, ejecuta apply para esa única transacción |

### Flujo interno para `mode: 'single'`

```
executeApplyAllUseCase(companyId, { mode: 'single', transactionId, forcedRuleId })
  │
  ├─ 1. VALIDAR: transactionId pertenece a companyId
  │      (consulta BankTransaction + JOIN Company)
  │
  ├─ 2. VALIDAR: forcedRuleId pertenece a companyId
  │      (consulta BankRule)
  │
  ├─ 3. VALIDAR: forcedRule está activa
  │      (rule.isActive === true)
  │
  ├─ 4. VALIDAR: transacción aún no tiene asiento
  │      (bankTransaction.journalEntryId === null)
  │
  ├─ 5. VALIDAR: período contable no está bloqueado
  │      (consulta AccountingPeriod para la fecha de la tx)
  │
  ├─ 6. CORRER matching para la transacción específica
  │      (repite resolveApplyAllRule para esa tx)
  │      → Obtiene candidates[]
  │
  ├─ 7. VALIDAR: forcedRuleId está en candidates[]
  │      (si no → error RULE_NOT_CANDIDATE)
  │
  ├─ 8. USAR forcedRuleId como selección manual
  │      (MatchResult con un solo ruleApplied determinado por el usuario)
  │
  ├─ 9. EVALUAR OperationalPolicy normalmente (confirmed del body)
  │      (si la política requiere CONFIRMATION_REQUIRED, se respeta)
  │
  ├─ 10. db.$transaction → executeApplyAll(companyId, tx, singleMatchResult)
  │
  └─ 11. Audit: resolutionSource: 'USER' en details
```

---

## 5. Validaciones obligatorias

| # | Validación | Código error | Comportamiento |
|---|-----------|-------------|---------------|
| 1 | La transacción existe y pertenece a la empresa | `TRANSACTION_NOT_FOUND` | Rechazar con 400 |
| 2 | La regla existe y pertenece a la empresa | `RULE_NOT_FOUND` | Rechazar con 400 |
| 3 | La regla está activa | `RULE_INACTIVE` | Rechazar con 400 |
| 4 | La regla era una candidata válida | `RULE_NOT_CANDIDATE` | Rechazar con 400 |
| 5 | La transacción no tiene asiento | `TRANSACTION_ALREADY_MATCHED` | Rechazar con 409 |
| 6 | El período contable no está bloqueado | `PERIOD_LOCKED` | Rechazar con 409 |
| 7 | La transacción no fue procesada concurrentemente | `CONCURRENT_MODIFICATION` | Rechazar con 409 (se detecta dentro de la tx) |

> **`RULE_NOT_CANDIDATE`** significa: la regla existe, pertenece a la empresa y está activa, pero no forma parte del conjunto de candidatos que el motor produjo para esa transacción. No debe interpretarse como "la regla no existe".

### Validación 4 en detalle

Es la validación más importante del contrato. El sistema:

1. Obtiene la transacción (monto, descripción, etc.)
2. Corre `resolveApplyAllRule` para esa transacción contra **todas las reglas activas** de la empresa
3. Compara el `forcedRuleId` contra los `candidates[]` del resultado
4. Si está en la lista → pasa. Si no → `RULE_NOT_CANDIDATE`

Esto garantiza que el usuario no pueda aplicar una regla irrelevante sobre una transacción — la regla debe tener algún grado de matching válido (incluso `low`).

---

## 6. Auditoría

### Campo existente

Se reutiliza `AuditLog.details` (JSON string) para evitar migration. No existe un campo `resolutionSource` ni `resolutionType` en el schema actual.

### Estructura

```ts
// En details, se agrega al JSON existente:
{
  policySchemaVersion: 1,
  // ... campos existentes de operacional policy ...
  resolutionSource: 'USER',       // nuevo — quién decidió
  engineResult: 'AMBIGUOUS',      // nuevo — qué produjo el motor
  userId: '<userId>',              // quien resolvió
  resolvedAt: '<ISO timestamp>',   // cuándo
  selectedRuleId: '<ruleId>',     // regla elegida por el usuario
  transactionId: '<txId>'         // transacción resuelta
}
```

### Entidades vinculadas

| Entity | Valor | Descripción |
|--------|-------|-------------|
| `action` | `'RULE_AMBIGUITY_RESOLUTION'` | Nuevo valor de action |
| `entity` | `'ApplyAllBatch'` | Misma entidad que usa el batch actual |
| `entityId` | `batchId` | ID del batch de Apply All |
| `companyId` | `companyId` | Compañía |
| `userId` | `userId` | Quien resolvió |

### Tradeoff documentado

Usar `details` para `resolutionSource` significa que **no se puede consultar eficientemente** "dame todas las resoluciones manuales" sin parsear el JSON. Si en el futuro se necesita ese tipo de query, se deberá migrar a una columna indexada o un modelo separado `Resolution`. Por ahora es aceptable porque:
- El volumen de datos es bajo (aplicaciones manuales esporádicas)
- No hay queries de reporting sobre este campo
- Evita una migration innecesaria

---

## 7. Manejo de errores y concurrencia

### Escenarios de error

| Escenario | Detección | Respuesta |
|-----------|----------|-----------|
| Regla eliminada entre match y confirmación | Validación #2 en cada intento | 400 con `ruleId` y mensaje |
| Regla desactivada entre match y confirmación | Validación #3 | 400 con `ruleId` y mensaje |
| Transacción matcheada por otro usuario | Validación #5 | 409 con `transactionId` |
| Período bloqueado | Validación #6 | 409 con `periodId` y fechas |
| Regla ya no es candidata (datos cambiaron) | Validación #4 | 400 con `RULE_NOT_CANDIDATE` + candidates actualizados |
| Concurrencia dentro de la transacción DB | `updateMany` chequea `journalEntryId = null` | 409, la tx ya fue procesada |

### Concurrencia

1. Las validaciones 1-6 corren **fuera** de la transacción DB (sin locks)
2. Dentro de `$transaction`, `executeApplyAll` ya hace `updateMany ... WHERE journalEntryId IS NULL` — si otra sesión ya aplicó la transacción, el update no afecta filas y el engine detecta 0 filas afectadas → error
3. Esto es suficiente porque el único recurso compartido es `BankTransaction.journalEntryId`, y la constraint `@unique` impide duplicados

No se necesita optimistic locking adicional.

---

## 8. Contratos antes/después

### API Route (`src/app/api/bank-rules/apply-all/route.ts`)

| Antes | Después |
|-------|---------|
| `POST` acepta `{ confirmed?: boolean }` | Acepta `{ confirmed?, mode?, transactionId?, forcedRuleId? }` |
| Siempre procesa en modo batch | Detecta `mode` y bifurca |
| No valida existencia de regla individual | Valida regla, transacción, período, candidatura |
| Retorna `ApplyAllRuleResponse` | Misma respuesta, pero `rulesApplied[]` contiene 1 entrada para `mode: single` |

### Use Case (`apply-all-use-case.ts`)

| Antes | Después |
|-------|---------|
| `executeApplyAllUseCase(companyId, { confirmed? })` | Misma firma, `confirmed` pasa a estar dentro de `options` |
| Sin validaciones de transacción individual | Nuevo bloque de validación para `mode: single` |
| `buildEnforcementResult` siempre batch | Soporta `transactionId` en detalles |

### Engine (`apply-all-engine.ts`)

| Antes | Después |
|-------|---------|
| `executeApplyAll` procesa todas las transacciones del `MatchResult` | Sin cambios — ya procesa lo que recibe. El filtro se hace antes de llamarlo |
| `resolveApplyAllRule` devuelve `RankedCandidate` sin condiciones detalladas | Ahora cada `RankedCandidate` incluye `evaluatedConditions[]` con `type` + `detail` que describe por qué matchó |

### Preparación del motor (`rule-precedence-engine.ts`)

El `RankedCandidate` se extiende con:
```ts
evaluatedConditions: { type: string; detail: string }[];
```
Se puebla desde `evaluated` (línea 144) antes del `every` filter — las condiciones que fallaron se excluyen, las que pasaron se conservan.

### Audit (`audit-log-repository.ts`)

| Antes | Después |
|-------|---------|
| `action`: `RULE_PRECEDENCE_SHADOW_SUMMARY`, `OPERATIONAL_POLICY_OBSERVATION` | Se agrega `RULE_AMBIGUITY_RESOLUTION` |
| `details`: solo `policySchemaVersion` + contexto | `details`: se agrega `resolutionSource: 'USER'`, `engineResult: 'AMBIGUOUS'`, `userId`, `resolvedAt`, `selectedRuleId`, `transactionId` |

---

## 9. Archivos que modificar (sin crear)

| Archivo | Cambio |
|---------|--------|
| `src/lib/services/rule-precedence-engine.ts` | Extender `RankedCandidate` con `evaluatedConditions: { type: string; detail: string }[]`, poblar desde `evaluated` |
| `src/lib/services/apply-all-use-case.ts` | Agregar bloque de validación para `mode: 'single'` (validaciones 1-7), filtrar `MatchResult` a una sola transacción, usar `forcedRuleId` como selección manual, inyectar `resolutionSource: USER` + `engineResult: AMBIGUOUS` en auditoría |
| `src/lib/services/apply-all-engine.ts` | Sin cambios estructurales. Eventualmente exponer `resolveApplyAllRule` para una tx individual si no está accesible |
| `src/lib/services/rule-precedence-adapters.ts` | Extender `ApplyAllOptions` con `mode`, `transactionId`, `forcedRuleId`. Propagar `evaluatedConditions` en respuesta |
| `src/app/api/bank-rules/apply-all/route.ts` | Extraer `mode`, `transactionId`, `forcedRuleId` del body, pasarlos al use case |
| `src/lib/db/audit-log-repository.ts` | Agregar constante `RULE_AMBIGUITY_RESOLUTION` |
| `src/lib/db/audit-log-service.ts` o donde se persista la auditoría | Agregar `resolutionSource: 'USER'` + `engineResult: 'AMBIGUOUS'` en `details` |
| `src/lib/types/apply-all.ts` o similar | Agregar tipos `ResolutionSource = 'USER' | 'ENGINE'`, extender `ApplyAllOptions` |
| `src/components/spa/BankRulesPage.tsx` | Agregar UI de selección de regla candidata (modal/dropdown) con `evaluatedConditions` render-only |
| `src/i18n/locales/es.ts` + `en.ts` | Claves i18n para la nueva UI de resolución |
| Prisma schema (`prisma/schema.prisma`) | **Sin cambios**. Se reusa `details` para `resolutionSource` |

**No se crean archivos nuevos.** No se crean endpoints nuevos.

---

## 10. Tests requeridos

### Unit tests (`apply-all-use-case.test.ts`)

| Test | Descripción |
|------|-------------|
| `mode=single with valid candidate → applies selected rule` | Happy path básico |
| `mode=single with invalid forced rule → 400 RULE_NOT_CANDIDATE` | Validación #4 |
| `mode=single with inactive rule → 400 RULE_INACTIVE` | Validación #3 |
| `mode=single with already-matched tx → 409 TRANSACTION_ALREADY_MATCHED` | Validación #5 |
| `mode=single with locked period → 409 PERIOD_LOCKED` | Validación #6 |
| `mode=single with wrong-company tx → 400 TRANSACTION_NOT_FOUND` | Validación #1 |
| `mode=single with wrong-company rule → 400 RULE_NOT_FOUND` | Validación #2 |
| `mode=batch ignores forcedRuleId` | Modo batch ignora parámetros single |
| `mode=single cancels → no audit log` | Cancelación no persiste |
| `audit details contains resolutionSource=USER + engineResult=AMBIGUOUS + userId` | Verificar contenido de auditoría |
| `mode=single concurrent race → 409 CONCURRENT_MODIFICATION` | Dentro de tx, updateMany no afecta filas |

### Integration tests

| Test | Descripción |
|------|-------------|
| `POST /api/bank-rules/apply-all with mode=single → single transaction applied` | API completa |
| `POST /api/bank-rules/apply-all with invalid params → 400` | Validación de body |
| `Mode=single with shadow enabled → shadow behavior` | Shadow se decide en implementación (ver pregunta abierta #4) |

### Invariant tests

| Test | Descripción |
|------|-------------|
| `Single application does not modify other unmatched transactions` | Aislamiento |
| `journalEntryId remains unique after single apply` | Integridad referencial |

---

## 11. Criterios de aceptación

1. [ ] Dado una transacción `AMBIGUOUS` con 2 candidatos, cuando el usuario selecciona uno y confirma, entonces la transacción se matchea y se crea un asiento
2. [ ] Dado una transacción `AMBIGUOUS`, cuando el usuario selecciona una regla que NO está en candidatos, entonces se rechaza con `RULE_NOT_CANDIDATE`
3. [ ] Dado una transacción ya matcheada, cuando se intenta resolver manualmente, entonces se rechaza con `TRANSACTION_ALREADY_MATCHED`
4. [ ] Dado un período bloqueado, cuando se intenta resolver, entonces se rechaza con `PERIOD_LOCKED`
5. [ ] Dada una regla inactiva, cuando se selecciona, entonces se rechaza con `RULE_INACTIVE`
6. [ ] Dada una resolución manual exitosa, el `AuditLog.details` contiene `resolutionSource: 'USER'`
7. [ ] Dada una cancelación, no se crea ningún asiento ni auditoría
8. [ ] Dado `mode: 'batch'`, los parámetros `transactionId` y `forcedRuleId` son ignorados
9. [ ] Dada una resolución manual exitosa, las otras transacciones no matcheadas no se modifican
10. [ ] Todas las validaciones devuelven mensajes de error en español descriptivos

---

## 12. Riesgos y preguntas abiertas

### Riesgos

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| El usuario selecciona una regla que no corresponde y el asiento resultante es incorrecto | Contable | Se requiere confirmación explícita. La UI muestra claramente qué regla se aplica y por qué era candidata |
| Concurrencia: dos usuarios resuelven la misma transacción | Inconsistencia | El `updateMany` con `journalEntryId IS NULL` lo detecta dentro de la tx |
| `details` sin schema enforcement → datos corruptos | Auditabilidad | Se mantiene la misma convención que el código existente. Si crece, migrar a columna dedicada |

### Preguntas abiertas

1. **¿Debe el modo `single` ejecutar también las validaciones de Operational Policy (S7-11)?** Sí, la política aplica independientemente de cómo se resuelva la ambigüedad. El `confirmed` se respeta igual que hoy: si la política requiere confirmación, el flujo devuelve `CONFIRMATION_REQUIRED` y el usuario debe confirmar.

2. **¿Debe la transacción resolverse individualmente o permitir selección múltiple?** Primera iteración: individual. Múltiple queda para una futura mejora.

3. **¿Qué pasa si el usuario quiere revertir una resolución manual?** Queda fuera de alcance. Una reversión es un asiento de reversión, no una "des-aplicación".

4. **¿Debe re-ejecutarse el shadow comparison para `mode: single`?** Por decidir. El shadow aporta valor en batch para medir desviaciones del motor actual contra el anterior. En una resolución manual, el usuario ya tomó una decisión explícita — el shadow quizás no agrega información accionable y solo añade costo computacional. Se decide durante implementación según el costo real de la consulta shadow.

5. **¿Vale la pena migrar `resolutionSource` a columna separada ahora?** Decisión: NO. Se usa `details`. Migrar cuando haya necesidad demostrable de queries de reporting sobre resoluciones manuales.

---

## Aprobación

Este documento requiere aprobación antes de comenzar la implementación.
