# Operation Controller — Design v4

**Status**: REPLACED — exploración descartada
**Replaced by**: `openspec/operation-controller/`
**Replacement date**: 2026-07-29
**Reason**: Versión simplificada que eliminó el Execution Contract y el estado PendingApproval. El diseño openspec retuvo ambos como decisiones arquitectónicas deliberadas. No representa decisiones vigentes.

---

## Regla fundamental

> La IA NO puede romper el sistema.

Cada decisión arquitectónica se mide contra esta regla. Si no reduce ese riesgo, no pertenece al kernel.

---

## 1. Diagrama del kernel

```
 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
   E V I D E N C E   (transversal, append-only)
 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
    ↑            ↑             ↑             ↑
    │            │             │             │
┌────────┐  ┌────────┐   ┌──────────┐  ┌────────┐
│ Intent │→ │ Policy │→  │ Execute  │→ │ Verify │
└────────┘  └────────┘   └──────────┘  └────────┘
    │            │             │             │
    ↓            ↓             ↓             ↓
 Requested   Authorized    Executing     Executed
               (o Denied)              → Verified
                                        → Completed
                                        → Failed
```

### Máquina de estados de la operación

```
                ┌──────────────────────────────────┐
                │         EVIDENCE                  │
                │  (cada transición se registra)    │
                └──────────────────────────────────┘

  ┌───────────┐
  │ Requested │ ─── Intent recibido
  └─────┬─────┘
        │
  ┌─────▼──────┐
  │  Denied    │ ◄── Policy: capability negada (terminal)
  └────────────┘
        │
  ┌─────▼──────┐
  │ Authorized │ ─── Policy: granted / requires-approval
  └─────┬──────┘
        │
  ┌─────▼──────┐
  │ Executing  │ ─── Driver en marcha
  └─────┬──────┘
        │
  ┌─────▼──────┐
  │  Executed  │ ─── Driver completó
  └─────┬──────┘
        │
  ┌─────▼──────┐
  │  Verified  │ ─── Verify pasó las 3 comprobaciones
  └─────┬──────┘
        │
  ┌─────▼───────┐
  │  Completed  │ ─── Terminal éxito
  └─────────────┘

  Cualquier estado → Failed (terminal, error irrecuperable)
```

---

## 2. Responsabilidad y prohibiciones de cada componente

### Intent

**Responsabilidad**: Capturar la declaración explícita de estado deseado del sistema hecha por un requester. Es el único punto de entrada al kernel. Contiene: target del recurso, estado deseado, identidad del requester y tipo de operación (leer, modificar, crear, eliminar).

**Prohibiciones**:
- NO contiene comandos (nada de "git push", "UPDATE", "rm -rf")
- NO prescribe cómo lograr el estado deseado
- NO contiene tecnología concreta
- NO contiene rutas de archivo del sistema real (usa identificadores abstractos de recurso)
- NO puede ser generado por otro componente del kernel (solo entra desde afuera)

### Policy

**Responsabilidad**: Determinar si el requester tiene permiso para realizar la operación declarada sobre el recurso target. Resuelve un modo: granted, requires-approval, requires-dual, denied.

**Prohibiciones**:
- NO maneja roles, perfiles, ni grupos
- NO tiene bypass de admin, superusuario, ni override
- NO implementa UI de aprobación
- NO modifica el Intent
- NO define qué capabilities existen (eso es externo al kernel)
- NO almacena estado de sesión

### Execute

**Responsabilidad**: Tomar el Intent autorizado y traducirlo a acciones sobre el sistema real mediante un Driver. El Driver es externo al kernel y conoce el recurso concreto.

**Prohibiciones**:
- NO maneja errores del Driver (el error se registra y la operación pasa a Failed)
- NO reintenta
- NO hace rollback
- NO negocia con el usuario
- NO interpreta el Intent (lo delega al Driver)
- NO decide si el Intent es realizable (el Driver reporta imposibilidad como error)

### Verify

**Responsabilidad**: Ejecutar la verificación triple post-ejecución:
1. Intent original contra lo que el Driver reportó haber hecho
2. Reporte del Driver contra el estado real del recurso
3. Revisión de efectos secundarios no declarados en el Intent

