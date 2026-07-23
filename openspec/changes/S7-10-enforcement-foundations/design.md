# S7-10 Design: Enforcement Foundations

> **La política decide. El consumidor reacciona. La acción nunca cambia.**

## 1. Principio Arquitectónico

| Capa | Responsabilidad |
|---|---|
| Política | Evaluar readiness y devolver una acción (ALLOW/WARN/CONFIRM/BLOCK) |
| Consumidor | Reaccionar a la acción según su propio flujo |
| Acción | Significado inmutable, idéntico en todos los contextos |

El contexto (Apply All, Import, Reconciliation Manual, Reconciliation Auto) puede modificar el **resultado** de la política — por ejemplo, Import puede devolver WARN donde Apply All devolvería CONFIRM para el mismo Readiness Result. Pero nunca modifica el **significado** de la acción. Eso es inviolable.

## 2. Readiness Result

Los valores `READY`, `NOT_READY` e `INSUFFICIENT_DATA` son el **resultado de la evaluación de readiness** — no son estados del consumidor. Cada uno representa una conclusión sobre la calidad de la evidencia disponible:

| Readiness Result | Significado |
|---|---|
| `READY` | La shadow data es suficiente y la divergencia está dentro del umbral aceptable |
| `NOT_READY` | La shadow data es suficiente pero la divergencia supera el umbral |
| `INSUFFICIENT_DATA` | No hay suficiente shadow data histórica para emitir un juicio |

El consumidor no tiene un estado de readiness. El readiness es lo que **la política devuelve** después de evaluar las métricas.

## 3. Semántica Absoluta de las Acciones

| Acción | Significado | Intervención humana | Ejecuta |
|---|---|---|---|
| `ALLOW` | Ejecutar sin intervención | No | Sí |
| `WARN` | Mostrar advertencia, pero ejecutar | No (solo lectura) | Sí |
| `CONFIRM` | No ejecutar hasta que el usuario confirme explícitamente | Sí — bloqueante | Solo tras confirmación |
| `BLOCK` | No ejecutar. Sin override en v1 | Sí — terminal | No |

### 3.1 ALLOW

La operación es segura según la política. El sistema ejecuta sin intervención humana. Es el estado esperado bajo condiciones normales.

### 3.2 WARN

La operación tiene riesgos detectados, pero no justifican detener el flujo. El sistema ejecuta y muestra una advertencia. El usuario ve la advertencia pero no necesita tomar acción para continuar.

No requiere confirmación. No bloquea.

### 3.3 CONFIRM

La operación está permitida pero requiere consentimiento humano explícito. El sistema no ejecuta hasta que el usuario confirma.

```
CONFIRM ≠ override
```

CONFIRM significa "la operación está permitida, pero necesita que un humano diga 'siga'". No es una excepción ni una violación de la política. Es parte del diseño.

### 3.4 BLOCK

La operación no debe ejecutarse. La política determinó que el riesgo es inaceptable. No existe un botón genérico de "Continuar de todos modos".

Excluido de la primera versión (v1). Se incorporará únicamente cuando el sistema haya demostrado baja tasa de falsos positivos.

## 4. Matriz de Enforcement por Contexto

### 4.1 Matriz final

| Contexto | Readiness Result → READY | NOT_READY | INSUFFICIENT_DATA |
|---|---|---|---|
| Apply All | ALLOW | CONFIRM | WARN |
| Import | ALLOW | WARN | ALLOW |
| Reconciliation Manual | ALLOW | WARN | ALLOW |
| Reconciliation Auto | ALLOW | CONFIRM | WARN |

### 4.2 Justificación por contexto

#### Apply All

Proceso batch que aplica reglas a múltiples transacciones y genera asientos contables. Es el flujo de mayor riesgo porque una decisión incorrecta afecta muchas transacciones simultáneamente.

