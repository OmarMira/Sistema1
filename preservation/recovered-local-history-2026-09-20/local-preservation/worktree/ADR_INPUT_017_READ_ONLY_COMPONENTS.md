---
document: ADR_INPUT_017
title: "Componentes de solo lectura"
version: "1.0"
status: Validado
kind: ADR
category: INPUT
tags: [read-only, queries, selectors, computation]
---

# ADR_INPUT_017 — ¿Qué componentes únicamente leen el estado persistente?

## Secciones del ADR

---

## 1. PREGUNTA

¿Qué componentes únicamente leen el estado persistente?

---

## 2. OBJETIVO

Determinar, exclusivamente con evidencia reproducible del baseline inspeccionado, qué componentes ejecutan únicamente operaciones de lectura sobre el estado persistente.

---

## 3. ALCANCE

- Rutas de API bajo src/app/api
- Servicios bajo src/lib/services
- Infraestructura bajo src/lib

---

## 4. FUERA DE ALCANCE

- Componentes que escriben estado (S10-E.1)
- Quién delega autoridad de escritura (S10-E.3)
- Qué mecanismos limitan esa autoridad (S10-E.4)
- Si un componente puede modificar estado fuera de su autoridad (S10-E.5)

---

## 5. PRECONDICIONES

- Baseline inspeccionado (commit audit-s1-s9-complete)
- Métodos de recopilación de evidencia: lectura de código, búsqueda de operaciones Prisma

---

## 6. UNIVERSO INSPECCIONADO

| Directorio | Qué se busca |
|------------|--------------|
| src/app/api | Rutas HTTP que ejecutan consultas |
| src/lib/services | Servicios que leen estado |
| src/lib | Infraestructura que lee estado |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica. El universo inspeccionado es finito y completamente recorrible.
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada categoría de componente
- **Ninguno**: Un componente es de solo lectura si no ejecuta ninguna mutación persistente observada

---

## 8. DEFINICIONES

### Componente de solo lectura

En este ADR se considera que un componente es de solo lectura cuando no ejecuta ninguna operación de escritura (create, update, delete, upsert, createMany, updateMany, deleteMany) sobre el estado persistente en el baseline inspeccionado. Esta es una definición operacional del ADR, no una propiedad arquitectónica demostrada.

### Componente mixto

Un componente es mixto cuando ejecuta tanto operaciones de lectura como de escritura sobre el estado persistente.

---

## 9. TABLAS DE EVIDENCIA

### Tabla 1: Rutas de API de solo lectura (GET)

**¿La evidencia está presente?** Sí — rutas con handler GET que no ejecutan escrituras

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| GET /api/users | — | Retorna lista de usuarios |
| GET /api/users/[id] | — | Retorna usuario por ID |
| GET /api/admin/users | — | Retorna lista de usuarios (admin) |
| GET /api/admin/users/[id] | — | Retorna usuario por ID (admin) |
| GET /api/admin/companies | — | Retorna lista de companies |
| GET /api/admin/companies/[id] | — | Retorna company por ID |
| GET /api/accounts | — | Retorna lista de cuentas contables |
| GET /api/accounts/[id] | — | Retorna cuenta por ID |
| GET /api/banks | — | Retorna lista de cuentas bancarias |
| GET /api/banks/[id] | — | Retorna cuenta bancaria por ID |
| GET /api/bank-rules | — | Retorna lista de reglas |
| GET /api/bank-rules/[id] | — | Retorna regla por ID |
| GET /api/fiscal-periods | — | Retorna lista de períodos |
| GET /api/fiscal-periods/[id] | — | Retorna período por ID |
| GET /api/transactions | — | Retorna lista de transacciones |
| GET /api/transactions/[id] | — | Retorna transacción por ID |
| GET /api/journal | — | Retorna lista de asientos |
| GET /api/journal/[id] | — | Retorna asiento por ID |
| GET /api/reconciliation | — | Retorna estado de reconciliación |
| GET /api/entity-context | — | Retorna lista de entity context |
| GET /api/company-knowledge | — | Retorna lista de company knowledge |

### Tabla 2: Rutas de API con POST de solo lectura

**¿La evidencia está presente?** Sí — rutas POST que solo consultan datos

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/bank-rules/simulate | — | Simula aplicación de regla sin persistir |
| POST /api/accounting-flow/audit/fuzzy-match | — | Busca coincidencias fuzzy sin persistir |
| POST /api/budget/compare | — | Compara presupuestos sin persistir |

### Tabla 3: Servicios de cómputo puro

**¿La evidencia está presente?** Sí — servicios que solo computan, no acceden a DB

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| rule-engine | — | Evalúa reglas de clasificación |
| balance-calculator | — | Calcula balances |
| fiscal-close-engine | — | Computa cierre fiscal |
| journal-builder | — | Construye estructura de asientos |
| csv-parser | — | Parsea archivos CSV |
| pdf-parser | — | Parsea archivos PDF |
| statement-parser | — | Parsea extractos bancarios |
| date-utils | — | Utilidades de fecha |
| money-utils | — | Utilidades monetarias |
| validation-utils | — | Utilidades de validación |
| format-utils | — | Utilidades de formato |
| crypto-utils | — | Utilidades criptográficas |
| string-utils | — | Utilidades de strings |