**Prohibiciones**:
- NO modifica el sistema
- NO compensa diferencias encontradas
- NO reintenta la verificación
- NO decide por mayoría ni aplica umbrales de tolerancia
- NO tiene modo "approve anyway"
- NO corrige el resultado del Driver

### Evidence

**Responsabilidad**: Registrar cada transición de estado de la operación en un registro inmutable, append-only, ordenado y trazable. Es transversal a los otros 4 componentes: cada etapa escribe en Evidence antes de pasar el control a la siguiente.

**Prohibiciones**:
- NO permite borrado
- NO permite modificación
- NO permite reordenamiento
- NO es un paso secuencial del pipeline (no va después de Verify)
- NO define mecanismo de almacenamiento
- NO puede estar deshabilitado (es obligatorio)

---

## 3. Flujo conceptual de lectura

```
Humano: "Quiero saber el contenido del archivo X"
  │
  ▼
Intent: {
  operation:    "read",
  target:       "archivo X",
  desiredState: "conocer el contenido actual",
  requester:    "humano R"
}
  │
  ▼
Policy:
  ¿R tiene capability "read" sobre "archivo X"?
  │
  ├── denied ───────────────► Evidence registra: Requested → Denied
  │                            Operación termina. Humano notificado.
  │
  └── granted ──────────────► Evidence registra: Authorized
  │
  ▼
Execute:
  Driver recibe Intent.
  Driver lee el estado actual del recurso.
  Driver devuelve: { resourceState: "contenido Z", sideEffects: [] }
  │
  ▼
Evidence registra: Executed
  │
  ▼
Verify:
  1. Intent.operation == "read"  ✅  (Driver hizo una lectura)
  2. Driver respetó el recurso   ✅  (se leyó el archivo X, no otro)
  3. No hubo efectos secundarios ✅  (el recurso no fue modificado)
  │
  ├── pasa ──────► Evidence registra: Verified → Completed
  │                 Resultado devuelto al humano
  │
  └── falla ────► Evidence registra: Failed
                    Operación escalada a humano
```

---

## 4. Flujo conceptual de modificación

```
Humano: "Quiero que el archivo X tenga el contenido Y"
  │
  ▼
Intent: {
  operation:    "modify",
  target:       "archivo X",
  desiredState: "contenido Y",
  requester:    "humano R",
  budget:       { maxFiles: 1, maxChanges: 1 }          ← metadata
}
  │
  ▼
Policy:
  ¿R tiene capability "modify" sobre "archivo X"?
  │
  ├── denied ───────────────► Evidence: Requested → Denied
  │
  ├── requires-approval ───► Evidence: Requested → Authorized (pending)
  │                            Operación en espera de aprobación externa.
  │                            Cuando se aprueba: continúa a Execute.
  │
  └── granted ──────────────► Evidence: Authorized
  │
  ▼
Execute:
  Driver recibe Intent.
  Driver determina estado actual del recurso.
  Driver computa el delta para llegar a desiredState.
  Driver ejecuta los cambios necesarios.
  Driver devuelve: { finalState: "contenido Y", actions: [...], sideEffects: [] }
  │
  ▼
Evidence registra: Executed
  │
  ▼
Verify:
  1. Intent.desiredState == Driver.finalState ?         ← "contenido Y" == "contenido Y"
  2. Driver.finalState == estado real del recurso ?     ← verificación directa
  3. No hay efectos secundarios no declarados ?          ← el recurso solo tiene contenido Y
  │
  ├── pasa ──────► Evidence registra: Verified → Completed
  │
  └── falla ────► Evidence registra: Failed
                    Operación escalada a humano con evidencia
                    de la discrepancia encontrada
```

---

## 5. Manejo de errores

### Principio: sin retry, sin rollback automático

El kernel no intenta recuperarse de ningún error. Cuando algo falla, la operación pasa a estado Failed y se escala al humano con toda la evidencia disponible. El humano decide el curso de acción.

### Errores por componente

**Intent**
| Condición | Resultado |
|-|-|
| Declaración incompleta (falta target, desiredState o requester) | Rechazado antes de entrar al pipeline. No se registra en Evidence. |
| Declaración ambigua o contradictoria | Rechazado antes de entrar al pipeline. No se registra en Evidence. |
| Target no reconocido por el sistema | Rechazado. No se registra en Evidence. |

Nota: Intent se rechaza antes de Evidence porque aún no hay operación válida que registrar. Esto evita ruido en el registro.

