# Company Knowledge — Documento de Dominio

## 1. Problema

El sistema sugiere roles para entidades detectadas en transacciones bancarias.
Actualmente la sugerencia se basa en:

1. `EntityContext` (reglas guardadas por el usuario)
2. `findLocalMatch()` (coincidencia textual contra EntityContext)
3. LLM con señales de transacciones (dirección, frecuencia, montos, descripciones)

El LLM **no tiene contexto permanente de la empresa**. No sabe quiénes son los dueños,
qué empresas están relacionadas, qué productos financieros tiene, ni cuáles son sus
plataformas de ingreso. Esto produce errores predecibles:

| Entidad | Señal | Rol sugerido | Rol correcto |
|---------|-------|-------------|--------------|
| Omar Mira | 100% débito | PROVEEDOR | SOCIO (dueño) |
| Laura Quijano | 100% débito | PROVEEDOR | SOCIO (dueña) |
| AMERICAN EXPRESS | 100% débito | PROVEEDOR | TARJETA_CREDITO |
| LQ&OM INVESTMENT LLC | 100% débito | PROVEEDOR | TRANSFERENCIA |

Estos errores **no se resuelven mejorando el prompt**. Se resuelven dándole al sistema
conocimiento explícito sobre la empresa.

---

## 2. Definición Oficial

> **Company Knowledge es conocimiento confirmado por la empresa sobre la identidad y las relaciones de las entidades con las que interactúa. No representa reglas contables, reglas bancarias, reglas de conciliación ni lógica de contabilización. Su único propósito es aportar contexto confiable para mejorar la identificación y clasificación de entidades durante los procesos del sistema.**

> **Company Knowledge nunca determina por sí solo el tratamiento contable de una transacción; únicamente aporta contexto al motor de decisión.**

### 2.1 ¿Qué NO puede guardar Company Knowledge?

Company Knowledge nunca debe almacenar:

- cuentas contables
- mapeos a cuentas contables
- asientos contables
- reglas bancarias
- reglas de conciliación
- condiciones de matching
- importes
- prioridades
- heurísticas del motor
- scoring
- prompts
- configuraciones del LLM
- tratamiento fiscal
- flags de auto-aplicación
- credenciales, tokens o secretos

Company Knowledge responde solo a:

> **¿Quién es esta entidad y qué relación tiene con la empresa?**

No responde a:

> ¿Qué asiento hago? ¿Qué cuenta uso? ¿Qué regla aplico?

---

## 3. Separación de Responsabilidades (Principio de Dominio)

Tres capas independientes, cada una con una responsabilidad exclusiva:

| Capa | Pregunta que responde |
|------|----------------------|
| **Company Knowledge** | ¿Quién es esta entidad y qué relación tiene con la empresa? |
| **EntityContext** | ¿Cómo se comporta esta entidad en el historial bancario? |
| **BankRule** | ¿Qué acción contable/regla aplicar cuando aparece? |

**Regla dura:** Ninguna de las tres capas puede absorber responsabilidades de otra.

Esto significa:
- Company Knowledge no define reglas contables
- EntityContext no define identidad
- BankRule no define relación

El flujo completo es:

```
Company Knowledge
        ↓
  aporta contexto
        ↓
EntityContext
        ↓
BankRule
        ↓
Motor contable
```

---

## 4. Invariantes

### Invariante 1 — Aprobación humana

> **Toda modificación de Company Knowledge requiere una decisión humana explícita. El sistema, las heurísticas, el historial y el LLM pueden generar sugerencias, pero nunca pueden crear, modificar, reemplazar o eliminar conocimiento confirmado sin la aprobación de un usuario autorizado.**

Esto protege: create, update, merge, split, archive, restore, cambio de relación, cambio de aliases.

### Invariante 2 — Fuente de verdad

> **Una vez confirmado por un usuario, Company Knowledge se considera la fuente de verdad (Source of Truth) para esa empresa y tiene prioridad sobre cualquier inferencia automática hasta que un usuario autorizado lo modifique explícitamente.**

