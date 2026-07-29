# Operation Controller — Design v3.1

**Status**: REPLACED — histórico
**Replaced by**: `openspec/operation-controller/`
**Replacement date**: 2026-07-29
**Reason**: v3.1 contenía decisiones arquitectónicas (Planner, Plan Guard, retry/rollback, stateHash chain) que fueron deliberadamente descartadas en el diseño openspec. Contiene conocimiento valioso como referencia histórica pero no representa decisiones vigentes.

---

## 1. Core Architecture

### 1.1 Design principle

El Operation Controller orquesta todo cambio de estado en el sistema. No ejecuta operaciones directamente — delega a Drivers. Su núcleo es una máquina de estados que conoce solo **Operation** + **Resource**. Todo lo demás (Git, PostgreSQL, Prisma, APIs externas) vive fuera del kernel, en los Drivers.

### 1.2 Kernel components (6)

```
┌─────────────────────────────────────────────────────────┐
│                   OPERATION CONTROLLER                    │
│                                                           │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐          │
│  │  Request  │──▶│ Planner  │──▶│ Plan Guard   │          │
│  │  /Intent  │   │          │   │  (validation) │          │
│  └──────────┘   └──────────┘   └──────┬───────┘          │
│                                        │                   │
│                                        ▼                   │
│                               ┌────────────────┐          │
│                               │ Policy Engine  │          │
│                               │ (authorization) │          │
│                               └───────┬────────┘          │
│                                       │                    │
│                                       ▼                    │
│                               ┌────────────────┐          │
│                               │   Executor     │          │
│                               │ (orchestrates   │          │
│                               │  Drivers)      │          │
│                               └───────┬────────┘          │
│                                       │                    │
│                                       ▼                    │
│                               ┌────────────────┐          │
│                               │   Verifier     │          │
│                               │ (triple check) │          │
│                               └───────┬────────┘          │
│                                       │                    │
│                          ┌────────────▼───────────┐       │
│                          │       Evidence          │       │
│                          │ (log + state machine)   │       │
│                          └────────────────────────┘       │
│                                                           │
│  ┌──────────────────┐    ┌──────────────────┐             │
│  │ Resource Registry│    │     Drivers      │             │
│  │ (outside kernel) │    │  (outside kernel)│             │
│  └──────────────────┘    └──────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

### 1.3 Component responsibilities

| Component | Responsibility | ¿Nuevo en v3.1? |
|---|---|---|
| **Request/Intent** | Recibe el pedido externo. Tipifica la operación deseada. Produce un `Intent` (objetivo declarativo, no plan). | No |
| **Planner** | Toma el `Intent` y produce un `Execution Plan` con operaciones, recursos afectados y budget estimado. | No |
| **Plan Guard** | Rol lógico (no módulo separado en MVP). Validación del Plan contra el Intent (no excede), Budget válido (no inflado, consistente), operaciones permitidas. Plan rechazado → escala a humano. | **Sí** |
| **Policy Engine** | Autoriza el Plan contra políticas del sistema. Resuelve si la operación puede ejecutarse. Política + autorización en un solo componente. | No |
| **Executor** | Toma el Plan autorizado y lo ejecuta orquestando Drivers en secuencia. Maneja errores parciales, rollback si aplica. | No |
| **Verifier** | Triple verificación post-ejecución (estructural, funcional, de políticas). Un solo Verifier con tres etapas internas. | No |
| **Evidence** | Sistema de registro. NO solo eventos: registra **transiciones de estado** de la máquina de estados de la operación. Operation Log es parte de Evidence. | **Sí** (state machine) |
| **Resource Registry** | Catálogo de recursos disponibles con tipo, driver, capabilities, limits. Vive fuera del kernel. | **Sí** (contract definido) |
| **Drivers** | Implementan las operaciones concretas (Git, FileSystem, DB, Network, etc.). Nunca se comunican entre sí. | **Sí** (regla de no-dialogue) |

---

## 2. Detailed Component Design

### 2.1 Request / Intent

```
Actor ──(HTTP, CLI, event)──▶ Request ──validar/tipificar──▶ Intent
```

El `Intent` es un objeto inmutable:

```typescript
interface Intent {
  operation: string;        // "import", "apply-all", "reconcile", etc.
  target: ResourceRef;      // qué recurso(s) se afectan
  goal: string;             // estado esperado post-operación (declarativo)
  constraints?: Constraint[]; // restricciones del actor
  metadata: {
    actor: string;
    timestamp: DateTime;
    correlationId: string;
  };
}
```

El Controller **no interpreta** el Intent. Lo pasa al Planner.

### 2.2 Planner — produce el Plan

```
Intent ──▶ Planner ──▶ Execution Plan
```

El Planner consulta Resource Registry para saber qué Drivers existen y qué capabilities ofrecen. Produce un Plan que contiene:

```typescript
interface ExecutionPlan {
  id: string;
  intent: Intent;           // copia del original (para trazabilidad)
  operations: Operation[];  // lo que hay que hacer
  budget: Budget;           // recursos estimados
  resources: ResourceRef[];
  stateMachine: {
    expectedStates: StateTransition[]; // secuencia esperada
  };
}
```

Cada `Operation`:

```typescript
interface Operation {
  resource: ResourceRef;
  action: string;           // "read", "write", "delete", "exec"
  params: Record<string, unknown>;
  dependsOn?: string[];     // operaciones previas requeridas
  expectedOutcome: string;  // estado esperado post-operación (declarativo)
}
```

#### Sobre operaciones declarativas

El `Execution Plan` debería expresar **el objetivo y el estado esperado**, no la secuencia imperativa de comandos. El Driver decide **cómo** lograr ese estado — el Controller solo dice **qué** estado se necesita.

Ejemplo conceptual:
```
// Imperativo (lo que NO queremos en diseño final)
Plan: "git checkout main && git pull origin main && git merge feature-branch"

