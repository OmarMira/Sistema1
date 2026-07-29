# Operation Controller — Design

## Regla fundamental

> La IA NO puede romper el sistema.

Cada decisión arquitectónica se mide contra esta regla. Si no reduce ese riesgo, no pertenece al kernel.

---

## 1. Diagrama del kernel

```
 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
   E V I D E N C E   (transversal, append-only)
 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
    ↑        ↑           ↑           ↑        ↑
    │        │           │           │        │
┌────────┐ ┌────────┐ ┌────────────────────┐ ┌──────────┐ ┌────────┐
│ Intent │→│ Policy │→│ Execution Contract │→│ Execute  │→│ Verify │
└────────┘ └────────┘ └────────────────────┘ └──────────┘ └────────┘
             ↓
          Denied
        PendingApproval
```

Evidence es transversal al pipeline completo. No modifica la operación; registra cada transición y resultado relevante, incluidos Requested, Denied, PendingApproval, Authorized, Executing, Executed, Verified, Completed y Failed.

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
  ┌─────▼───────────┐
  │  PendingApproval│ ◄── Policy: requires-approval / requires-dual
  └─────┬───────────┘
        │ (aprobación externa recibida)
  ┌─────▼───────────┐
  │  Authorized     │ ─── Execution Contract generado. Listo para Execute.
  └─────┬───────────┘
        │
  ┌─────▼──────┐
  │ Executing  │ ─── Execute en marcha
  └─────┬──────┘
        │
  ┌─────▼──────┐
  │  Executed  │ ─── Execute completó
  └─────┬──────┘
        │
  ┌─────▼──────┐
  │  Verified  │ ─── Verify pasó la comprobación
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

**Responsabilidad**: Capturar la declaración explícita de estado deseado del sistema hecha por un requester. Es el único punto de entrada al kernel. Contiene: target del recurso, estado deseado e identidad del requester.

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

### Execution Contract

**Responsabilidad**: Describe exactamente qué quedó autorizado: target del recurso, tipo de operación, operaciones permitidas, efectos permitidos, efectos prohibidos, budget y estado esperado. Es el artefacto que separa Policy de Execute. Se genera solo cuando existe la aprobación correspondiente (granted, o aprobación externa recibida para requires-approval/requires-dual).

**Prohibiciones**:
- NO puede ampliar el Intent
- NO contiene comandos ejecutables
- NO es modificable después de su generación

### Execute

**Responsabilidad**: Solicitar la ejecución del Execution Contract sobre el recurso protegido mediante un Driver externo al kernel.

**Prohibiciones**:
- NO maneja errores del Driver (el error se registra y la operación pasa a Failed)
- NO reintenta
- NO hace rollback
- NO negocia con el usuario
- NO interpreta el Contract (lo delega al Driver)

### Verify

**Responsabilidad**: Confirmar que el estado real cumple exactamente el Execution Contract autorizado y que no existen efectos fuera de su alcance.

**Prohibiciones**:
- NO modifica el sistema
- NO compensa diferencias encontradas
- NO reintenta la verificación
- NO decide por mayoría ni aplica umbrales de tolerancia
- NO tiene modo "approve anyway"
- NO corrige el resultado de la ejecución

### Evidence

**Responsabilidad**: Registrar cada transición de estado de la operación en un registro ordenado y trazable. Es transversal a los otros componentes: cada etapa escribe en Evidence antes de pasar el control a la siguiente.

**Prohibiciones**:
- NO permite borrado
- NO permite modificación
- NO permite reordenamiento
- NO es un paso secuencial del pipeline (no va después de Verify)
- NO define mecanismo de almacenamiento
- NO puede estar deshabilitado (es obligatorio)

---

## 3. Manejo de errores

### Principio: sin retry, sin rollback automático

El kernel no intenta recuperarse de ningún error. Cuando algo falla, la operación pasa a estado Failed y se escala al humano con toda la evidencia disponible. El humano decide el curso de acción.

### Errores por componente

**Intent**
| Condición | Resultado |
|-|-|
| Declaración incompleta (falta target o requester) | Rechazado antes de entrar al pipeline. No se registra en Evidence. |
| Declaración ambigua o contradictoria | Rechazado antes de entrar al pipeline. No se registra en Evidence. |
| Target no reconocido por el sistema | Rechazado. No se registra en Evidence. |