> Company Knowledge representa la verdad conocida por la empresa, no necesariamente la verdad absoluta del mundo real. El sistema respeta la decisión del usuario aunque sea incorrecta, hasta que alguien autorizado la corrija.

El sistema no vuelve a inferir sobre entidades con conocimiento confirmado. Si el LLM no coincide, solo puede advertir: "Detecté una posible inconsistencia. ¿Desea revisar Company Knowledge?" — nunca modificarlo.

---

## 5. Tipos de Conocimiento

### 5.1 Estructura

**Decisión:** Tabla única polimórfica con `type` discriminator + campos comunes tipados +
`metadata` JSON validada por Zod según `type`. No JSON libre sin schema.

Modelo conceptual:

| Campo | Descripción |
|-------|-------------|
| `companyId` | Empresa propietaria |
| `type` | Discriminador: person, company, financial_product, platform, asset |
| `canonicalName` | Nombre canónico de la entidad |
| `aliases` | Nombres alternativos (`string[]`) |
| `relationship` | Relación empresarial: owner, employee, vendor, customer, tenant, lender, credit_card_provider, related_company, income_platform |
| `source` | Origen: user_confirmed, correction, system_suggested, csv_import |
| `status` | active, archived, merged |
| `mergedInto` | knowledgeId destino (solo si status = merged) |
| `metadata` | JSON validado por Zod por type |

Cada `type` tiene su propio Zod schema que valida el contenido de `metadata`.

**Importante:** Company Knowledge no conoce `EntityRole`. La relación empresarial
(`relationship`) se mapea a `EntityRole` en una capa intermedia fuera de este dominio.

### 5.2 Personas (`type: person`)

Personas físicas con relación conocida con la empresa.

| Metadata | Tipo | Ejemplo |
|----------|------|---------|
| relationship | enum | owner, employee, vendor, tenant |
| notes | string | "Dueño de LQ&OM LLC" |

### 5.3 Empresas relacionadas (`type: company`)

Otras empresas con las que la entidad tiene relación.

| Metadata | Tipo | Ejemplo |
|----------|------|---------|
| relationship | enum | subsidiary, parent, sister_company, customer, vendor |
| taxId | string | Opcional |

### 5.4 Productos financieros (`type: financial_product`)

Tarjetas de crédito, préstamos, líneas de crédito, etc.

| Metadata | Tipo | Ejemplo |
|----------|------|---------|
| productType | enum | credit_card, loan, credit_line, mortgage |
| holder | string | "Laura Quijano" |

### 5.5 Plataformas de ingreso (`type: platform`)

Plataformas que generan ingresos recurrentes.

| Metadata | Tipo | Ejemplo |
|----------|------|---------|
| frequency | enum | weekly, biweekly, monthly, variable |

### 5.6 Activos (`type: asset`)

Vehículos, propiedades, equipos registrados.

| Metadata | Tipo | Ejemplo |
|----------|------|---------|
| assetType | enum | vehicle, property, equipment |
| relatedEntity | string | "SETOYOTA FIN/EZP" |

### 5.7 ~~Aliases (`type: alias`)~~ — Eliminado

Los aliases ya no son un tipo separado. Son un campo `aliases: string[]` dentro de la entidad canónica. Un alias no es una entidad, es un atributo de una entidad.

---

## 6. Modelo de Identidad de Entidades

### 6.1 Unidad de Conocimiento

La unidad de Company Knowledge es siempre la **entidad canónica confirmada por la empresa**.
No puede ser:

- descripción bancaria
- línea importada
- transacción
- patrón crudo
- sample description

Solo la entidad canónica y sus aliases pertenecen a Company Knowledge. La transacción
queda en BankTransaction, el comportamiento queda en EntityContext, la acción contable
queda en BankRule.

### 6.2 Creación del Canonical Name

**Decisión:** El sistema y el LLM pueden **proponer** un Canonical Name, pero nunca
crearlo automáticamente. La incorporación a Company Knowledge requiere confirmación
explícita de un usuario autorizado. Una vez confirmado, el Canonical Name se convierte
en la identidad oficial de la entidad para esa empresa y solo puede modificarse mediante
una acción explícita auditada.

