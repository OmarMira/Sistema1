# Audit Contract — Account Express New Gen

**Versión:** 1.0  
**Estado:** Aprobado — Fase 0.5  
**Vigencia:** No modificar durante la Fase A. Mejoras se documentan para v1.1.  
**Basado en evidencia de:** Fase 0 — 5 dominios, 62 operaciones analizadas  
**Próximo paso:** Aplicación piloto en Backup/Restore  

---

## 0. Principios del Audit Contract

### 0.1 Una decisión genera un único evento principal

Publicar un asiento puede disparar recálculo de balances, actualización de estadísticas y reindexación. Todo eso son efectos secundarios. Solo la decisión —"publicar asiento"— merece un evento de auditoría. Los efectos derivados no se auditan individualmente.

### 0.2 No se auditan efectos secundarios

Si una operación A causa B y B causa C, solo A genera AuditLog. B y C son consecuencias técnicas de una decisión ya registrada. Auditar la cadena completa duplica información sin valor probatorio adicional.

### 0.3 La auditoría debe poder explicar la decisión

El registro debe contener suficiente contexto para que un revisor externo (auditor, contador, administrador) entienda qué ocurrió sin leer el código fuente. Eso significa: acción, entidad, usuario, resultado, y detalles relevantes. No significa: snapshot completo del estado.

### 0.4 Nunca almacenar secretos

`passwordHash`, `apiKey`, `token`, `secret`, `encrypted_key` están **prohibidos** en cualquier campo del AuditLog o SecurityEvent. También en `details`, `before`, `after`, o metadata. Esta regla no tiene excepciones.

### 0.5 La auditoría debe ser determinista

Dados los mismos inputs, el sistema debe producir los mismos registros de auditoría. Esto significa que el `action` y `entity` deben derivarse del código, no de input del usuario ni de configuración dinámica.

### 0.6 La auditoría no reemplaza backups

AuditLog registra decisiones, no estado. Si un registro se pierde por corrupción de base de datos, el sistema de backups (no el AuditLog) es el responsable de la recuperación.

### 0.7 La auditoría no reemplaza monitoreo

Alertas en tiempo real, dashboards de actividad, y detección de anomalías son responsabilidad de observabilidad (PostHog, logs estructurados, métricas). AuditLog opera en la capa de persistencia de decisiones, no en la capa de detección.

### 0.8 La auditoría no reemplaza versionado

Si el sistema necesita historial completo de cambios de una entidad (ej: "cómo evolucionó esta cuenta contable"), ese es un subsistema separado (event sourcing, tablas de auditoría por entidad). AuditLog responde "quién hizo qué", no "cómo evolucionó esta entidad".

### 0.9 AuditLog nunca debe impedir recuperar el sistema

Si un backup está corrupto y el AuditLog también, la restauración debe seguir siendo posible. El AuditLog depende del negocio, pero el negocio nunca debe depender del AuditLog. Esta separación evita que una falla en el sistema de auditoría vuelva imposible la operación del sistema.

---

## 1. Propósito

El sistema de auditoría garantiza que toda operación crítica sobre datos contables, financieros o de seguridad pueda responder:

- ¿Quién ejecutó la operación? (userId)
- ¿Qué acción realizó? (action)
- ¿Sobre qué empresa? (companyId)
- ¿Sobre qué entidad y cuál de sus instancias? (entity, entityId)
- ¿Cuándo? (timestamp)
- ¿Cuál fue el resultado? (result: success | failed)
- ¿Qué cambió? (details, con datos antes/después cuando aplique)
- ¿Cuál fue el origen? (requestId, ip, userAgent)

**Lo que NO garantiza:**
- Detección en tiempo real de anomalías (es responsabilidad de monitoreo, no del registro)
- Demostración criptográfica de integridad (es responsabilidad de HMAC, fase posterior)
- Reconstrucción del estado completo del sistema (diseñar para eso requeriría event sourcing)

---

## 2. Tipos de registro

Se definen dos registros separados con responsabilidades distintas.

### 2.1 AuditLog

Decisiones de negocio que modifican estado contable o financiero.

