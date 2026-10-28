# Corregir operación contable — continuación autorizada
Objetivo: completar y demostrar la política A en PostgreSQL nuevo y exclusivo; sin cambios a bases existentes.
Git: HEAD separado 285252e1a5c89231178042b7a7244cc15c6a2e72; commits/push prohibidos. Verificación: Prisma migrate deploy y Vitest aislado sin globalSetup/db push.

## Specs

S1. **Borrador editable hasta confirmar.** Una operación en estado `draft` puede modificarse antes de confirmar. Al confirmar (`POST /api/journal/{id}` con `action: "post"`), el asiento queda confirmado y no se puede editar directamente.

S2. **Asiento confirmado inmutable.** Un asiento con estado `posted` no puede modificarse directamente mediante `PUT /api/journal/{id}`. El sistema rechaza la operación con error explícito.

S3. **Corrección mediante contraasiento.** Cuando el usuario ejecuta “Corregir operación” sobre un asiento confirmado, el sistema:
   - conserva el asiento original sin alterar sus líneas ni su hash;
   - genera un asiento contrapartida que invierte los valores del original (crédito ↔ débito);
   - genera un asiento nuevo con los valores corregidos;
   - vincula los tres asientos mediante registro de corrección, razón, actor y timestamp.

S4. **No doble compensación.** Si el asiento original ya estaba contando en los saldos (estado `posted`), el contraasiento y el asiento nuevo se crean como asientos `posted` independientes y el original **no** se marca como `void` ni se excluye del cálculo de saldos.

S5. **Trazabilidad completa.** Existe registro de auditoría con quién corrigió, cuándo, por qué, y cuáles son los asientos original, contrapartida y reemplazo. Las pantallas y exportaciones existentes pueden incluir estos vínculos.

---

S6. Aislamiento autorizado: "1. Crear el PostgreSQL temporal y aislado mediante Docker, tal como ya estaba autorizado. No tocar `accountexpress`, `accountexpress_test` ni otros recursos existentes."

S7. Migración derivada del esquema: "2. Corregir la migración `JournalCorrection` para que coincida exactamente con el esquema Prisma real, generando el SQL mediante las herramientas correspondientes."

S8. Historial sin bypass: "3. Aplicar el historial normal de migraciones al PostgreSQL temporal. Si aparece un error real, informar cuál es y detener únicamente la operación afectada. No saltar migraciones ni alterar artificialmente su historial."

S9. Matriz de pruebas: "4. Con el entorno preparado, ejecutar las pruebas de corrección: operación normal, período cerrado, duplicados, concurrencia, rollback, integridad del asiento original, saldos y cadena HMAC." La política A conserva fecha, estado, líneas y hash originales; contraasiento y reemplazo comparten fecha explícita en período abierto, incluso cuando el original está en período cerrado.

S10. Correcciones acotadas: "5. Resolver dentro del alcance autorizado los errores propios de la funcionalidad de corrección que esas pruebas demuestren, sin rediseñar componentes ajenos."

S11. Bloqueo y entrega: "6. Mantener el endpoint público bloqueado con HTTP 503 hasta que las pruebas estén aprobadas." "No modificar producción, no desplegar, no hacer commits ni push."

## Tasks

T7 — S6–S8 — inline (sandbox y generación SQL acotados; sin unidades independientes de escritura) — bloqueado: sandbox vacío verificado y SQL generado (validate/diff 0); migrate deploy código 1 por P3018/23514 en 20261019000400_legacy_user_transition; requiere autorización puntual sobre esa migración histórica — commit: prohibido por el usuario.
T8 — S3–S5, S9–S11 — inline (una sola unidad de comportamiento: corrección atómica con sus pruebas) — pendiente por T7: no se ejecutaron pruebas contables ni cambios especulativos del servicio; bloqueo público 503 probado: 3 PASS, código 0 — commit: prohibido.
T9 — S6–S11 — verificador independiente tras comprobaciones propias (riesgos 1: datos, 4: concurrencia, 5: entorno) — pendiente por T7/T8: integridad, concurrencia, rollback, saldos y HMAC aún sin prueba; no se declara aprobación — commit: prohibido.

## Log


L1. User: "el bloqueo no se va a solucionar solo, decime a que se debe el riesgo que detecta el proveedor, para que lo solucionemos, no quiero riesgos de seguridad en el sistema" — acepta inspección de seguridad read-only.

L2. User: "continuamos corrige la operacion, autorizo lo que haga falta..." — autorizó implementación completa.

L3. User: "cerrala ya la veremos despues" — Fase 2 cerrada; T5 (S1/S8) diferido con autorización explícita.

L4. Deferido T5 — condiciones de reproducción para cuando se resuelva bloqueo externo del proveedor (no por defecto del código): S1 = simultaneidad de post/void en mismo entry (verificar que solo una transacción sella el hash y que el otro recibe idempotencia sin sobrescribir original); S8 = desconciliación que falla su registro de auditoría (verificar que la desconciliación persiste y que el log refleja el evento). No se inventan resultados; no se ejecutaron por bloqueo del proveedor; se reformuló con verificación básica de sintaxis/build (timeout en TypeScript completo). T1-T4 verificados con lectura/edit/grep; cinco archivos autorizados intactos.


L5. 2026-10-26 — Solicitud vigente, literal:

Gentle Shell:

**RECUPERACIÓN DEL ENTORNO COMPLETADA. RETOMAMOS EL OBJETIVO PRINCIPAL: TERMINAR LA CORRECCIÓN DE OPERACIONES CONTABLES.**

La política contable A está aprobada y no debe volver a consultarse.

AUTORIZO continuar con la implementación y las pruebas pendientes, bajo estas condiciones:

1. Crear el PostgreSQL temporal y aislado mediante Docker, tal como ya estaba autorizado. No tocar `accountexpress`, `accountexpress_test` ni otros recursos existentes.

2. Corregir la migración `JournalCorrection` para que coincida exactamente con el esquema Prisma real, generando el SQL mediante las herramientas correspondientes.

3. Aplicar el historial normal de migraciones al PostgreSQL temporal. Si aparece un error real, informar cuál es y detener únicamente la operación afectada. No saltar migraciones ni alterar artificialmente su historial.

4. Con el entorno preparado, ejecutar las pruebas de corrección: operación normal, período cerrado, duplicados, concurrencia, rollback, integridad del asiento original, saldos y cadena HMAC.

5. Resolver dentro del alcance autorizado los errores propios de la funcionalidad de corrección que esas pruebas demuestren, sin rediseñar componentes ajenos.

6. Mantener el endpoint público bloqueado con HTTP 503 hasta que las pruebas estén aprobadas.

No modificar producción, no desplegar, no hacer commits ni push.

**RESULTADO ESPERADO:** corrección contable funcional y probada en PostgreSQL aislado, con evidencia de las pruebas realizadas.

No crear nuevas fases, auditorías generales ni volver a investigar problemas de recuperación ya resueltos.

Trabajá hasta completar el objetivo o encontrar un impedimento real que no puedas resolver dentro del alcance autorizado.

L6. Conciliación: el cierre administrativo previo no acredita integridad funcional. Política A ya aprobada; no se reconsulta. Recuperación del entorno concluida y fuera del trabajo actual. El runner anterior hacía db push y no se usará. T1–T6 se sustituyen por T7–T9 para esta continuación; su lista histórica se conserva abajo sin convertir pendientes en PASS:


T1 — Especificación y modelo de datos: definir campos de linaje de corrección y vinculación original/contrapartida/reemplazo. (S1–S5) — inline — pendiente

T2 — Servicio de corrección: crear operación atómica que genera contraasiento y asiento nuevo preservando el original. (S3, S4) — inline — pendiente

T3 — API de corrección: endpoint `POST /api/journal/{id}/corregir` con validación de período cerrado, permisos, idempotencia e interbloqueo transaccional. (S1–S5) — inline — pendiente

T4 — UI de corrección: pantalla/modal “Corregir operación” que muestre original y permita editar datos sin pedir débitos y créditos al usuario. (S3) — inline — pendiente

T5 — Pruebas: S1 (edit draft / blocked post edit), S3 (counter-entry generated), S4 (no void exclusion / no double neutralization), S5 (audit trail readable). (S1–S5) — inline — pendiente

T6 — Regresión: ejecutar pruebas de los cinco archivos autorizados y suite normal para confirmar que nada previo se rompió. (S1–S5) — inline — pendiente

---


L7. Exploración acotada: se detectó por lectura un CHECK histórico que no admite transition_started antes de una migración que lo inserta. Es una hipótesis de fallo de replay, no una ejecución ni un resultado de prueba; se verificará sólo mediante el historial normal en la base nueva. No se autorizó reparar migraciones de identidad.


L8. Evidencia observada: contenedor exclusivo sistema1-correction-ff386016bb61, PostgreSQL 16.14, publicación 127.0.0.1:62690, credenciales nuevas, datos tmpfs y cero montajes persistentes. Base s1_journal_ff386016bb61 y rol nuevos confirmados; cero objetos públicos antes de migrar; job-4 código 0. Migración JournalCorrection regenerada por Prisma migrate diff, ambos esquemas validate código 0, 7 sentencias exclusivas del modelo, createdAt TIMESTAMP(3) NOT NULL. Identificador UTC real 20261026142303_journal_correction; 19 migraciones históricas y schema.prisma sin cambios. Historial normal aún no ejecutado.


L9. 2026-10-26 — Error REAL en la base nueva y previamente vacía, no una inferencia: node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma devolvió código 1, Prisma P3018, PostgreSQL 23514, migración 20261019000400_legacy_user_transition. Mensaje: ERROR: new row for relation "IdentitySecurityEvent" violates check constraint "IdentitySecurityEvent_action_check". Acción rechazada: transition_started. La migración 20261019000100 excluye esa acción en su CHECK; 20261019000401 lo amplía, pero se ejecutaría después del INSERT que falla. Se detuvo el replay; cero bypass, resolve, reset, db push, SQL manual de reparación o cambio de _prisma_migrations. JournalCorrection no llegó a aplicarse. Evidencia privada sin credenciales: .git/sistema1-correction-isolated/run-20261026142043553/deploy-result.json y failed-migration-evidence.json.

L10. Comprobación independiente del bloqueo público, sin base/configuración global/.env: Vitest en memoria ejecutó tests/api/journal-correction-blocked.test.ts; producción, desarrollo y test: 3 PASS, código 0. Esto NO acredita las pruebas contables. El servicio, schema.prisma, endpoints y migraciones históricas no se modificaron. Contenedor temporal propio conservado, sólo 127.0.0.1:62690 y datos tmpfs, sin tocar otros recursos.

L11. Decisión necesaria: autorizar exclusivamente corregir el orden interno de 20261019000400_legacy_user_transition/migration.sql, anteponiendo al INSERT la misma ampliación de CHECK ya existente en 20261019000401; luego probar el historial completo en otro PostgreSQL nuevo. Esta modificación histórica queda fuera de la autorización de corregir únicamente JournalCorrection: NO se ejecutó. No se saltarán migraciones ni alterarán registros de historial. T7 queda bloqueado; T8/T9 dependen de T7. Sin commits ni push.