No pueden existir dos entidades canónicas que representen la misma entidad dentro de una
misma empresa; las variantes deben registrarse como aliases.

### 6.3 Prevención de Duplicados

Antes de crear una nueva entidad canónica, el sistema debe ejecutar duplicate prevention:

1. **Exact alias match** → usar entidad existente
2. **Exact canonicalName match** → usar entidad existente
3. **Similitud alta** → sugerir posible duplicado, bloquear creación automática
4. **Similitud media/baja** → permitir crear nueva pero advertir si hay candidatos parecidos

**Nunca** crear automáticamente una entidad equivalente ni hacer merge automático.

### 6.4 Merge de Entidades

Cuando dos o más entidades representan al mismo actor económico, el sistema ejecuta
un **Merge explícito y auditado**.

**Política de merge con metadata conflictiva:**

Merge nunca resuelve metadata conflictiva solo. El flujo es:

```
Entidad A (existente)
Entidad B (existente)
      ↓
Sistema muestra diferencias campo por campo
      ↓
Usuario elige valor final por cada campo
      ↓
Sistema genera entidad canónica resultante
      ↓
Audit log registra before/after completo de ambas entidades
```

Reglas por campo:

| Campo | Política |
|-------|----------|
| `canonicalName` | Lo decide el usuario |
| `aliases` | Se combinan automáticamente, eliminando duplicados |
| `relationship` | Lo decide el usuario si difiere |
| `metadata` | Se resuelve campo por campo por el usuario |
| Referencias externas (EntityContext, BankRule) | Se migran al canónico destino |

Qué ocurre:
- Una única entidad permanece como canónica
- Las demás transfieren sus aliases, relaciones y referencias al registro canónico
- Las entidades origen quedan con estado `merged` y referencia a la entidad destino
- EntityContext, BankRules y demás referencias se migran al nuevo canónico

**Reglas:**
- El Merge nunca es automático
- El LLM puede sugerir candidatos a merge, pero no ejecutarlo
- Solo un usuario autorizado puede confirmar un merge
- Toda operación queda registrada en auditoría
- Merge requiere usuario autorizado

---

## 7. Cadena de Prioridad

Cuando el sistema necesita sugerir una relación (`relationship`) para una entidad, consulta las fuentes
en este orden:

```
1. Company Knowledge (usuario confirmó explícitamente)
   ↓ si no existe
2. EntityContext / BankRule (reglas guardadas por acciones previas)
   ↓ si no existe
3. Local Match (coincidencia textual contra EntityContext histórico)
   ↓ si no existe
4. LLM Suggestion (señales de transacciones + Company Knowledge como contexto)
   ↓ si no existe
5. Default (OTRO / pendiente de clasificación)
```

**Company Knowledge siempre gana sobre el LLM.** Si el usuario confirmó que
Omar Mira es owner (socio), el sistema no vuelve a preguntar ni a sugerir vendor.
Si el LLM discrepa, solo puede advertir al usuario — nunca modificar el conocimiento.

---

## 8. Ciclo de Vida

### 7.1 Límites

- **Máximo:** 1,000 entradas activas por empresa
- **Archivadas:** no cuentan para el límite
- **UI/API:** paginadas desde el inicio, con búsqueda por nombre/tipo/estado

### 7.2 Herencia

**No.** Company Knowledge pertenece exclusivamente a un `companyId`. No existe
herencia entre empresa matriz, subsidiarias, franquicias ni grupos empresariales.

Si en el futuro se necesita reutilizar conocimiento, se hará mediante **plantillas
(templates) copiables**, nunca mediante referencias compartidas ni herencia viva.

### 7.3 Importación CSV

Reservado como `source: csv_import` pero fuera de Fase 1. En Fase 1 solo existe
creación por confirmación explícita del usuario y correcciones dentro del flujo.

### 7.4 Eliminación de empresa

Company Knowledge tiene ciclo de vida idéntico al de Company. Si la empresa se
elimina, todo su Company Knowledge se elimina. No se archiva, no se migra, no se
reutiliza. El AuditLog sigue la política general del sistema para empresas eliminadas.

