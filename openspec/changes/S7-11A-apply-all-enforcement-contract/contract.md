# S7-11A Contract: Apply All Enforcement

> **La política decide. El consumidor reacciona. La acción nunca cambia.**

## 1. Principio

El enforcement es una capa alrededor del proceso de Apply All, no mezclada con él. El matching produce la información; la política decide; el consumidor reacciona. Siempre se re-evalúa con datos frescos.

## 2. Arquitectura

```
POST /api/bank-rules/apply-all
         │
         ├── 1. matchTransactions() — resultado del matching (lectura pura)
         │
         ├── 2. evaluateOperationalPolicy() — política decide
         │
         ├── 3. decisión
         │     ├── ALLOW  → executeApplyAll() → EXECUTED
         │     ├── WARN   → executeApplyAll() → EXECUTED + warning
         │     ├── CONFIRM→ CONFIRMATION_REQUIRED (no ejecuta)
         │     └── BLOCK  → no ejecuta (futuro)
         │
         └── 4. response
```

## 3. Endpoint Único

Un solo `POST /api/bank-rules/apply-all`. No se crean nuevos endpoints.

| Llamada | body | Comportamiento |
|---|---|---|
| 1ª (evaluación) | `{ companyId }` | Matching → evaluación. Si CONFIRM → devuelve `CONFIRMATION_REQUIRED` sin ejecutar. |
| 2ª (confirmación) | `{ companyId, confirmed: true }` | Matching fresco → re-evaluación → ejecutar (o bloquear). |

La segunda llamada siempre hace matching desde cero con datos actuales. La re-evaluación es la autoridad final.

## 4. Response Contract

### 4.1 EXECUTED

```typescript
{
  status: 'EXECUTED';
  data: {
    success: boolean;
    matched: number;
    total: number;
    remaining: number;
    rulesApplied: Array<{ ruleId: string; ruleName: string; count: number }>;
  };
  warning?: {                       // solo cuando action era WARN
    reasonCode: string;
    transactionCount: number;
    profileId: string;
    profileVersion: string;
  };
}
```

### 4.2 CONFIRMATION_REQUIRED

```typescript
{
  status: 'CONFIRMATION_REQUIRED';
  decision: {
    reasonCode: string;
    summary: string;
    profileId: string;
    profileVersion: string;
    readinessStatus: 'NOT_READY' | 'INSUFFICIENT_DATA';
  };
  context: {
    transactionCount: number;
    matchedRuleCount: number;
  };
}
```

El frontend no ejecuta ante esta respuesta. Muestra el modal.

### 4.3 POLICY_UNAVAILABLE

```typescript
{
  status: 'POLICY_UNAVAILABLE';
  errorCode: string;
}
```

La política no pudo evaluarse (error de infraestructura). Se permite continuar — ALLOW conservativo.

### 4.4 BLOCKED (futuro)

```typescript
{
  status: 'BLOCKED';
  reasonCode: string;
  summary: string;
  profileId: string;
  profileVersion: string;
}
```

No implementado en v1.

## 5. Flujo Completo

```
USUARIO                  FRONTEND                       BACKEND
  │                         │                              │
  │ clic "Apply All"        │                              │
  │ ───────────────────────►│                              │
  │                         │ POST { companyId }           │
  │                         │ ────────────────────────────►│
  │                         │                              │
  │                         │   matchTransactions()        │
  │                         │   evaluatePolicy()           │
  │                         │   → CONFIRM                  │
  │                         │                              │
  │                         │◄── CONFIRMATION_REQUIRED ───│
  │                         │    { decision, context }     │
  │                         │                              │
  │ ╔══════════════════╗    │                              │
  │ ║ MODAL            ║    │                              │
  │ ║ riesgo + tx info ║    │                              │
  │ ║ [Cancel]         ║    │                              │
  │ ║ [Confirmar]      ║    │                              │
  │ ╚══════════════════╝    │                              │
  │                         │                              │
  │ CANCELAR                │                              │
  │ ───────────────────────►│  no llama al backend         │
  │                         │                              │
  │ — o —                   │                              │
  │                         │                              │
  │ CONFIRMAR               │                              │
  │ ───────────────────────►│                              │
  │                         │ POST { companyId,            │
  │                         │   confirmed: true }          │
  │                         │ ────────────────────────────►│
  │                         │                              │
  │                         │   matchTransactions()        │
  │                         │   re-evaluatePolicy()        │
  │                         │                              │
  │                         │   → ALLOW  → executeApplyAll │
  │                         │   → WARN   → executeApplyAll │
  │                         │   → CONFIRM→ executeApplyAll │
  │                         │   → BLOCK  → no ejecutar     │
  │                         │                              │
  │                         │◄── EXECUTED / BLOCKED ─────│
  │                         │    { status, data,           │
  │                         │      warning? }              │
  │                         │                              │
  │ ╔══════════════════╗    │                              │
  │ ║ RESULTADO         ║    │                              │
  │ ╚══════════════════╝    │                              │
```

En la segunda llamada no hay identidad que comparar. El matching es fresco. La re-evaluación es la autoridad. Si el conjunto de transacciones cambió entre evaluaciones, la política produce la decisión correcta para los datos actuales.

## 6. Re-evaluación

### 6.1 Principio