// Declarativo (lo que SÍ buscamos para el diseño)
Plan: { resource: "repo/backend", desiredState: "main merged with feature-branch" }
```

Para el MVP, el Plan puede contener operaciones atómicas (el Planner traduce el objetivo a pasos concretos). Pero el diseño conceptual apunta a un Plan declarativo donde el Driver posee la inteligencia de ejecución.

### 2.3 Plan Guard — valida el Plan (OBLIGATORIO, nuevo rol lógico)

```
Planner ──▶ Plan Guard ──▶ Policy Engine
```

El **Plan Guard** es un rol de validación, no un módulo físico independiente para el MVP. Se implementa como responsabilidad dentro del kernel (puede vivir en el mismo módulo que Planner o ser una función separada según el principio de cohesión).

**Responsabilidades:**

| Validación | Descripción | Si falla |
|---|---|---|
| **Scope** | El Plan NO excede el Intent. No opera recursos fuera del target del Intent. No ejecuta acciones no solicitadas. | Plan rechazado → escala a humano |
| **Budget** | Verifica que el Budget sea válido: estimaciones no infladas, consistencia entre operaciones y budget total, budget dentro de límites del Recurso. | Plan rechazado → escala a humano |
| **Permisos** | Verifica que todas las operaciones sean legalmente posibles (que exista un Driver capaz, que el recurso soporte la acción). | Plan rechazado → escala a humano |

**NO** hace:
- Autorización política (eso es del Policy Engine)
- Modificar el Plan (es read-only)
- Crear nada

```
Input:  ExecutionPlan + Intent original
Output: ✅ Plan válido → pasa a Policy Engine
        ❌ Plan inválido → escala a humano (rechazo directo, sin autorización)
```

La escala a humano incluye: `planId`, `reason` (qué falló), `details` (valores esperados vs reales).

### 2.4 Policy Engine — autoriza

```
Plan Guard ──▶ Policy Engine ──▶ Plan autorizado (o rechazado)
```

Resuelve políticas del sistema contra el Plan. No solo permisos CRUD — también políticas de negocio, compliance, reglas de la empresa.

Fusiona en un solo componente:
- **Authorization Gateway** (quién puede hacer qué)
- **Policy Evaluation** (reglas de negocio)

### 2.5 Executor — orquesta Drivers

```
Policy Engine ──▶ Executor ──▶ Driver A ──▶ Driver B ──▶ ...
                                  │              │
                                  ▼              ▼
                               Result A       Result B
```

El Executor toma el Plan autorizado y lo ejecuta orquestando Drivers en el orden definido por `Operation.dependsOn`. Maneja:
- Ejecución secuencial y paralela según dependencias
- Rollback parcial si una operación falla (si el Driver lo soporta)
- Timeouts, retry configurable
- Captura de cada resultado parcial para Evidence

### 2.6 Drivers — ejecutan (regla de no-diálogo directo)

Cada Driver implementa una interface común:

```typescript
interface Driver {
  resourceType: ResourceType;
  capabilities: string[];     // qué acciones soporta

  execute(operation: Operation): Promise<OperationResult>;
  verify(resource: ResourceRef): Promise<VerificationResult>;
  getLimits(): Budget;
}
```

**Regla fundamental: Drivers nunca hablan entre sí.**

```
✅ Kernel → Driver → Kernel → otro Driver
❌ GitDriver → FileDriver
❌ DatabaseDriver → NetworkDriver
```

Todo diálogo entre Drivers pasa por el Kernel (Executor). Si una operación produce output que necesita otra operación, el Executor recibe el resultado y se lo pasa como parámetro a la siguiente operación. Los Drivers son **independientes, sin conocimiento mutuo**.

Cada Driver vive fuera del kernel. El MVP necesita al menos:
- `GitDriver` — operaciones git (clone, pull, push, merge, commit)
- `FileDriver` — operaciones de sistema de archivos (read, write, copy, delete)
- `DatabaseDriver` — migraciones, seeds, queries
- `NetworkDriver` — HTTP calls, API interactions

### 2.7 Verifier — triple verificación

```
Executor ──▶ Verifier ──▶ Resultado verificado (o rechazado)