### 7.5 Auditoría

Todo create / update / archive / restore en Company Knowledge genera audit log con:

- `companyId`
- `knowledgeId`
- `action`: created, updated, archived, restored, confirmed, corrected
- `changedByUserId`
- `timestamp`
- `beforeValue`
- `afterValue`
- `source`
- `reason` / `context`

**No hay hard delete en Fase 1.** Solo archive/restore.

### 7.6 Detección (matching)

Company Knowledge matching debe ser un **servicio central reutilizable**, no lógica
pegada a `clusterByBehavior()`. Se usa en:

1. **Onboarding / preclasificación**: entidades detectadas en lote consultan Company Knowledge
2. **Clasificación transaccional**: transacciones nuevas consultan Company Knowledge como señal fuerte

Su salida es una **señal de identidad/rol**, no autorización automática para crear
asientos o aplicar cuentas sin regla confirmada.

---

## 9. Flujo de Aprendizaje

### 8.1 Aprendizaje explícito (usuario declara)

1. Usuario abre "Configuración de la empresa" → "Entidades conocidas"
2. Agrega "Omar Mira → owner" (socio)
3. Sistema guarda en Company Knowledge con `source: user_confirmed`
4. En la próxima detección, Omar Mira aparece pre-clasificado como owner

### 8.2 Aprendizaje por corrección (usuario corrige)

1. Sistema sugiere "Omar Mira → vendor"
2. Usuario cambia a owner
3. Sistema pregunta: "¿Guardar esto como conocimiento permanente?"
4. Si el usuario acepta, se guarda con `source: correction`

### 8.3 Aprendizaje por confirmación (usuario acepta)

1. Sistema sugiere "AMERICAN EXPRESS → credit_card_provider"
2. Usuario acepta
3. Sistema pregunta: "¿Confirmar que AMERICAN EXPRESS es una tarjeta de crédito?"
4. Si el usuario acepta, se guarda con `source: user_confirmed`

---

## 10. Flujo de Corrección

1. Editar una entrada existente (cambiar relación `relationship`, notas)
2. Archivar una entrada (el sistema vuelve a usar LLM para esa entidad)
3. Restaurar una entrada archivada

**Las correcciones tienen prioridad sobre cualquier aprendizaje automático.** Si el
usuario corrige "Omar Mira → vendor" después de haberlo tenido como owner, el
sistema usa vendor y no vuelve a sugerir owner para esa entidad.

---

## 11. Anti-patrones (lo que NO se debe hacer)

### 11.1 Hardcode global

```typescript
// ❌ MAL: Datos de una empresa específica en código global
const KNOWLEDGE: Record<string, string> = {
  'OMAR MIRA': 'owner',
  'AMERICAN EXPRESS': 'credit_card_provider',
};
```

### 11.2 JSON libre sin schema

```prisma
// ❌ MAL: metadata sin validación
model CompanyKnowledge {
  metadata  Json  // Sin schema por type = deuda técnica
}
```

### 11.3 Cache como conocimiento

```typescript
// ❌ MAL: Guardar sugerencias del LLM sin confirmación
if (llmConfidence > 0.95) {
  await saveAsCompanyKnowledge(entityName, llmRole);
}
```

### 11.4 Mezclar fuentes de autoridad

No guardar en la misma tabla: conocimiento confirmado por el usuario, reglas de
EntityContext, y sugerencias del LLM. Cada fuente tiene distinto nivel de autoridad.

### 11.5 Company Knowledge como regla contable

```typescript
// ❌ MAL: Company Knowledge no puede determinar cuentas
const account = await getAccountFromCompanyKnowledge(entityName);
```

### 11.6 Aprendizaje automático sin usuario

Company Knowledge nunca debe modificarse automáticamente. El sistema puede sugerir,
pero no confirmar.

---

## 12. Decisiones de Dominio Cerradas