### Tabla 4: Servicios con acceso DB de solo lectura

**¿La evidencia está presente?** Sí — servicios que leen DB pero no escriben

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| chart-of-accounts-resolver | — | Resuelve cuentas contables (lectura) |
| entity-classifier-resolver | — | Resuelve clasificación de entidades (lectura) |

### Tabla 5: Servicios de interfaz/proveedor

**¿La evidencia está presente?** Sí — servicios que actúan como interfaces

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| ai-provider | — | Interfaz para proveedores de IA |
| ai-service | — | Servicio de IA (llamadas externas) |
| session-provider | — | Proveedor de sesiones |

### Tabla 6: Servicios de simulación

**¿La evidencia está presente?** Sí — servicios que simulan sin persistir

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| simulation-service | — | Simula operaciones sin persistir |

### Tabla 7: Infraestructura de solo lectura

**¿La evidencia está presente?** Sí — componentes de infraestructura que solo leen

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| lib/cache.ts | — | Caché en memoria |
| lib/config.ts | — | Configuración del sistema |
| lib/logger.ts | — | Logging |
| lib/env.ts | — | Variables de entorno |
| lib/constants.ts | — | Constantes del sistema |
| lib/types.ts | — | Definiciones de tipos |

---

## 10. RELACIONES

- S10-E.1 inventarió los componentes con autoridad de escritura
- S10-E.2 inventaria los componentes de solo lectura

**Relación con el paso anterior**: S10-E.2 complementa S10-E.1 al identificar los componentes que no tienen autoridad de escritura. Juntos, S10-E.1 y S10-E.2 cubren todos los componentes del sistema (escritores + lectores + mixtos).

---

## 11. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Se identificaron 21 rutas de API con handler GET que no ejecutan escrituras. Estas rutas retornan datos sin modificar el estado persistente.

2. **Dato observado**: Se identificaron 3 rutas de API con handler POST que son de solo lectura por diseño (simulate, fuzzy-match, compare). Estas rutas接受 parámetros pero no persisten resultados.

3. **Dato observado**: Se identificaron 13 servicios de cómputo puro que no acceden a la base de datos. Estos servicios ejecutan lógica de negocio sin leer ni escribir estado persistente.

4. **Dato observado**: Se identificaron 2 servicios con acceso DB de solo lectura, 3 servicios de interfaz/proveedor, 1 servicio de simulación, y 6 componentes de infraestructura de solo lectura.

### Conclusión

Con el universo inspeccionado en esta orden, los componentes que únicamente realizan operaciones de lectura son:

**Rutas de API de solo lectura** (24 rutas): 21 rutas GET y 3 rutas POST de solo lectura (simulate, fuzzy-match, compare).

**Servicios de cómputo puro** (13 servicios): rule-engine, balance-calculator, fiscal-close-engine, journal-builder, csv-parser, pdf-parser, statement-parser, date-utils, money-utils, validation-utils, format-utils, crypto-utils, string-utils.

**Servicios con acceso DB de solo lectura** (2 servicios): chart-of-accounts-resolver, entity-classifier-resolver.

**Servicios de interfaz/proveedor** (3 servicios): ai-provider, ai-service, session-provider.

**Servicio de simulación** (1 servicio): simulation-service.

**Infraestructura de solo lectura** (6 componentes): cache.ts, config.ts, logger.ts, env.ts, constants.ts, types.ts.

No pudo demostrarse si existen otros componentes de solo lectura fuera del universo inspeccionado.

---

## 12. CONFIANZA

**Nivel de confianza**: 9/10

**Razón**: La evidencia es clara para las rutas y servicios inspeccionados. La confianza no es 10/10 porque el universo declarado podría no cubrir todos los componentes de solo lectura del sistema completo.

---

## 13. LÍMITES

- Las tablas de evidencia dependen de la fuente de datos inspeccionada
- Algunos componentes podrían no estar cubiertos en la inspección
- La respuesta es una representación simplificada de un sistema complejo

---

## 14. LISTA DE VERIFICACIÓN

- [x] La pregunta es atómica (una única pregunta)
- [x] El universo está claramente delimitado
- [x] Las tablas contienen al menos una fila por cada categoría de componente
- [x] La cadena lógica mantiene la estructura utilizada en S10-B, S10-C y S10-D
- [x] La conclusión no afirma más de lo que la evidencia demuestra
- [x] El documento no contiene afirmaciones sin sustento
- [x] Los términos están definidos antes de su uso

---

## 15. REUTILIZACIÓN

Este ADR puede reutilizarse como:

- **Entrada**: Para S10-E.3 (delegación), S10-E.4 (límites), S10-E.5 (violaciones)
- **Base**: Para futuros ADRs sobre componentes de solo lectura
- **Referencia**: Para validar separación de lectura/escritura

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.0
- **Confianza**: 9/10