Nota: Intent se rechaza antes de Evidence porque no existe todavía una operación válida; por lo tanto no existe evidencia de ejecución que registrar. Esto evita ruido en el registro.

**Policy**
| Condición | Resultado | Evidence |
|-|-|-|
| Requester no existe | Denied | Requested → Denied |
| Capability no existe o no asignada | Denied | Requested → Denied |
| Capability revocada durante la operación | No aplica: se evalúa en el momento. Si cambió, la operación actual no se invalida. | — |
| requires-approval / requires-dual sin aprobación | Queda en PendingApproval hasta resolución externa | PendingApproval |
| Aprobación externa recibida | Authorized. Contract generado. | Authorized |

**Execute**
| Condición | Resultado | Evidence |
|-|-|-|
| Driver no disponible | Failed | Executing → Failed |
| Driver reporta imposibilidad | Failed | Executing → Failed |
| Driver se cuelga o timeout | Failed (se corta) | Executing → Failed |
| Driver ejecuta parcialmente | Failed | Executing → Failed |

**Verify**
| Condición | Resultado | Evidence |
|-|-|-|
| Estado real no cumple el Contract | Failed | Executed → Failed |
| Efectos secundarios fuera del Contract | Failed | Executed → Failed |
| Recurso no accesible para verificación directa | Failed | Executed → Failed |

### Reglas de estado terminal

- **Completed**: el estado del sistema coincide con el Contract. Operación exitosa.
- **Failed**: cualquier desviación del Contract o imposibilidad de ejecutar. No hay recuperación.
- **Denied**: Policy rechazó la operación.
- Una operación en Failed o Denied no puede transicionar a otro estado. El humano debe emitir un nuevo Intent si quiere reintentar o corregir.

---

## 4. Amenazas y controles

| # | Amenaza | Cómo la resuelve el kernel |
|---|-|-|
| 1 | **Intent falsificado** (suplantan al requester) | Evidence registra la identidad del requester contra el Intent original. Policy evalúa capabilities contra esa identidad. |
| 2 | **Intento de operación no autorizada** | Policy evalúa capabilities planas. Cada operación requiere capability explícita sobre el recurso. No hay herencia, no hay admin. |
| 3 | **Execute ejecuta algo distinto al Contract** | Verify confirma que el estado real cumple exactamente el Contract. Si difieren → Failed. |
| 4 | **Driver miente en su reporte** | Verify lee el estado real del recurso y lo compara contra el Contract. Si difieren → Failed. |
| 5 | **Efectos secundarios no declarados** | Verify verifica que ningún recurso fuera del target fue modificado. Si hay cambios no declarados → Failed. |
| 6 | **Evidence manipulado retroactivamente** | El registro es append-only. No hay operación de borrado, modificación, ni reordenamiento. Cualquier intento de manipulación es detectable por inspección del registro. |
| 7 | **Ejecución fuera del pipeline** (bypass) | La arquitectura debe garantizar que toda operación sobre un recurso protegido pase exclusivamente por el pipeline Intent → Policy → Contract → Execute → Verify. No debe existir un punto de entrada alternativo. |
| 8 | **Operación inaccesible mediante verificación directa** | Verify ejecuta la verificación sobre el recurso real, no confía en el reporte. Si el recurso no responde a la verificación → Failed. |
| 9 | **Indistinción de operaciones** (no saber qué pasó) | Evidence registra cada transición de estado con identidad del requester, Intent original, resultado de cada etapa, y timestamp. Trazabilidad completa. |
| 10 | **Sobrecarga del sistema por errores en cadena** | No hay retry ni rollback automático. Cada operación fallida termina en Failed sin disparar nuevas operaciones. No hay cascada automática. |

---

## Nota final

Este documento define el kernel del Operation Controller. Los siguientes dominios se diseñan por separado y NO son parte de este documento:

- Resource Registry
- Mecanismo de almacenamiento de Evidence
- Drivers concretos
- Sistema de capabilities externo
- UI de aprobación para requires-approval / requires-dual
- API de entrada al kernel
- Mecanismo de notificación al humano

Cada uno de estos dominios debe respetar el kernel definido aquí, no modificarlo.