**Ejemplos por dominio (evidencia Fase 0):**
| Dominio | Operación | AuditLog requerido | Estado actual |
|---------|-----------|:------------------:|:-------------:|
| Asientos | POST journal entry (borrador) | Creación de borrador | ❌ Ausente |
| Asientos | POST journal (posted/void/closing) | Publicación, anulación o cierre | ⚠️ Presente sin tx |
| Períodos | POST fiscal-periods | Creación de período | ⚠️ Presente sin tx |
| Períodos | POST fiscal-periods/[id]/lock | Bloqueo/desbloqueo | ⚠️ Presente sin tx |
| Cuentas | POST/PUT/DELETE accounts | CRUD de cuenta contable | ❌ Ausente |
| Conciliación | POST reconciliation (manual) | Conciliación manual | ⚠️ Presente sin tx |
| Conciliación | POST bank-rules (create) | Creación de regla | ⚠️ Presente sin tx |
| Reglas | PUT bank-rules/[id] | Edición de regla | ❌ Ausente |
| **Backup** | POST backup/restore | **Restauración de datos** | **❌ Ausente** |

### 2.2 SecurityEvent

Eventos de seguridad o infraestructura sensible. No reemplazan AuditLog — lo complementan cuando existe riesgo de seguridad independientemente de la decisión de negocio.

| Operación | SecurityEvent requerido | Razón |
|-----------|:-----------------------:|-------|
| Backup descargado | **Obligatorio** | Data exfiltration potencial — backup contiene PII + passwordHash |
| Restore iniciado | **Obligatorio** | Sobrescribe todos los datos de la compañía |
| Restore completado/fallido | **Obligatorio** | Trazabilidad de éxito o fallo |
| Login fallido | **Obligatorio** | Intento de acceso no autorizado |
| Permiso denegado | **Recomendado** | Acceso a recurso sin autorización |
| Cambio de contraseña | **Obligatorio** | Modificación de credencial |
| Cambio de API key | **Obligatorio** | Rotación de clave de integración |
| Eliminación de empresa | **Obligatorio** | Destrucción de datos completa |
| Rate limit excedido | **Recomendado** | Posible ataque de fuerza bruta |

### 2.3 Regla de combinación

| Situación | Registro |
|-----------|----------|
| Operación contable normal | Solo AuditLog |
| Operación contable sensible (restore, delete empresa) | AuditLog + SecurityEvent |
| Evento de seguridad sin mutación (login fallido, permiso) | Solo SecurityEvent |
| Backup descargado | Solo SecurityEvent (no es mutación de negocio) |

---

## 3. Contrato mínimo obligatorio

Toda operación auditada DEBE incluir estos campos:

| Campo | Tipo | AuditLog | SecurityEvent | Excepción |
|-------|------|:--------:|:-------------:|-----------|
| `contractVersion` | integer | **Obligatorio** | **Obligatorio** | Siempre `1` en esta versión |
| `companyId` | string | **Obligatorio** | **Obligatorio** | Bootstrap restore (no hay company aún) |
| `userId` | string | **Obligatorio** | **Obligatorio** | Eventos anónimos (login fallido) |
| `action` | string | **Obligatorio** | **Obligatorio** | Debe seguir formato normalizado (sección 3.3) |
| `entity` | string | **Obligatorio** | Permitido null | Según evento |
| `entityId` | string | **Obligatorio** | Permitido null | Según evento |
| `timestamp` | DateTime | **Obligatorio** | **Obligatorio** | Generado automáticamente |
| `requestId` | string | **Recomendado** | **Recomendado** | — |
| `result` | enum(success,failed) | **Obligatorio** | **Obligatorio** | — |
| `details` | JSON | **Recomendado** | **Obligatorio** | Contexto adicional |

### 3.1 Valores por defecto

- `timestamp`: `new Date()` generado por Prisma `@default(now())` — no enviar desde el cliente
- `result`: `'success'` por defecto, `'failed'` solo cuando la operación falló

### 3.2 Acciones prohibidas

- **PROHIBIDO** guardar `passwordHash`, `apiKey`, `token`, `secret` en `details`
- **PROHIBIDO** guardar archivos completos (extractos, backups) en `details`
- **PROHIBIDO** guardar información financiera innecesaria en `details` (usar referencias a IDs)
- **PERMITIDO** guardar resúmenes: conteos, montos totales, IDs de registros afectados