| Readiness Result | Acción | Justificación |
|---|---|---|
| READY | ALLOW | Estado normal. Ejecuta sin intervención. |
| NOT_READY | CONFIRM | Riesgo alto de divergencia en múltiples reglas. Requiere confirmación humana antes de ejecutar. |
| INSUFFICIENT_DATA | WARN | No hay suficiente data histórica para evaluar, pero bloquear sería demasiado restrictivo. Advertir y continuar. |

#### Import

Proceso de carga de extractos bancarios. Importa información; no modifica reglas ni aplica decisiones contables de alto riesgo.

| Readiness Result | Acción | Justificación |
|---|---|---|
| READY | ALLOW | Estado normal. Ejecuta sin intervención. |
| NOT_READY | WARN | La política detecta anomalías, pero bloquear una importación impediría que el usuario trabaje. Advertir y continuar. |
| INSUFFICIENT_DATA | ALLOW | Primeras importaciones de una cuenta nueva no tienen historial. No bloquear ni advertir. |

#### Reconciliation Manual

Proceso guiado por un usuario que ya está revisando y tomando decisiones transacción por transacción. Pedir CONFIRM sería redundante.

| Readiness Result | Acción | Justificación |
|---|---|---|
| READY | ALLOW | Estado normal. Ejecuta. |
| NOT_READY | WARN | El usuario ya está revisando manualmente. La advertencia es informativa. |
| INSUFFICIENT_DATA | ALLOW | Sin historial de conciliación previa, no hay base para advertir. |

#### Reconciliation Auto

Proceso batch que puede reconciliar muchas transacciones automáticamente. Mismo perfil de riesgo que Apply All.

| Readiness Result | Acción | Justificación |
|---|---|---|
| READY | ALLOW | Estado normal. Ejecuta. |
| NOT_READY | CONFIRM | Riesgo de auto-reconciliar con datos no confiables. Requiere confirmación. |
| INSUFFICIENT_DATA | WARN | Sin suficiente data histórica, advertir pero permitir continuar. |

## 5. Contexto `RECONCILIATION`: Distinción Conceptual

El contexto `RECONCILIATION` agrupa dos operaciones con riesgos e intervención humana distintos. La matriz del documento las distingue conceptualmente, pero el enum `OperationalContext` no se divide todavía.

### 5.1 Por qué se distinguen conceptualmente

| Aspecto | Reconciliation Manual | Reconciliation Auto |
|---|---|---|
| Ejecución | Usuario guiando paso a paso | Batch automático |
| Volumen de transacciones | Usuario revisa una por una | Puede afectar cientos |
| Riesgo | Bajo (humano supervisa) | Alto (batch sin supervisión) |
| Intervención humana | Ya existe (el usuario está operando) | No existe hasta que se pide |
| CONFIRM tendría sentido | No — redundante | Sí — mismo perfil que Apply All |

### 5.2 Decisión: postergar el split del enum

El enum `OperationalContext` **no se modifica en S7-10**. El contexto `RECONCILIATION` se mantiene como valor único.

**Motivo**: ningún consumidor usa enforcement todavía. Cambiar el modelo del dominio antes de tener un consumidor real que lo necesite introduce riesgo sin beneficio inmediato. Si durante la implementación de enforcement para reconciliación se confirma que ambos flujos requieren políticas distintas, recién ahí se divide el contexto.

Hasta entonces, el perfil de enforcement usará `RECONCILIATION` con el comportamiento más conservador (Manual), y cuando llegue el enforcement de Auto-reconciliación se evaluará la división.

Mientras tanto, la tabla de la sección 4 documenta la **intención arquitectónica** de que los dos flujos tienen políticas diferentes, aunque el código aún no refleje esa diferencia en el sistema de tipos.

## 6. Estrategia de Perfil

### 6.1 Perfil estándar versionado

La matriz inicial vive en un **perfil versionado y controlado por servidor**, no en variables de entorno.