**Policy**
| Condición | Resultado | Evidence |
|-|-|-|
| Requester no existe | Denied | Requested → Denied |
| Capability no existe o no asignada | Denied | Requested → Denied |
| Capability revocada durante la operación | No aplica: se evalúa en el momento. Si cambió, la operación actual no se invalida. | — |
| requires-approval sin aprobación | Queda en Authorized (pending) hasta resolución externa | Authorized |

**Execute**
| Condición | Resultado | Evidence |
|-|-|-|
| Driver no disponible | Failed | Executing → Failed |
| Driver reporta imposibilidad | Failed | Executing → Failed |
| Driver se cuelga o timeout | Failed (se corta) | Executing → Failed |
| Driver ejecuta parcialmente | Failed | Executing → Failed |

El kernel no distingue tipos de falla de Execute. Todos son Failed. La evidencia del Driver se conserva para el humano.

**Verify**
| Condición | Resultado | Evidence |
|-|-|-|
| Check 1 falla: Intent ≠ Driver report | Failed | Executed → Failed |
| Check 2 falla: Driver report ≠ estado real | Failed | Executed → Failed |
| Check 3 falla: efectos secundarios detectados | Failed | Executed → Failed |
| Recurso no accesible para verificación directa | Failed | Executed → Failed |

### Reglas de estado terminal

- **Completed**: el estado del sistema coincide con el Intent. Operación exitosa.
- **Failed**: cualquier desviación del Intent o imposibilidad de ejecutar. No hay recuperación.
- **Denied**: Policy rechazó la operación.
- Una operación en Failed o Denied no puede transicionar a otro estado. El humano debe emitir un nuevo Intent si quiere reintentar o corregir.

---

## 6. Amenazas y controles

Solo las amenazas que el kernel resuelve directamente. No incluye amenazas externas (red, host, físico) ni organizacionales.

| # | Amenaza | Cómo la resuelve el kernel |
|---|-|-|
| 1 | **Intent falsificado** (suplantan al requester) | Evidence registra la identidad del requester contra el Intent original. Policy evalúa capabilities contra esa identidad. |
| 2 | **Intento de operación no autorizada** | Policy evalúa capabilities planas. Cada operación requiere capability explícita sobre el recurso. No hay herencia, no hay admin. |
| 3 | **Driver ejecuta algo distinto al Intent** | Verify check 1: compara Intent.desiredState contra Driver.finalState. Si difieren → Failed. |
| 4 | **Driver miente en su reporte** | Verify check 2: lee el estado real del recurso y lo compara contra el reporte del Driver. Si difieren → Failed. |
| 5 | **Efectos secundarios no declarados** | Verify check 3: verifica que ningún recurso fuera del target fue modificado. Si hay cambios no declarados → Failed. |
| 6 | **Evidence manipulado retroactivamente** | El registro es append-only. No hay operación de borrado, modificación, ni reordenamiento. Cualquier intento de manipulación es detectable por inspección del registro. |
| 7 | **Ejecución fuera del pipeline** (bypass) | El kernel es la única puerta de entrada para operaciones sobre el sistema. No hay punto de entrada alternativo sin pasar por Intent → Policy → Execute → Verify. |
| 8 | **Operación inaccesible mediante verificación directa** | Verify check 2 ejecuta la verificación sobre el recurso real, no confía en el reporte del Driver. Si el recurso no responde a la verificación → Failed. |
| 9 | **Indistinción de operaciones** (no saber qué pasó) | Evidence registra cada transición de estado con identidad del requester, Intent original, resultado de cada etapa, y timestamp. Trazabilidad completa. |
| 10 | **Sobrecarga del sistema por errores en cadena** | No hay retry ni rollback automático. Cada operación fallida termina en Failed sin disparar nuevas operaciones. No hay cascada automática. |

---

## Nota final

Este documento define el kernel del Operation Controller v4. Los siguientes dominios se diseñan por separado y NO son parte de este documento:

- Resource Registry
- Mecanismo de almacenamiento de Evidence
- Drivers concretos
- Sistema de capabilities externo
- UI de aprobación para requires-approval / requires-dual
- API de entrada al kernel
- Mecanismo de notificación al humano

Cada uno de estos dominios debe respetar el kernel definido aquí, no modificarlo.