### 3.3 Normalización de acciones

El campo `action` NO es un texto libre. Debe seguir el formato normalizado:

```
{ENTIDAD}_{ACCION_EN_PASADO}
```

**Reglas:**
- Todo en mayúsculas
- Separador: underscore (`_`)
- Entidad en singular
- Acción en pasado (ING o ED para verbos irregulares)
- Sin prefijos de versión ni sufijos contextuales

**Ejemplos válidos:**
```
JOURNAL_POSTED
JOURNAL_VOIDED
ACCOUNT_CREATED
ACCOUNT_UPDATED
ACCOUNT_DEACTIVATED
BANK_RULE_CREATED
BANK_RULE_APPLIED
BACKUP_CREATED
BACKUP_DOWNLOADED
BACKUP_RESTORED
PERIOD_LOCKED
PERIOD_CLOSED
COMPANY_DELETED
LOGIN_FAILED
RESTORE_STARTED
RESTORE_COMPLETED
RESTORE_FAILED
```

**Prohibido:**
| Incorrecto | Razón |
|------------|-------|
| `"posted"` | Sin entidad |
| `"journal_post"` | Verbo en presente |
| `"publish"` | Sin entidad, verbo en presente |
| `"post_journal"` | Orden incorrecto |
| `"JournalPosted"` | CamelCase en vez de mayúsculas |

### 3.4 Compatibilidad (Versionado)

Todo registro de auditoría DEBE incluir `contractVersion` para permitir evolución futura del contrato sin romper compatibilidad con registros existentes.

```typescript
contractVersion: 1  // entero, corresponde a la versión mayor del Audit Contract
```

**Propósito:**
- Dentro de 2-3 años, cuando el contrato evolucione a v2 con nuevos campos (`sourceType`, `batchId`, etc.), los registros v1 seguirán siendo válidos
- Un auditor externo podrá determinar bajo qué versión del contrato se generó cada registro
- Las herramientas de reporte podrán adaptarse según la versión del registro

**Regla:** `contractVersion` se define en el código de la aplicación, no en la base de datos. Nunca debe leerse de configuración dinámica ni de input del usuario.

---

## 4. Regla transaccional

### 4.1 Principio

> Si la mutación y el AuditLog pertenecen a la misma decisión de negocio, DEBEN ocurrir dentro de la misma transacción de base de datos.

### 4.2 Consecuencia

Si falla `createAuditLog` después de la mutación:

- **Crítica / Alta**: la mutación DEBE hacer rollback completo
- **Media**: se permite `createAuditLogWithRetry` con fallo no bloqueante
- **Baja**: no aplica — no requiere auditoría

### 4.3 Casos que cumplen (evidencia Fase 0)

| Operación | AuditLog | Misma tx | Verificación |
|-----------|:--------:|:--------:|:------------:|
| Auto-reconcile | ✅ `auto_reconcile` | ✅ Dentro de `$transaction` (auto/route.ts:270-283) | E3 rollback test ✅ |
| Rule apply | ✅ `RULE_APPLIED` | ✅ Dentro de `$transaction` (bank-rules/[id]/route.ts:449-476) | E3 rollback test ✅ |
| Year close | ✅ `YEAR_CLOSED` | ✅ Dentro de `$transaction` (closing-engine.ts) | E3 test ✅ |

**Estos 3 casos son el modelo a seguir para todas las operaciones críticas.**

### 4.4 Casos que NO cumplen (evidencia Fase 0)

| Operación | AuditLog | Misma tx | Riesgo |
|-----------|:--------:|:--------:|:------:|
| Conciliar manual | ✅ `reconcile_transactions` | ❌ Después del service (reconciliation/route.ts:296-307) | Transacción conciliada sin registro si audit falla |
| Completar período | ✅ `complete_reconciliation_period` | ❌ Después del update (periods/route.ts:173-186) | Período completado sin registro |
| Iniciar período | ✅ `start_reconciliation_period` | ❌ Después del create | Período creado sin registro |
| Lock período (PATCH) | ✅ `PERIOD_LOCKED` | ❌ Después del update | Período bloqueado sin registro |
| Crear período (individual) | ✅ `PERIOD_CREATED` | ❌ Después del create | Período creado sin registro |