```typescript
export const STANDARD_ENFORCEMENT_PROFILE = {
  profileId: 'enforcement-standard',
  version: '1.0.0',
  rules: [
    // Apply All
    { context: 'APPLY_ALL', readinessStatus: 'READY', action: 'ALLOW' },
    { context: 'APPLY_ALL', readinessStatus: 'NOT_READY', action: 'CONFIRM' },
    { context: 'APPLY_ALL', readinessStatus: 'INSUFFICIENT_DATA', action: 'WARN' },
    // Import
    { context: 'IMPORT', readinessStatus: 'READY', action: 'ALLOW' },
    { context: 'IMPORT', readinessStatus: 'NOT_READY', action: 'WARN' },
    { context: 'IMPORT', readinessStatus: 'INSUFFICIENT_DATA', action: 'ALLOW' },
    // Reconciliation (comportamiento Manual por defecto)
    // Auto-reconciliación usará política distinta cuando el contexto se divida
    { context: 'RECONCILIATION', readinessStatus: 'READY', action: 'ALLOW' },
    { context: 'RECONCILIATION', readinessStatus: 'NOT_READY', action: 'WARN' },
    { context: 'RECONCILIATION', readinessStatus: 'INSUFFICIENT_DATA', action: 'ALLOW' },
  ],
};
```

### 6.2 Por qué NO variables de entorno

| Problema | Variables de entorno | Perfil versionado |
|---|---|---|
| Auditoría | No deja rastro | Versión + changelog |
| Modificación externa | Puede cambiar fuera del sistema | Controlado por servidor y código |
| Trazabilidad | No se sabe quién cambió ni cuándo | Usuario, fecha, motivo |
| Visualización | Difícil de inspeccionar | Legible y estructurado |
| Consistencia | Distintos entornos pueden tener valores distintos | Mismo perfil en todos los entornos |

### 6.3 Personalización por empresa (diferida)

Cuando el estándar haya sido validado, cada empresa podría tener su propio perfil almacenado en base de datos. Cada modificación debe incluir:

- Versión del perfil
- Usuario que lo modificó
- Fecha y hora
- Reglas anteriores
- Reglas nuevas
- Motivo del cambio
- Auditoría completa

No se implementa en v1.

## 7. Decisiones Diferidas

| Decisión | Estado | Motivo |
|---|---|---|
| BLOCK | Excluido de v1 | No hay suficiente evidencia para identificar situaciones realmente peligrosas con baja tasa de falsos positivos |
| Override de BLOCK | Excluido de v1 | Requiere rol autorizado, motivo obligatorio, re-evaluación, auditoría permanente. No existe botón genérico "Continuar de todos modos" |
| Single Apply | Excluido | No existe como flujo real en el código. Confirmado por exploración |
| Personalización por empresa | Diferida | El estándar debe validarse primero |
| Señales que modifican severidad | Diferidas | Transaction volume, divergence, integrity errors, closed period, user role — se definen después de la matriz base |

### 7.1 BLOCK — criterios de incorporación futura

BLOCK se incorporará cuando el sistema demuestre:

- Tasa de falsos positivos < umbral definido (por definir con data real)
- Capacidad de distinguir entre riesgo real y anomalía estadística
- Mecanismo de override formal (no un botón genérico)

### 7.2 Override de BLOCK — requisitos futuros

Cuando se incorpore, debe exigir:

- Rol autorizado
- Motivo obligatorio
- Re-evaluación de la política justo antes de ejecutar
- Decisión original preservada
- Usuario que autorizó
- Fecha y hora
- Resultado ejecutado
- Protección contra doble ejecución
- Auditoría permanente

## 8. Próximo paso

La matriz de enforcement está aprobada. El próximo paso es implementar enforcement en los consumidores existentes (Apply All e Import), comenzando con la reacción a la acción `CONFIRM` y el bloqueo del flujo hasta confirmación humana. El contexto `RECONCILIATION` se mantiene sin cambios hasta que se implemente enforcement para reconciliación y se evalúe si la división del enum es necesaria.
