# Diseño del Proceso de Onboarding de Entidades

> **Referencia histórica de arquitectura.** Rescatado de `feat/entities-bank-rules`.
> Algunos detalles de implementación pueden ya no coincidir con `main` (Jul 2026).

> **Propósito**: Guiar al usuario en la clasificación correcta de entidades para que el generador de reglas bancarias produzca resultados precisos.

---

## Índice

1. [Filosofía del Diseño](#1-filosofía-del-diseño)
2. [Flujo General](#2-flujo-general)
3. [Paso a Paso Detallado](#3-paso-a-paso-detallado)
   - [3.1 Detección de Candidatos](#31-detección-de-candidatos)
   - [3.2 Cards de Entidad con Contexto](#32-cards-de-entidad-con-contexto)
   - [3.3 Asistencia de IA para OTRO](#33-asistencia-de-ia-para-otro)
   - [3.4 Validación y Guardado](#34-validación-y-guardado)
4. [Pipeline de Sugerencia AI](#4-pipeline-de-sugerencia-ai)
5. [Feedback Loop y Mejora Continua](#5-feedback-loop-y-mejora-continua)
6. [Integración con Reglas Contables](#6-integración-con-reglas-contables)
7. [Estados y Casos Borde](#7-estados-y-casos-borde)
8. [Arquitectura Técnica](#8-arquitectura-técnica)
9. [Métricas de Calidad](#9-métricas-de-calidad)
10. [Roadmap de Implementación](#10-roadmap-de-implementación)

---

## 1. Filosofía del Diseño

El proceso de onboarding de entidades tiene UN objetivo: **que el rule generator downstream produzca reglas perfectas sin intervención humana**.

Para eso, el sistema debe:

1. **Reducir la fricción al mínimo** — el usuario no es contador, no sabe de débitos/créditos. El sistema debe guiarlo.
2. **Dar contexto en el momento exacto** — mostrar la dirección contable, ejemplos de transacciones, y advertencias cuando corresponda, no antes ni después.
3. **Auto-corregirse** — si la IA se equivoca, el sistema debe aprender de la corrección.
4. **Nunca guardar datos inconsistentes** — si el rol no coincide con la dirección contable, el sistema debe bloquear o exigir confirmación explícita.
5. **Mostrar confianza** — decirle al usuario qué tan seguro está el sistema de cada sugerencia.

---

## 2. Flujo General

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          1. DETECCIÓN                                    │
│   Usuario importa transacciones → sistema detecta entidades candidatas  │
│   → clustering por nombre normalizado → compute direction profile       │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       2. ONBOARDING MODAL                                │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │  Card: "MERCADO PAGO" · 15 transacciones · 🔵 Crédito 80%       │   │
│   │  ┌─────────────────────────────────────────────────────────────┐ │   │
│   │  │  Rol: [PROVEEDOR ▼]   ✓ Dirección coincide                 │ │   │
│   │  │  Descripción: "pagos a proveedor de servicios de pago"     │ │   │
│   │  └─────────────────────────────────────────────────────────────┘ │   │
│   │                                                                  │   │
│   │  Card: "JUAN PEREZ" · 3 transacciones · 🔴 Débito 95%           │   │
│   │  ┌─────────────────────────────────────────────────────────────┐ │   │
│   │  │  Rol: [OTRO ▼]   ⚠️ Sin clasificar                         │ │   │
│   │  │  ┌─ Sugerencia AI ───────────────────────────────────────┐  │ │   │
│   │  │  │ "pago de sueldos y salarios mensuales"               │  │ │   │
│   │  │  │ 🤖 → EMPLEADO (92%) · [Asignar] [Descartar]         │  │ │   │
│   │  │  └──────────────────────────────────────────────────────┘  │ │   │
│   │  └─────────────────────────────────────────────────────────────┘ │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│   [✅ Clasificar 7 entidades]                                            │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   3. POST-PROCESAMIENTO                                  │
│   Guardar EntityContext → actualizar signal-collector                    │
│   → ConversationalRuleBuilder muestra entidades listas                   │
│   → Usuario confirma reglas → BankRule creada                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Paso a Paso Detallado

### 3.1 Detección de Candidatos

**Trigger**: El usuario completa una importación de transacciones bancarias.

**Proceso**:

1. `entity-detector.clusterCandidates()` procesa las últimas 2,000 transacciones
2. Normaliza nombres (mayúsculas, sin espacios extra, sin números de referencia)
3. Agrupa por nombre canónico
4. Calcula `directionProfile`:
   - `creditPct` = transacciones como crédito / total
   - `debitPct` = transacciones como débito / total
5. Ejecuta heurística `getDefaultRole()`:
   - Busca keywords en el nombre canónico (ej: "ALQUILER" → INQUILINO, "SUELDO" → EMPLEADO)
   - Si match → sugiere ese rol como default
   - Si no match → OTRO (requiere asistencia AI)
6. Filtra entidades que ya tienen `EntityContext` (no mostrar de nuevo)
7. Retorna `EntityCandidate[]` ordenado por `occurrences` descendente

**API**: `GET /api/learning/classify-entity?companyId=X` (ya existe)

**Mejora propuesta**: Agregar un campo `suggestedRole` y `suggestedRoleConfidence` al `EntityCandidate` para que el frontend muestre el default role estimado sin llamada extra.

### 3.2 Cards de Entidad con Contexto

Cada card muestra:

| Elemento | Propósito | Regla de negocio |
|----------|-----------|------------------|
| **Nombre canónico** | Identificar la entidad | Texto plano, sin editar |
| **Contador** | "15 transacciones" | Ayuda a priorizar qué clasificar primero |
| **Badge de dirección** | 🔵 Crédito / 🔴 Débito / 🟣 Mixto | `> 70%` de un lado → puro; si ambos ≥ 15% → mixto (con split) |
| **Gráfico de dirección** | Barra visual crédito/débito | Siempre visible, ayuda a decidir el rol |
| **Sample descriptions** | 2-3 transacciones de ejemplo | El usuario reconoce la entidad |
| **Role dropdown** | Selector de rol | Filtra IGNORADA del dropdown principal |
| **Direction warning** | Solo si mismatch | El rol no coincide con la dirección predominante |
| **Split UI** | Solo si mixto y no-split | 3 opciones: solo créditos, solo débitos, ambos |
| **OTRO textarea** | Solo si rol=OTRO | Con asistencia AI integrada |

**Reglas de UI**:

- Las cards se ordenan por `occurrences` descendente (las más importantes primero)
- El scrolling es infinito dentro del modal
- Cada card es independiente — cambiar el rol de una no afecta a las demás
- El botón "Clasificar X entidades" está siempre visible en el footer

### 3.3 Asistencia de IA para OTRO

**Flujo actual** (ya implementado):

```
Usuario selecciona OTRO
  → Aparece textarea con placeholder "Describe what this entity is..."
  → Usuario escribe (sin debounce, mínimo 5 caracteres)
  → POST /api/learning/suggest-role
  → Si confidence ≥ 0.7:
      → Toast: "🤖 Sugerencia: PARECE SER PROVEEDOR (92%)"
      → Auto-asigna PROVEEDOR inmediatamente
      → Toast visible 6s con opción [Deshacer]
  → Si confidence < 0.7:
      → Toast: "No pudimos determinar el rol, describí más"
      → Textarea sigue activo
  → Si 2 intentos seguidos fallan (confidence < 0.7):
      → Toast: "Sugerencia desactivada, seleccioná manualmente"
      → Textarea se desactiva
```

**Mejora propuesta** — Enriquecer el prompt de AI con contexto contable:

```typescript
// Lo que envía HOY:
{ description: "pago a proveedores de insumos" }

// Lo que DEBERÍA enviar:
{
  description: "pago a proveedores de insumos",
  directionProfile: { creditPct: 0.05, debitPct: 0.95 },
  sampleDescriptions: ["PAGO PROVEEDOR INSUMOS", "XFER PROVEEDOR INSUMOS"],
  existingRoles: ["PROVEEDOR", "CLIENTE", "EMPLEADO"] // roles ya usados en esta empresa
}
```

Esto permite que la IA razone mejor:
- "Es 95% débito → probablemente PROVEEDOR, EMPLEADO, GASTO_OPERATIVO"
- "Las descripciones dicen 'PAGO' → descarta CLIENTE, INGRESO"
- "La empresa ya tiene PROVEEDOR → alta confianza"

**El toast de sugerencia debe incluir**:

```
┌──────────────────────────────────────────────────┐
│ 🤖  Sugerencia: PROVEEDOR (92% de confianza)     │
│                                                   │
│     Coincide con:                                 │
│     • 95% de las transacciones son DÉBITO         │
│     • Descripción: "pago de insumos"              │
│     • 3 entidades similares ya son PROVEEDOR      │
│                                                   │
│  [✅ Asignar]  [❌ Descartar]  [✏️ Corregir]      │
└──────────────────────────────────────────────────┘
```

- ✅ **Asignar** → auto-asigna (comportamiento actual)
- ❌ **Descartar** → descarta esta sugerencia, no volver a mostrar para esta entidad
- ✏️ **Corregir** → abre un selector rápido con los roles más probables

### 3.4 Validación y Guardado

**Pipeline de validación antes de guardar** (orden estricto):

```
1. ¿El rol es válido?
   → Zod schema: entityRoleSchema.safeParse(role)
   → Si falla → BLOQUEAR

2. ¿Es OTRO?
   → OTRO nunca se guarda → SKIP (con toast informativo)

3. ¿El rol coincide con la dirección contable?
   → EXPECTED_DIRECTION[role] vs directionProfile
   → Si mismatch → ¿usuario hizo override explícito?
     → No → MOSTRAR WARNING + BLOQUEAR
     → Sí → PERMITIR con flag directionOverride

4. ¿La entidad tiene split?
   → split = 'credit' → guardar como "${pattern} - ingresos"
   → split = 'debit' → guardar como "${pattern} - retiros"
   → split = 'both' → guardar entidad completa sin split

5. ¿La cuenta contable existe?
   → glAccountId de ROLE_ACCOUNT_MAP[role]
   → Si no existe en DB → CREAR cuenta por defecto + flag pendiente
   → (No bloquear, pero marcar para revisión)

6. Guardar:
   → POST /api/learning/classify-entity
   → Upsert EntityContext
```

**Save button**:

- Estado por defecto: `"Clasificar X entidades"` (X = entidades que se guardarán)
- Si X = 0 → botón deshabilitado (todas OTRO o vacías)
- Al hacer clic:
  1. Disparar sugerencias AI pendientes (abort + refire si ya en vuelo)
  2. Esperar a que todas resuelvan
  3. Auto-asignar sugerencias high-confidence que lleguen
  4. Ejecutar pipeline de validación
  5. Guardar lote
  6. Toast con resultado detallado

**Toast de resultado**:

```
✅ ¡Clasificación completada!

• 5 entidades clasificadas correctamente
• 2 entidades omitidas (rol OTRO sin descripción suficiente)
• 1 advertencia: "MERCADO PAGO" tiene dirección mixta, revisar split
```

---

## 4. Pipeline de Sugerencia AI

### Arquitectura

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Frontend     │────▶│  suggest-role   │────▶│    AI Model   │
│  (React)      │     │  (API Route)    │     │  (LLM)        │
└──────────────┘     └─────────────────┘     └──────────────┘
       │                      │                       │
       │ AbortController       │ prompt injection      │ response:
       │ + loadingRef          │ detection             │ { suggestedRole,
       │ + firedTexts          │ + timeout 10s         │   confidence,
       │                       │ + fallback model      │   explanation }
                               │
                               ▼
                     ┌─────────────────┐
                     │  Response        │
                     │  Validation      │
                     │  (Zod)           │
                     └─────────────────┘
```

### Prompt Engineering (versión mejorada)

```
You are a financial entity classification assistant.
Given a description of a business entity and its transaction profile,
determine the most likely accounting role.

## Available Roles
- CLIENTE: Customers who pay for products/services (expects CREDIT transactions)
- PROVEEDOR: Suppliers/vendors (expects DEBIT transactions)
- EMPLEADO: Employees receiving salary (expects DEBIT transactions)
- INQUILINO: Rent/lease tenants (expects CREDIT transactions)
- SOCIO: Business partners with mixed activity (expects BOTH credits and debits)
- TARJETA_CREDITO: Credit card payments (expects DEBIT transactions)
- PRESTAMO: Loan payments (expects DEBIT transactions)
- GASTO_OPERATIVO: Operational expenses (expects DEBIT transactions)
- INGRESO: Revenue entries (expects CREDIT transactions)

## Context (provided by the system)
- Direction profile: {creditPct, debitPct}
- Sample transaction descriptions
- Roles already used by this company

## Classification Rules
1. 95%+ debit → prefer PROVEEDOR, EMPLEADO, GASTO_OPERATIVO
2. 95%+ credit → prefer CLIENTE, INGRESO
3. Mixed (~50/50) → consider SOCIO
4. Description keywords matter:
   - "sueldo", "salario", "nomina" → EMPLEADO
   - "alquiler", "renta" → INQUILINO
   - "proveedor", "insumo", "mercaderia" → PROVEEDOR
   - "cliente", "venta", "factura" → CLIENTE
5. Return confidence > 0.9 only when VERY certain
```

**Mejora**: Versionar el prompt en `prompts/suggest-role-v2.txt` para poder iterar sin tocar código.

### Lógica de Confianza

| Confianza | Comportamiento |
|-----------|----------------|
| ≥ 0.9 | Auto-asignar + toast informativo |
| 0.7 – 0.89 | Auto-asignar + toast con opción [Deshacer] |
| 0.5 – 0.69 | Mostrar sugerencia sin auto-asignar (usuario decide) |
| < 0.5 | No mostrar, pedir más descripción |

---

## 5. Feedback Loop y Mejora Continua

### Registro de Desacuerdos

Cuando el usuario descarta una sugerencia o corrige manualmente:

```sql
CREATE TABLE entity_suggestion_feedback (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  description   TEXT NOT NULL,
  suggested_role TEXT NOT NULL,
  chosen_role   TEXT NOT NULL,
  confidence    REAL NOT NULL,
  reason        TEXT,  -- "wrong_direction" | "wrong_role" | "other"
  created_at    DATETIME DEFAULT NOW()
);
```

### Dashboard de Precisión (futuro)

```
┌─────────────────────────────────────────────────┐
│  Precisión de Sugerencias AI                     │
│                                                  │
│  ████████████████████░░░░  85% (últimos 7 días)  │
│                                                  │
│  Por rol:                                        │
│  PROVEEDOR  █████████████████████  92%           │
│  CLIENTE    ██████████████████░░  81%            │
│  EMPLEADO   ████████████████████  88%            │
│  INQUILINO  ██████████████░░░░░░  70%            │
│  SOCIO      ████████████████░░░░  75%            │
│                                                  │
│  Top errores:                                    │
│  • SOCIO ↔ CLIENTE (12 casos)                    │
│  • INQUILINO ↔ PROVEEDOR (8 casos)               │
└─────────────────────────────────────────────────┘
```

### Estrategia de Mejora

1. Cada `entity_suggestion_feedback` se usa para ajustar el prompt (few-shot examples negativos)
2. Si un rol específico tiene precisión < 75%, el sistema agrega ese contexto al prompt
3. Si la precisión global cae < 80%, se alerta al admin

---

## 6. Integración con Reglas Contables

### Flujo Post-Clasificación

```
EntityContext guardado
       │
       ▼
signal-collector.ts
  → Próxima transacción de esa entidad
  → Matchea por pattern + companyId
  → Calcula confianza basada en:
      • role coincide con direction esperada
      • glAccount existe
      • source = 'user' (máxima confianza)
  → decision-engine: EntityContext ≥ 0.7 → usar contexto
       │
       ▼
ConversationalRuleBuilder
  → El usuario ve: "MERCADO PAGO → PROVEEDOR (cuenta 6070)"
  → Puede confirmar la regla → POST /api/learning/rules
  → Crea BankRule con debitGlAccountId / creditGlAccountId
       │
       ▼
Próximas transacciones
  → BankRule aplica automáticamente
  → Transacción clasificada sin intervención humana
```

### Validación Cruzada en el Rule Builder

El `ConversationalRuleBuilder` debe mostrar, para cada entidad:

```
┌────────────────────────────────────────────────────┐
│  MERCADO PAGO                                      │
│  Rol: PROVEEDOR (del onboarding)                    │
│  Dirección: 95% débito ✓                           │
│                                                     │
│  Cuenta contable sugerida:                          │
│  Débito:  6070 - Costo de Ventas                   │
│  Crédito: 6070 - Costo de Ventas                   │
│                                                     │
│  [✓ Confirmar regla]  [✏️ Ajustar cuenta]          │
└────────────────────────────────────────────────────┘
```

Si en el onboarding el usuario hizo `directionOverride`, el rule builder debe mostrar un banner:

```
⚠️ Esta entidad se clasificó como CLIENTE pero el 80%
de sus transacciones son DÉBITOS. La regla generada
puede no ser precisa. [Revisar clasificación]
```

---

## 7. Estados y Casos Borde

### Estados del Modal

| Estado | Qué se muestra |
|--------|----------------|
| **Loading** | Skeleton de 3 cards + spinner |
| **Empty** | "✅ No hay entidades sin clasificar" |
| **Error** | "❌ Error al cargar entidades. [Reintentar]" |
| **Lista parcial** | Cards visibles mientras algunas fallan → error inline por card |
| **Guardando** | Botón muestra spinner + "Guardando..." + cards se deshabilitan |
| **Guardado exitoso** | Toast + cierre automático del modal (2s) |
| **Guardado parcial** | Toast con detalle de cuáles fallaron |
| **Sin cambios** | Botón deshabilitado si todas OTRO |

### Casos Borde

| Caso | Comportamiento |
|------|---------------|
| **Usuario escribe muy rápido** | Cada keystroke aborta la request anterior (ya implementado) |
| **API de AI falla (timeout/500)** | Toast de error, textarea sigue activo, reintentar al siguiente keystroke |
| **AI retorna rol inválido** | Validación Zod → toast "Sugerencia inválida, intentá de nuevo" |
| **Usuario cierra modal mientras se guarda** | Confirmación: "¿Cancelar? Hay cambios sin guardar" |
| **Dos usuarios clasifican la misma entidad** | Unique constraint [companyId, pattern] → upsert, gana el último |
| **Entidad con 0 transacciones** | No aparece como candidata (filtro natural) |
| **Todas las entidades ya clasificadas** | Empty state, modal no se abre |
| **Usuario cambia rol manualmente mientras AI procesa** | AbortController cancela, no sobreescribe (ya implementado) |
| **Split cambiado mientras hay sugerencia** | AbortController cancela, textarea se oculta si ya no es OTRO |
| **Red se cae durante guardado** | Toast error, reintentar al hacer clic de nuevo |
| **Descripción vacía + OTRO** | Textarea placeholder + save button deshabilitado |
| **Confianza AI = exactamente 0.7** | Se auto-asigna (≥ 0.7) |
| **Prompt injection detectada** | API retorna 400, toast "Descripción inválida" |

---

## 8. Arquitectura Técnica

### Capas

```
┌────────────────────────────────────────────────────────────┐
│                     FRONTEND (React)                        │
│  EntityOnboardingModal                                      │
│  ├── useRef: selectionsRef, loadingRef, abortControllers   │
│  ├── useState: selections, descriptions, splits, warnings  │
│  ├── fireSuggestion() → POST /api/learning/suggest-role    │
│  ├── handleClassifyAll() → POST /api/learning/classify-entity│
│  └── autoAssignPendingSkipped()                            │
├────────────────────────────────────────────────────────────┤
│                     API LAYER (Next.js)                     │
│  GET  /api/learning/classify-entity                        │
│  POST /api/learning/classify-entity                        │
│  POST /api/learning/suggest-role                           │
│  └── apiHandler middleware (auth, rate limit, validation)   │
├────────────────────────────────────────────────────────────┤
│                     SERVICE LAYER                           │
│  entity-detector.ts  → clustering + direction profile       │
│  entity-classifier.ts → save EntityContext                 │
│  entity-context-service.ts → Prisma queries                 │
│  role-account-map.ts → GL account mapping                   │
├────────────────────────────────────────────────────────────┤
│                     DATA LAYER (PostgreSQL)                 │
│  EntityContext table                                        │
│  BankRule table                                            │
│  GLAccount table                                           │
├────────────────────────────────────────────────────────────┤
│                     EXTERNAL                                │
│  AI Model (LLM) via fetch                                  │
└────────────────────────────────────────────────────────────┘
```

### Mejoras Técnicas Propuestas

1. **Unificar `EXPECTED_DIRECTION` y `ROLE_ACCOUNT_MAP.expectedDirection`** en una sola fuente de verdad
2. **Extraer `getDefaultRole()` al server** como endpoint o función compartida ([pattern] + [directionProfile] → EntityRole)
3. **Agregar `suggestedRole` al response de `GET /api/learning/classify-entity`** para evitar llamada extra
4. **Agregar tabla `EntitySuggestionFeedback`** para el feedback loop
5. **Centralizar `splitAccountTypes`** en `lib/entity-roles.ts` como función compartida
6. **Versionar prompts de AI** en `prompts/` para iterar sin tocar código de ruta

---

## 9. Métricas de Calidad

Para saber que el módulo está funcionando bien:

| Métrica | Cómo se mide | Objetivo |
|---------|-------------|----------|
| **% de entidades clasificadas sin intervención** | Auto-asignadas / total OTRO | > 60% |
| **Precisión de sugerencias AI** | Aceptadas / (Aceptadas + Rechazadas) | > 85% |
| **% de reglas generadas sin editar** | Reglas sin modificar / total reglas | > 80% |
| **Tiempo promedio por entidad** | Desde que abre modal hasta que guarda | < 30s |
| **% de warnings de dirección ignorados** | Override / total mismatches | < 20% |
| **Tasa de corrección post-clasificación** | EntityContext modificados / total | < 5% |

---

## 10. Roadmap de Implementación

### Fase 1 — Base sólida (✅ ya implementado)
- [x] Modal de onboarding con cards de entidad
- [x] Role dropdown con validación ENTITY_ROLES
- [x] Direction mismatch warning (F2)
- [x] Split UI para entidades mixtas (F3)
- [x] AI suggestion flow (F4) con AbortController
- [x] Auto-assign en high confidence
- [x] Pipeline de guardado con validaciones
- [x] Tests: 14/14 pasando

### Fase 2 — Calidad de sugerencia (próximo)
- [ ] Enriquecer prompt AI con directionProfile
- [ ] Enriquecer prompt AI con sampleDescriptions
- [ ] Enriquecer prompt AI con existingRoles de la empresa
- [ ] Agregar [Deshacer] al toast de auto-asignación
- [ ] Agregar feedback buttons (✅ ❌ ✏️) al toast de sugerencia
- [ ] Guardar feedback en tabla EntitySuggestionFeedback

### Fase 3 — UX y validación
- [ ] Placeholder y ejemplos en textarea OTRO
- [ ] Validador de calidad de descripción (muy corta → warning)
- [ ] Bloqueo de incompatibilidad rol ↔ dirección (sin override no se guarda)
- [ ] Gráfico visual de dirección crédito/débito en cada card
- [ ] Empty, error, loading states pulidos

### Fase 4 — Feedback loop y monitoreo
- [ ] Dashboard de precisión de sugerencias
- [ ] Ajuste automático de prompt basado en feedback
- [ ] Alertas cuando precisión cae de umbral
- [ ] Estadísticas de uso (cuántas entidades clasificadas, tiempo promedio)