**Estos 5 casos son violaciones del principio transaccional y deben corregirse.**

### 4.5 Excepciones justificadas

| Operación | Motivo | Acción requerida |
|-----------|--------|------------------|
| Filesystem (backup create/delete) | No hay DB transaction posible | AuditLog DESPUÉS de la operación, SecurityEvent adicional |
| Descarga de backup | Lectura, no mutación | Solo SecurityEvent (antes de enviar datos) |
| Eventos de fallo | La operación ya falló | Registrar resultado `failed` sin rollback |
| Operaciones donde el resultado se conoce post-facto | El éxito depende de confirmación externa | AuditLog DESPUÉS del resultado conocido |

---

## 5. Criticidad

### 5.1 Definición de niveles

| Nivel | Definición | Ejemplos |
|-------|-----------|----------|
| **Crítica** | Afecta estado contable, integridad de datos, o seguridad del sistema | Restore, conciliar, postear asiento, editar tipo de cuenta, eliminar empresa, descargar backup |
| **Alta** | Modifica configuración sensible o datos operativos importantes | Crear/editar regla, editar período, CRUD cuenta bancaria |
| **Media** | Operaciones administrativas con impacto acotado | Ignore/unignore transacción, editar nombre de cuenta, iniciar período |
| **Baja** | Sin impacto contable o de seguridad | Lecturas, consultas, cambios de UI |

### 5.2 Obligaciones por nivel

| Criticidad | AuditLog | Misma transacción | SecurityEvent | Test E3 |
|------------|:--------:|:-----------------:|:-------------:|:-------:|
| **Crítica** | Obligatorio | Obligatorio | Según naturaleza | Obligatorio |
| **Alta** | Obligatorio | Obligatorio | Según naturaleza | Obligatorio |
| **Media** | Según política | Recomendado | No habitual | Recomendado |
| **Baja** | Generalmente no | No | No | No |

### 5.3 Rollback si falla la auditoría

El rollback NO está determinado únicamente por la criticidad. Depende del **impacto funcional** de la operación:

| Debe hacer rollback | No necesariamente |
|--------------------|-------------------|
| Publicar asiento | Editar descripción o nombre visible |
| Cerrar período | Cambiar nombre de una regla bancaria |
| Restore completo | Cambiar prioridad de una regla |
| Eliminar empresa | Editar notas de un período |
| Conciliar transacciones | Ignore/unignore transacción |
| Crear asiento automático | Cambiar configuración de UI |

**Regla general:** si la operación modifica estado contable o financiero y no hay forma de revertirla funcionalmente desde la UI → rollback obligatorio. Si la operación es reversible, administrativa, o de metadata → retry sin bloqueo.

### 5.4 Reclasificación basada en evidencia (Fase 0)

| Operación | Criticidad anterior | Criticidad contract | Evidencia |
|-----------|:-------------------:|:-------------------:|-----------|
| Editar glAccountId (banco) | Alta | **Crítica** | Semi-retroactivo: reportes reinterpretan historia mediante JOIN vivo |
| Editar balance (banco, sin extractos) | Crítica | **Media** | Solo editable como setup inicial, no con extractos |
| Cancelar período | Alta | **Media** | Diseño intencional: preserva reconciliaciones, suelta contenedor |
| Deshacer conciliación | Alta | **Alta** (confirmado) | No revierte asientos (Modelo B) |
| Completar período | Alta | **Crítica** | Declara proceso de verificación terminado |
| Restore backup | — | **Crítica** | 0% cobertura, sobrescribe todos los datos |

---

## 6. Operaciones masivas

### 6.1 Estructura obligatoria

Para cualquier operación que afecte N registros (N > 1), se DEBE usar un registro de auditoría con:

| Campo | Tipo | Obligatorio | Notas |
|-------|------|:-----------:|-------|
| `batchId` | string | Sí | UUID generado al inicio de la operación |
| `action` | string | Sí | Prefijo según operación (ej: `BATCH_IMPORT`, `BULK_DELETE`) |
| `sourceType` | string | Sí | `'import'`, `'backup'`, `'bulk_action'`, `'generation'` |
| `sourceId` | string | Recomendado | ID del archivo, backup, o trigger |
| `recordCounts` | JSON | Sí | `{ created: N, updated: N, deleted: N, skipped: N, failed: N }` |
| `result` | enum | Sí | `'success'` \| `'partial'` \| `'failed'` |
| `startedAt` | DateTime | Sí | Antes de comenzar la operación |
| `completedAt` | DateTime | Sí | Después de completar |

