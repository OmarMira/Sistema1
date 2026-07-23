# S7-10A Design: Enforcement Interaction Model

> **La política decide. El consumidor reacciona. La acción nunca cambia.**
>
> La interacción con el usuario es parte de la reacción del consumidor. No es UX decorativa — es la manifestación concreta del principio arquitectónico.

## 1. Alcance

### 1.1 Contrato vinculante (detalle completo)

- Apply All
- Import

### 1.2 Orientación futura (conceptual, no vinculante)

- Reconciliation Manual
- Reconciliation Auto

### 1.3 Excluido

- Single Apply — no existe como flujo real

## 2. Regla de Re-evaluación

### 2.1 Principio

La confirmación autoriza el **intento** de ejecutar, no la ejecución misma. Inmediatamente antes de ejecutar, la política se reevalúa.

### 2.2 Orden de severidad

```
ALLOW < WARN < CONFIRM < BLOCK
```

### 2.3 Vigencia de la confirmación

Una confirmación **no es válida indefinidamente**. La ventana de validez expira:

- Al cerrar la pantalla actual (navegación, refresh, pestaña)
- Automáticamente después del tiempo definido por la política de interacción (valor inicial: **30 segundos**)

Si la confirmación expiró antes de que el usuario haga clic:

- **No ejecutar.** Mostrar mensaje: "La confirmación expiró. La operación será evaluada nuevamente."
- Re-evaluar la política automáticamente (como si fuera una nueva solicitud)
- Si el nuevo resultado requiere confirmación, mostrar el modal nuevamente
- Si el nuevo resultado es ALLOW o WARN, ejecutar

Esto evita ejecutar decisiones viejas sobre datos nuevos.

### 2.4 Tabla de re-evaluación

| Resultado original | Nuevo resultado | Acción |
|---|---|---|
| CONFIRM | ALLOW | Ejecutar automáticamente. Mostrar mensaje: "La condición mejoró. La operación fue ejecutada." |
| CONFIRM | WARN | Ejecutar. Mostrar advertencia. No requiere reconfirmación (WARN < CONFIRM). |
| CONFIRM | CONFIRM | Ejecutar. La confirmación previa sigue siendo válida para esta reevaluación inmediata. |
| CONFIRM | BLOCK | **No ejecutar.** La confirmación anterior queda invalidada (BLOCK > CONFIRM). Mostrar bloqueo. |

### 2.5 Regla general

| Cambio de severidad | Resultado |
|---|---|
| Baja o se mantiene | Continuar, la confirmación previa es válida |
| Sube | Detener, confirmación anulada |

## 3. Apply All — Interacción

### 3.1 Matriz de interacción

| Acción | Tipo | ¿Bloquea? | ¿Qué ve el usuario? | Comportamiento |
|---|---|---|---|---|---|
| ALLOW | Sin intervención | No | Sin fricción. Indicador opcional de resultado exitoso (p.ej. mensaje discreto "Policy check passed" en la respuesta). | Ejecuta sin fricción. El resultado exitoso es la confirmación misma. |
| WARN | Advertencia no bloqueante | No | Advertencia visible para el usuario después de la ejecución (p.ej. banner en pantalla de resultado). Muestra motivo y alcance. No requiere acción para continuar. | La operación se ejecuta completa. La advertencia se muestra a posteriori. |
| CONFIRM | Confirmación bloqueante | Sí — hasta decisión del usuario | Interfaz de confirmación con: (a) título, (b) resumen del riesgo, (c) cantidad de transacciones, (d) acción recomendada, (e) perfil y versión, (f) botones para cancelar o confirmar. | La operación no se ejecuta hasta confirmación. Al confirmar, se re-evalúa. Al cancelar, no se ejecuta nada. |
| BLOCK | Futuro | Sí — terminal | Mensaje informativo de bloqueo. Sin opción de continuar. Sólo cerrar y revisar. | No implementado en v1. |

### 3.2 Texto del modal CONFIRM