| # | Pregunta | Decisión |
|---|----------|----------|
| 1 | Definición | Conocimiento confirmado sobre identidad y relaciones empresariales. No reglas contables, bancarias ni de conciliación |
| 2 | Qué NO guarda | 14 prohibiciones: cuentas, mapeos, asientos, reglas, matching, importes, prioridades, heurísticas, scoring, prompts, config LLM, tratamiento fiscal, auto-apply, credenciales |
| 3 | Separación | 3 capas: Company Knowledge (identidad) → EntityContext (comportamiento) → BankRule (acción contable). Ninguna absorbe responsabilidades de otra |
| 4 | Invariante 1 | Toda modificación requiere aprobación humana explícita |
| 5 | Invariante 2 | Conocimiento confirmado = Source of Truth (verdad conocida por la empresa, no verdad absoluta). Prioridad sobre inferencias. El LLM solo puede advertir inconsistencias |
| 6 | Estructura | Tabla única polimórfica con `type` discriminator + campos comunes tipados + metadata JSON validada por Zod por type. `relationship` en lugar de `role` |
| 7 | relationship vs role | Company Knowledge guarda `relationship` empresarial (owner, vendor, tenant...). Un mapper externo traduce a `EntityRole` para el motor bancario |
| 8 | Límites | 1,000 activas por empresa. Archivadas no cuentan. UI/API paginada con búsqueda |
| 9 | Herencia | No. 100% aislado por companyId. Templates copiables como capacidad futura |
| 10 | Importación | Reservado (`csv_import`) fuera de Fase 1 |
| 11 | Auditoría | Obligatoria en todo cambio. Sin hard delete, solo archive/restore |
| 12 | Detección | Servicio central reutilizable para onboarding y clasificación transaccional |
| 13 | Eliminación | Ciclo de vida idéntico a Company. AuditLog sigue política general del sistema |
| 14 | Unidad de conocimiento | Entidad canónica, no descripción bancaria. Aliases = `string[]` dentro de la entidad, no un tipo separado |
| 15 | Canonical Name | Sistema/LLM proponen, usuario confirma. Una vez confirmado, solo modificable por acción explícita auditada |
| 16 | Merge | Explícito y auditado. No automático. Merge nunca resuelve metadata conflictiva solo — usuario decide campo por campo. Aliases se combinan automáticamente. Referencias migradas al canónico destino |
| 17 | Prevención duplicados | Buscar canonicalName y aliases existentes antes de crear. Exacto → reusar. Alta similitud → bloquear. Media → advertir |
| 18 | Explicabilidad | Toda decisión del motor debe poder explicar su origen: company_knowledge, entity_context o llm, con knowledgeId, canonicalName, relationship y confidence |

---

## 13. Criterios de Aceptación para el SDD

- [ ] No hay nombres de entidades hardcodeados en el código fuente
- [ ] Cada empresa tiene su propio conocimiento aislado
- [ ] El conocimiento confirmado por el usuario tiene prioridad sobre el LLM
- [ ] El conocimiento se puede editar, corregir, archivar y restaurar
- [ ] Las correcciones del usuario mejoran futuras preclasificaciones
- [ ] Las sugerencias del LLM no se guardan como conocimiento sin confirmación
- [ ] La estructura soporta al menos 5 tipos de conocimiento (person, company, financial_product, platform, asset) más `aliases: string[]` como campo en la entidad canónica
- [ ] El sistema puede distinguir entre conocimiento confirmado, sugerido y aprendido por corrección (source)
- [ ] Company Knowledge nunca determina por sí solo el tratamiento contable
- [ ] La validación de metadata es por tipo via Zod, no JSON libre
- [ ] El matching es un servicio central reutilizable, no acoplado a clusterByBehavior()
- [ ] El LLM solo puede advertir inconsistencias, nunca modificar conocimiento confirmado
- [ ] La unidad de conocimiento es la entidad canónica, no descripciones bancarias
- [ ] Sistema/LLM proponen canonical name, usuario confirma
- [ ] Existe prevención de duplicados antes de crear nuevas entradas
- [ ] El merge es explícito, auditado y no automático
- [ ] Merge nunca resuelve metadata conflictiva solo — usuario decide campo por campo
- [ ] Toda decisión del motor puede explicar su origen: company_knowledge, entity_context o llm, con knowledgeId, canonicalName, relationship y confidence