### 6.2 Cuándo crear registros individuales + batch

| Condición | Registro individual requerido |
|-----------|:----------------------------:|
| Operación masiva sin identidad individual (importación de extracto) | **No** — solo batch |
| Operación masiva con identidad individual (aplicación de reglas) | **Opcional** — si cada transacción necesita trazabilidad propia |
| Restore completo de compañía | **No** — solo batch + SecurityEvent |
| Eliminación de empresa | **No** — solo batch + SecurityEvent |

### 6.3 Referencia cruzada

Si se crean registros individuales adicionales, cada uno DEBE incluir `batchId` para vincular al lote.

### 6.4 Aplicación a operaciones existentes (evidencia Fase 0)

| Operación | AuditLog actual | Contract requerido | Brecha |
|-----------|:--------------:|:------------------:|--------|
| Import bancario | `HOLDER_VALIDATION_*` (titular) | `BATCH_IMPORT` con conteos + `sourceType: 'statement'` | Sin evento de importación completo |
| Generate fiscal periods | Sin audit por período individual | `BATCH_GENERATE` con conteos + `sourceType: 'period_generation'` | Audit fuera de transacción |
| Bulk delete bank rules | `BANK_RULES_BULK_DELETED` | Cumple parcial: necesita `recordCounts` | Sin conteos afectados |
| **Restore** | **Ninguno** | **`BATCH_RESTORE` + `RESTORE_STARTED`/`RESTORE_COMPLETED` + SecurityEvent** | **Cobertura cero** |

---

## 7. Datos antes/después

### 7.1 Regla general

**before/after es excepcional.** No todo cambio necesita guardar estado anterior y posterior. En la mayoría de los casos alcanza con el valor nuevo o la transición.

### 7.2 Formato preferido (por orden de preferencia)

| Formato | Cuándo usar | Ejemplo |
|---------|-------------|---------|
| `newValue` solo | Creación o campo sin riesgo histórico | `{ "accountName": "Caja Principal" }` |
| `field: old → new` | Cambio de estado simple | `{ "status": "draft → posted" }` |
| `{ field: { from, to } }` | Cambio de relación o campo con impacto en reportes | `{ "glAccountId": { "from": "acct_1", "to": "acct_2" } }` |
| `before`/`after` completos | Solo cuando el cambio afecta múltiples campos y su interdependencia es relevante para la auditoría | Cambio masivo de configuración |

### 7.3 Cuándo capturar (referencia)

| Situación | Formato recomendado | before/after |
|-----------|:-------------------:|:-----------:|
| Edición de campo simple (nombre, descripción) | `newValue` | ❌ |
| Cambio de estado contable (lock, activate) | `field: old → new` | ❌ |
| Cambio de relación (glAccountId, normalBalance) | `{ field: { from, to } }` | ⚠️ Excepcional |
| Operación masiva | Resumen con conteos | ❌ |
| Creación de entidad | Ninguno (la entidad misma es el registro) | ❌ |

### 7.2 Formato recomendado

Para cambios de estado:
```json
{
  "transition": "open → locked",
  "fields": {
    "isLocked": { "from": false, "to": true }
  }
}
```

Para cambios de relación:
```json
{
  "fields": {
    "glAccountId": { "from": "acct_old_id", "to": "acct_new_id" }
  }
}
```

### 7.3 Prohibiciones

- **PROHIBIDO** guardar el snapshot completo de la entidad en `details`. El AuditLog no es un "mini backup" — mientras más datos copie, más difícil será mantenerlo cuando cambie el modelo de datos.
- **PROHIBIDO** guardar contraseñas, tokens, o claves incluso en `before`
- **PERMITIDO** guardar los campos específicos que cambiaron (hasta 3 como regla general; excepcionalmente más cuando el cambio lo justifique)

---

## 8. Política de fallos

### 8.1 Si falla AuditLog