Verifier stages (internos):
  1. StructuralCheck  ── el resultado existe, tiene la forma esperada
  2. FunctionalCheck  ── el resultado hace lo que debería (datos correctos)
  3. PolicyCheck      ── el resultado no viola políticas post-ejecución
```

Si alguna etapa falla, el Verifier rechaza el resultado y escala a humano. Las tres etapas viven dentro de un solo componente Verifier — no hay módulos separados.

### 2.8 Evidence — registra transiciones de estado (OBLIGATORIO v3.1)

**Evidence NO es solo un log de eventos.** Es el registro fiel de la **máquina de estados** de cada operación. Cada operación atraviesa estados predecibles y Evidence captura cada transición.

#### Máquina de estados de la operación

```
Requested → Planned → Authorized → Executing → Executed → Verified → Completed
                           ↓                        ↓
                        Rejected                  Failed
```

| Estado | Significado | Produce |
|---|---|---|
| `Requested` | El Controller recibió el Intent | `Intent` original |
| `Planned` | Planner generó el Plan | `ExecutionPlan` |
| `Authorized` | Plan Guard + Policy Engine aprobaron | Decisión de autorización |
| `Rejected` | Plan Guard o Policy Engine rechazaron | Motivo de rechazo |
| `Executing` | Executor comenzó la ejecución | Resource locks |
| `Executed` | Executor completó todas las operaciones | Resultados parciales |
| `Failed` | Una operación falló irrecuperable | Error + rollback |
| `Verified` | Verifier confirmó el resultado | Triple verificación |
| `Completed` | Operación terminada exitosamente | Estado final |

#### Cada transición registra

```typescript
interface StateTransition {
  operationId: string;
  from: State;              // estado anterior
  to: State;                // estado nuevo
  timestamp: DateTime;
  payload: Record<string, unknown>;  // datos relevantes de la transición
  stateHash: string;        // hash(SHA256) del estado completo post-transición
}
```

El `stateHash` permite auditar que la secuencia no fue manipulada — cada transición encadena hashes del estado previo.

**Todo lo que pasa en el Controller pasa por Evidence.** El Operation Log (historial de operaciones) es una vista derivada de Evidence, no un componente separado.

#### Canales de salida

Evidence escribe a:
1. **AuditLog** en la base de datos (persistente, con hash chain)
2. **Stdout estructurado** (JSON lines, para dashboards en tiempo real)
3. **Callback opcional** (webhook si el Intent lo requiere)

---

## 3. Resource Registry Contract

```
Resource Registry (fuera del kernel, catálogo de recursos disponibles)
```

Cada `Resource` en el Registry contiene:

```typescript
interface Resource {
  id: string;
  type: ResourceType;         // "file" | "git" | "db" | "network" | "process" | "secrets" | "config"
  driver: string;             // ID del Driver asociado
  capabilities: string[];     // acciones aplicables a este recurso
  limits: Budget;             // budget máximos por defecto para este tipo de recurso
}

type ResourceType =
  | "file"
  | "git"
  | "db"
  | "network"
  | "process"
  | "secrets"
  | "config";

interface Budget {
  estimatedBytes?: number;
  maxExecTimeMs?: number;
  maxOperations?: number;
  maxNetworkCalls?: number;
  maxDiskWrites?: number;
}
```

Nada más complejo que eso para el MVP. El Registry es un catálogo plano — el Planner lo consulta para saber qué Drivers existen, qué recursos manejan, y qué budget aplicar por defecto.

---

## 4. Complete Flow

```
Actor                         Kernel                           Drivers
  │                              │                                │
  │────── 1. Request ──────────▶│                                │
  │                              │                                │
  │                              ├─── Request → Intent           │
  │                              │                                │
  │                              ├─── Planner produce Plan        │
  │                              │      └── consulta Resource     │
  │                              │          Registry ──────────▶  │
  │                              │                                │
  │                              ├─── Plan Guard valida           │
  │                              │      ✓ Scope                   │
  │                              │      ✓ Budget                  │
  │                              │      ✓ Permisos               │
  │                              │      ❌ Rechaza → escala       │
  │                              │         a humano               │
  │                              │                                │
  │                              ├─── Policy Engine autoriza      │
  │                              │      ✓ Autorizado             │
  │                              │      ❌ Rechazo                │
  │                              │                                │
  │                              ├─── Evidence: Requested→Planned │
  │                              │    →Authorized o Rejected      │
  │                              │                                │
  │                              ├─── Executor ejecuta Plan      │
  │                              │      │                         │
  │                              │      ├──── op1 ─────────────▶│
  │                              │      │◀──── result 1 ────────│
  │                              │      │                         │
  │                              │      ├──── op2(usa result1)─▶│
  │                              │      │◀──── result 2 ────────│
  │                              │      │    (Kernel siempre     │
  │                              │      │     media, Drivers     │
  │                              │      │     no hablan entre sí)│
  │                              │      │                         │
  │                              │      ❌ Falla → Evidence:     │
  │                              │         Executing→Failed      │
  │                              │      ✓ Termina → Evidence:    │
  │                              │         Executing→Executed    │
  │                              │                                │
  │                              ├─── Verifier verifica          │
  │                              │      1. StructuralCheck       │
  │                              │      2. FunctionalCheck       │
  │                              │      3. PolicyCheck           │
  │                              │      ❌ Rechaza → escala     │
  │                              │      │    a humano            │
  │                              │      ✓ → Evidence:            │
  │                              │         Executed→Verified     │
  │                              │                                │
  │                              ├─── Evidence: Verified→Completed│
  │                              │                                │
  │◀──── Resultado final ──────│                                │