```
Título:  Confirmar operación
Subtítulo: La política de seguridad recomienda revisar antes de continuar.

Riesgo detectado:    {reasonCode}
Transacciones:       {transactionCount}
Perfil:              {profileId} v{profileVersion}

La clasificación automática presenta una divergencia alta.
Se recomienda revisar las reglas antes de aplicar.

[Cancelar]  [Confirmar y ejecutar]
```

### 3.3 Comportamiento de cancelación

- No se ejecuta nada
- No se modifica ningún dato
- Se cierra el modal
- El usuario vuelve al estado anterior (pre-apply, puede revisar criterios)
- Se audita la cancelación como decisión válida del usuario — no como error

### 3.4 Accesibilidad

- Modal: foco atrapado dentro del modal (focus trap)
- Enter en "Confirmar y ejecutar" ejecuta
- Escape o clic fuera del modal: CERRAR sin ejecutar (equivale a cancelar)
- Doble clic en "Confirmar y ejecutar": la re-evaluación ocurre antes de ejecutar, el doble clic no gatilla dos ejecuciones

## 4. Import — Interacción

### 4.1 Matriz de interacción

| Acción | Tipo | ¿Bloquea? | ¿Qué ve el usuario? | Comportamiento |
|---|---|---|---|---|---|
| ALLOW | Sin intervención | No | Sin fricción. El resultado normal de importación es suficiente. | Ejecuta sin fricción. |
| WARN | Advertencia no bloqueante | No | Advertencia visible en el resultado de importación (p.ej. mensaje inline). Indica que la importación se completó pero la confiabilidad de clasificación es baja. | La importación se completa. La advertencia aparece en el resultado. |
| CONFIRM | Futuro (solo si la matriz cambia) | Sí | Pendiente de definir. Similar a Apply All pero contextualizado a Import. | Solo aplica si una regla futura devuelve CONFIRM para Import. Actualmente no ocurre. |
| BLOCK | Futuro | Sí | Mensaje informativo: no se realizó la importación. Causa y pasos para corregir. | No implementado en v1. |

### 4.2 Texto de advertencia WARN (en resultado de importación)

```
Advertencia de clasificación

La importación se completó correctamente, pero la confiabilidad
de la clasificación automática es baja ({reasonCode}).

Motivo: {readableReason}
Transacciones analizadas: {transactionCount}

Se recomienda revisar las transacciones categorizadas
antes de continuar.
```

### 4.3 Diferencia clave con Apply All

Import no bloquea en v1. Todas las acciones actuales (ALLOW y WARN) permiten que la importación se complete sin detenerse. CONFIRM está documentado para cumplimiento futuro pero no se implementa hasta que una regla lo requiera.

## 5. Reconciliation — Orientación Futura

### 5.1 Reconciliation Manual

| Acción | Interacción probable |
|---|---|
| ALLOW | Continúa normalmente. Sin mensaje adicional. |
| WARN | Advertencia en la interfaz de conciliación. No bloquea. |
| CONFIRM | No aplica en el diseño actual — el usuario ya está guiando manualmente. |
| BLOCK | Futuro si se implementa. |

### 5.2 Reconciliation Auto

| Acción | Interacción probable |
|---|---|
| ALLOW | Ejecuta auto-reconciliación. |
| WARN | Ejecuta y muestra advertencia en el resultado. |
| CONFIRM | Modal bloqueante similar a Apply All. Riesgo batch. |
| BLOCK | Futuro. |

Detalles operativos no cerrados — se definirán cuando Reconciliation consuma Operational Policy.

## 6. Auditoría

### 6.1 Modelo de eventos

La auditoría distingue dos tipos de eventos:

**Evento de decisión** (uno solo, contiene la acción en el payload):

| Evento | Registra |
|---|---|
| `OPERATIONAL_POLICY_DECISION` | La política devolvió una acción. Contexto, acción (`ALLOW`/`WARN`/`CONFIRM`/`BLOCK`), perfil, versión, reasonCode, readinessStatus, usuario, fecha. |