El comportamiento depende del **impacto funcional** de la operación, no de su criticidad genérica:

| Impacto funcional | Comportamiento requerido | Ejemplos |
|-------------------|--------------------------|----------|
| **Irreversible desde UI** | **Rollback completo**. `createAuditLogWithRetry` dentro de `$transaction`. Si el retry agota intentos → throw → rollback implícito por Prisma. | Publicar asiento, restore, eliminar empresa, cerrar período |
| **Reversible desde UI** | `createAuditLogWithRetry` (máximo 3 intentos, sin bloqueo). Si falla, la mutación procede igual. Log de error. | Editar nombre de cuenta, cambiar descripción |
| **Configuración no crítica** | Sin acción obligatoria. Log de error. | Cambiar tema, prefers de UI |
| **Sin mutación** | Sin acción. | Lecturas, consultas |

### 8.2 Si falla SecurityEvent

| Naturaleza | Comportamiento requerido |
|------------|--------------------------|
| Evento de seguridad puro (login fallido) | **Nunca bloquea**. Log de error interno. |
| Evento combinado (restore + security) | SecurityEvent fallado **nunca causa rollback** de la mutación. AuditLog es el que bloquea. |

### 8.3 Retry

| Característica | Regla |
|----------------|-------|
| Máximo de intentos | 3 (incluyendo el primero) |
| Intervalo | Sin espera (operación dentro de transacción) |
| Error a capturar | Conexión, timeout, deadlock |
| Excepción | Errores de validación (no reintentar — es bug) |

### 8.4 Registro de fallo

Si la operación falla por cualquier razón (incluyendo auditoría):

- El AuditLog DEBE registrarse con `result: 'failed'`
- El SecurityEvent DEBE registrarse con `result: 'failed'`
- El `details` DEBE incluir el mensaje de error

---

## 9. Fuente de verdad

La auditoría de negocio vive en la **capa de aplicación**, dentro de la misma transacción que la mutación.

**Justificación (evidencia Fase 0):**
- El motor contable es sólido — los errores no están en la lógica de negocio sino en la infraestructura de evidencia
- La aplicación ya tiene `createAuditLogWithRetry` con reintentos
- 3 operaciones (auto-reconcile, rule apply, year close) demuestran que el patrón funciona correctamente
- No se necesita infraestructura adicional (event bus, WAL, CDC) en esta fase

**PostgreSQL / WAL** podrán complementar en el futuro para:
- Replicación
- Disaster recovery
- Auditoría a nivel de base de datos
Pero no reemplazan el contexto funcional que la aplicación captura (userId, action, detalles semánticos).

---

## 10. Testing obligatorio

Para cada operación clasificada como **Crítica** o **Alta**:

| Test | Descripción | Código de evidencia |
|------|-------------|:-------------------:|
| T1 | Verificar que se crea AuditLog con los campos mínimos | E3 |
| T2 | Verificar que el AuditLog está dentro de la misma transacción | E2 + E3 |
| T3 | Verificar rollback si falla la auditoría | E3 |
| T4 | Verificar que `details` no contiene secretos | E3 |
| T5 | Verificar ausencia de secretos en `before`/`after` | E3 |
| T6 | Verificar el camino alternativo (bypass) cuando existe | E3 |
| T7 | Para SecurityEvent: verificar que nunca causa rollback | E3 |

**Prohibido:** test que mockean `createAuditLog` y verifican solo que fue llamado. Los tests E3 deben verificar que el registro existe en la base de datos y tiene los campos correctos.

---

## 11. No aplicable

Quedan explícitamente FUERA del sistema de auditoría:

| Operación | Razón |
|-----------|-------|
| Abrir pantallas | Interacción de UI, no decisión de negocio |
| Mostrar sugerencias predictivas | Lectura, no mutación. Audit analítico no es responsabilidad del AuditLog |
| Cambiar tema / UI | Sin impacto contable ni de seguridad |
| Navegación entre vistas | Sin mutación |
| Lecturas ordinarias (GET) | Sin mutación |
| Recálculos derivados (recalculateBalance) | Ya tienen una causa auditada (el asiento que los originó) |
| Eventos de rate limiting | Responsabilidad de infraestructura, no de auditoría de negocio |
| Logs de depuración | `console.log` / logger no reemplazan AuditLog |