> **La segunda evaluación no busca volver a pedir permiso al usuario. Busca verificar que las condiciones bajo las cuales el usuario otorgó ese permiso no hayan empeorado.**

### 6.2 Semántica del segundo CONFIRM

La confirmación del usuario es un consentimiento humano que autoriza a ejecutar. Cuando la re-evaluación vuelve a dar CONFIRM, no significa "hace falta otra confirmación". Significa que las condiciones siguen siendo las mismas que el usuario ya aceptó. La confirmación previa sigue siendo válida.

| Nueva acción | Comportamiento | Razón |
|---|---|---|
| ALLOW | Ejecutar | La condición mejoró. No se necesita más autorización. |
| WARN | Ejecutar + warning | Severidad menor que CONFIRM. La confirmación previa cubre este caso. |
| CONFIRM | Ejecutar | La condición no cambió. El consentimiento humano ya fue otorgado. |
| BLOCK | **No ejecutar.** Mostrar bloqueo. | La condición empeoró. La confirmación anterior queda invalidada. |

Orden de severidad: `ALLOW < WARN < CONFIRM < BLOCK`. Si la severidad baja o se mantiene, se ejecuta. Si sube (CONFIRM a BLOCK), se detiene.

No puede entrar en ciclo infinito porque la confirmación del usuario es un evento único: una vez confirmado, el flujo avanza hacia ejecución. La re-evaluación no abre otro modal.

## 7. Doble Ejecución

| Riesgo | Protección |
|---|---|
| Doble clic en "Confirmar" | Frontend deshabilita el botón tras el primer clic |
| Dos POST idénticos | La segunda llamada ejecuta matching sobre transacciones ya aplicadas. El matching no las encuentra (ya tienen `glAccountId`). Resultado: 0 transacciones, no-op seguro. |
| Re-evaluación paralela | Mismo endpoint. La política decide con datos actuales. Sin estado compartido que corromper. |

`executeApplyAll` es idempotente sobre transacciones ya clasificadas.

## 8. Cancelación

- No se ejecuta nada
- No se modifica ningún dato
- El modal se cierra
- El usuario vuelve al estado previo
- No se llama al backend
- Se audita como `OPERATIONAL_POLICY_CONFIRM_CANCELLED` (nivel INFO)

## 9. Auditoría

| Evento | action (string libre en AuditLog) |
|---|---|
| Decisión de política | `OPERATIONAL_POLICY_DECISION` — acción, perfil, reasonCode, readinessStatus |
| Confirmación aceptada | `OPERATIONAL_POLICY_CONFIRM_ACCEPTED` — acción original, acción re-evaluada |
| Confirmación cancelada | `OPERATIONAL_POLICY_CONFIRM_CANCELLED` — nivel INFO |
| Operación ejecutada | `OPERATIONAL_POLICY_EXECUTED` — acción final, warnings |

El modelo `AuditLog` usa strings libres para `action`. Sin migración de esquema.

## 10. Archivos que se modifican

| Archivo | Cambio |
|---|---|
| `src/lib/services/apply-all-use-case.ts` | Agregar enforcement layer: matching → evaluación → decisión. Si CONFIRM → devolver sin ejecutar. En 2ª llamada: re-evaluar, ejecutar. |
| `src/app/api/bank-rules/apply-all/route.ts` | Leer `confirmed` del body. Manejar CONFIRMATION_REQUIRED vs EXECUTED. |
| `src/components/spa/BankRulesPage.tsx` | Manejar `CONFIRMATION_REQUIRED`. Mostrar modal con decisión. Enviar confirmación. |

## 11. Archivos que NO se modifican

| Archivo | Motivo |
|---|---|
| `src/lib/services/apply-all-engine.ts` | Motor puro. No se toca. |
| `src/lib/operational-policy/policy-service.ts` | `evaluateOperationalPolicy` se reusa tal cual. |
| `src/lib/operational-policy/observational-policy-profile.ts` | Reglas ya existen. |
| `prisma/schema.prisma` | AuditLog usa strings libres. Sin migración. |
| `src/lib/services/import.service.ts` | Sin cambios en v1 — matriz dice ALLOW/WARN/ALLOW, no CONFIRM. |
| Todos los archivos de Reconciliation | Sin enforcement en v1. |

## 12. Lo que NO existe y por qué

| Concepto | Por qué no existe |
|---|---|
| `operationId` | El frontend solo necesita decir "confirmed: true". El servidor calcula todo con datos frescos. No resuelve un problema real hoy. |
| `confirmationToken` | La re-evaluación siempre usa datos actuales. Un token no agrega seguridad que la política misma no provea. |
| Snapshot como concepto | El resultado del matching *es* el snapshot. Nombrarlo distinto es crear una abstracción sin casos reales que la justifiquen. |
| Almacenamiento temporal (JWT, Redis, DB, memoria) | No hace falta mantener estado entre la primera y segunda llamada. Cada llamada es autónoma. |
| Helper de identidad | Un solo consumidor (Apply All) necesita esto hoy. Si aparece un segundo, se extrae. |
| Servicio de enforcement | Apply All es el único consumidor de CONFIRM. No hay motivo para una capa compartida. |

**Regla:** no introducir una nueva abstracción hasta que existan al menos dos casos reales que la necesiten. Esto aplica a servicios, helpers, interfaces, tokens, perfiles, capas, adaptadores y estrategias.