```

---

## 5. Modificación Flow

Cuando un cambio en el sistema (schema migration, deploy, config change) necesita ejecutarse:

```
1. Developer envía Intent (Request)
2. Controller tipifica el Intent
3. Planner consulta Resource Registry
4. Planner produce Execution Plan con budget estimado
5. Plan Guard valida: scope, budget, permisos
6. Policy Engine autoriza contra políticas del sistema
7. Executor ejecuta cada Operation del Plan a través del Driver correspondiente
   (Kernel siempre media entre Drivers)
8. Cada sub-operación notifica resultado a Evidence (state transition)
9. Si falla → Verifier documenta el fallo, Executor intenta rollback,
   Evidence registra transición a Failed, escala a humano
10. Si éxito → Verifier corre triple verificación
11. Evidence registra transición a Verified → Completed
12. Resultado final devuelto al actor
```

**Tolerancia a fallos:**
- Operación individual falla con retry → Executor reintenta (según política)
- Operación falla sin retry → Executor decide: rollback parcial (si Driver lo soporta) o aborto total
- Rollback imposible → Se registra en Evidence como Failed + escala a humano
- Un error nunca deja el sistema en estado indeterminado (el Driver debe ser atómico o reportar fallo limpio)

---

## 6. Execution states (internal state machine)

```
                    ┌──────────────────┐
                    │    Requested      │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │     Planned       │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   Authorized      │◀── Plan Guard + Policy Engine
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼─────────┐   │   ┌──────────▼────────┐
     │    Rejected       │   │   │    Executing       │
     └──────────────────┘   │   └──────────┬─────────┘
                            │              │
                            │     ┌────────▼─────────┐
                            │     │                   │
                            │  ┌──▼──────┐   ┌───────▼───┐
                            │  │ Executed│   │  Failed   │
                            │  └──┬──────┘   └───────┬───┘
                            │     │                   │
                            │  ┌──▼──────┐           │
                            │  │Verified │           │
                            │  └──┬──────┘           │
                            │     │                   │
                            │  ┌──▼──────┐           │
                            │  │Completed│           │
                            │  └─────────┘           │
                            │                        │
                            └────────────────────────┘
```

Cada transición entre estados es registrada por Evidence con: `from`, `to`, `timestamp`, `payload`, `stateHash`.

---

## 7. Design decisions (v3 → v3.1)

| Decisión | v3 | v3.1 |
|---|---|---|
| **Plan Guard** | No existía | Rol lógico entre Planner y Policy Engine. Sin módulo separado en MVP. |
| **Resource Registry contract** | Indefinido ("consulta Resource Registry") | `{ type, driver, capabilities, limits }` |
| **Drivers cross-talk** | Regla implícita | Regla explícita: solo Kernel → Driver → Kernel |
| **Evidence** | Solo eventos | Máquina de estados: 9 estados, transiciones registradas con hash |
| **Authorization** | Policy Engine (fusión con Auth Gateway) | Sin cambio |
| **Budget** | Dentro del Execution Plan | Sin cambio, Plan Guard lo valida |
| **Verifier** | Un solo componente (triple stage) | Sin cambio |

---

## 8. Non-goals (MVP)

- No se crea un módulo `PlanGuardModule` separado — es responsabilidad dentro del kernel
- No se implementa la máquina de estados como un state machine formal (event sourcing, etc.) — Evidence registra las transiciones como datos estructurados
- El Resource Registry no requiere API REST — puede ser un archivo de configuración o consulta en memoria
- Los Drivers no tienen descubrimiento dinámico — el Registry conoce los Drivers disponibles