---

## 12. Aplicación piloto: Backup/Restore

### 12.1 Justificación

| Criterio | Evaluación | Evidencia |
|----------|:----------:|-----------|
| Cobertura actual | **0%** — ningún AuditLog, ningún SecurityEvent | backup.ts completo (799 líneas, cero llamadas a audit) |
| Impacto | **Crítico** — sobrescribe datos de 11 tablas, expone PII + passwordHash | restoreBackup() borra y recrea toda la compañía |
| Datos sensibles | passwordHash en backup, PII completa, financieros | backup.ts:249 selecciona passwordHash |
| Operación transversal | Restore afecta TODOS los dominios | Hallazgo replicado en 5/5 dominios |
| Transaccionalidad | Restore ya envuelve en `$transaction` | backup.ts:548 — solo falta el auditLog dentro |
| Complejidad | El motor ya existe, solo agregar registros | No rediseñar, solo instrumentar |

### 12.2 Operaciones a cubrir

| Operación | AuditLog | SecurityEvent | Misma tx |
|-----------|:--------:|:-------------:|:--------:|
| Crear backup | `BACKUP_CREATED` con tamaño y conteos | — | N/A (filesystem) |
| Descargar backup | — | `BACKUP_DOWNLOADED` con filename | N/A (solo lectura) |
| Eliminar backup | `BACKUP_DELETED` con filename | — | N/A (filesystem) |
| Restore (standard) | `RESTORE_STARTED` + `RESTORE_COMPLETED` con recordCounts | `RESTORE_INITIATED` | ✅ Dentro de la tx existente |
| Restore (bootstrap) | Mismo que standard | `BOOTSTRAP_RESTORE` | ✅ Dentro de la tx |
| Restore fallido | `RESTORE_FAILED` con error | `RESTORE_FAILED` | ✅ Dentro de la tx |

### 12.3 Lo que NO se diseña aquí

El código del piloto se definirá en la Fase A, usando este contrato como especificación.

---

## Decisiones cerradas

### 1. ¿Qué operaciones obligan rollback si falla la auditoría?

No está determinado por criticidad genérica sino por **impacto funcional**. Operaciones que modifican estado contable o financiero y no son reversibles desde la UI (publicar asiento, restore, eliminar empresa, cerrar período) → rollback obligatorio. Operaciones reversibles o administrativas (editar nombre, cambiar metadata) → retry sin bloqueo.

La mutación y el AuditLog deben estar en la misma `$transaction`. Si `createAuditLogWithRetry` agota intentos en operación irreversible, el throw causa rollback implícito por Prisma.

### 2. ¿Qué campos son obligatorios?

`contractVersion`, `companyId`, `userId`, `action`, `entity`, `entityId`, `timestamp`, `result`. `requestId` es recomendado. `details` es recomendado para AuditLog, obligatorio para SecurityEvent.

### 3. ¿Cuándo usar AuditLog, SecurityEvent o ambos?

| Situación | Registro |
|-----------|----------|
| Decisión de negocio | AuditLog |
| Evento de seguridad | SecurityEvent |
| Operación contable sensible | Ambos |
| Lectura de datos sensibles | SecurityEvent |
| Evento anónimo | SecurityEvent (userId null permitido) |

### 4. ¿Cómo auditar operaciones masivas?

Con un registro `batch` que incluya `batchId`, `sourceType`, `recordCounts`, `startedAt`, `completedAt`, `result`. No crear registros individuales a menos que cada elemento necesite trazabilidad propia.

### 5. ¿Qué información está prohibido guardar?

`passwordHash`, `apiKey`, `token`, `secret`, `encrypted_key`, archivos completos, información financiera innecesaria. Solo resúmenes, conteos, IDs y transiciones de estado.

### 6. ¿Qué tests son obligatorios?

Para Crítica/Alta: T1 (creación de AuditLog), T2 (misma transacción), T3 (rollback), T4 (sin secretos), T6 (bypass). T5 (sin secretos en before/after) es obligatorio solo si aplica before/after.

### 7. ¿Qué operaciones quedan fuera?

Lecturas (GET), navegación, cambios de UI, sugerencias predictivas, recálculos derivados, logs de depuración, rate limiting.