**Eventos de interacción** (representan acciones del usuario):

| Evento | Registra |
|---|---|
| `OPERATIONAL_POLICY_CONFIRM_ACCEPTED` | Usuario aceptó la confirmación. Decisión original + nueva decisión post-re-evaluación, datos de confirmación expirada (si aplica), usuario, fecha. |
| `OPERATIONAL_POLICY_CONFIRM_CANCELLED` | Usuario canceló. Decisión original, usuario, fecha. Nivel INFO — no es error, es decisión válida. |
| `OPERATIONAL_POLICY_CONFIRM_EXPIRED` | La confirmación expiró por tiempo. Decisión original, tiempo transcurrido, usuario, fecha. |

No existe un evento por acción (`OPERATIONAL_POLICY_ALLOW`, `OPERATIONAL_POLICY_WARN_SHOWN`, etc.). La acción es un campo del payload del evento único `OPERATIONAL_POLICY_DECISION`. Esto mantiene el modelo extensible: agregar una nueva acción no requiere crear un nuevo tipo de evento.

### 6.2 Datos comunes en todos los eventos de auditoría

| Campo | Descripción |
|---|---|
| `companyId` | Empresa |
| `userId` | Usuario que ejecutó (o intentó) la operación |
| `context` | Apply All, Import, etc. |
| `action` | ALLOW, WARN, CONFIRM, BLOCK |
| `profileId` | Perfil utilizado |
| `profileVersion` | Versión del perfil |
| `reasonCode` | Código de motivo de la política |
| `readinessStatus` | READY, NOT_READY, INSUFFICIENT_DATA |
| `timestamp` | Fecha y hora del evento |

## 7. Re-evaluación: Diagrama de Estados

```
CONFIRM_SHOWN (inicia temporizador 30s)
     │
     ├── Expira (30s sin acción)
     │       │
     │       ▼
     │   Confirmación expirada: informar al usuario
     │   Re-evaluar automáticamente
     │   Si requiere CONFIRM → mostrar modal nuevamente
     │   Si ALLOW/WARN → ejecutar
     │
     └── User clicks "Confirmar y ejecutar"
             │
             ▼
         [Re-evaluate policy with current data]
             │
             ├── ALLOW  ──► Execute
             │
             ├── WARN   ──► Execute + show WARN
             │
             ├── CONFIRM──► Execute (confirmation still valid)
             │
             └── BLOCK  ──► Show BLOCK (confirmation invalidated)
```

## 8. Reglas de negocio para la implementación

1. **Re-evaluación obligatoria**: toda confirmación ejecuta re-evaluación inmediata antes de ejecutar. Sin excepción.
2. **Vigencia de confirmación**: tiempo limitado definido por la política de interacción (valor inicial: 30 segundos). Al expirar, la confirmación se invalida. Se re-evalúa automáticamente.
3. **Expiración por navegación**: cerrar la pantalla, hacer refresh o cambiar de pestaña invalida la confirmación inmediatamente.
4. **Idempotencia de re-evaluación**: solo puede existir una re-evaluación activa por operación. Un clic inicia la re-evaluación; los clics simultáneos se ignoran. Nunca pueden correr dos re-evaluaciones en paralelo para la misma operación.
5. **Cancelación**: nunca se registra como error. Nunca modifica datos.
6. **Persistencia del modal**: si el usuario hace refresh mientras el modal está abierto, la operación no se ejecuta. El modal se pierde (es estado de UI, no de servidor).
7. **WARN no bloquea**: la operación se completa antes de mostrar la advertencia. Cada consumidor decide la representación (banner, mensaje inline, notificación).

## 9. Próximo paso

S7-10A está completo como documento de arquitectura. El próximo paso (S7-11) es auditar los puntos de enforcement concretos en Apply All e Import antes de escribir código: rutas HTTP, puntos de intercepción, tipos de respuesta, contratos existentes y tests que deben caracterizar el comportamiento actual como baseline del cambio.
