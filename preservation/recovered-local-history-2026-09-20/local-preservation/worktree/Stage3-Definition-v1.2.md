# Stage 3 Definition v1.2

**Fecha:** 2026-09-08
**Estado:** Aprobado — Línea Base Oficial de la Etapa 3
**Aprobado por:** Dirección (2026-09-08)
**Fuentes oficiales:** conocimiento-general.md v1.11, knowledge-engine-principles.md v3.0, Knowledge Engine Contract v0.1, Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07)

---

## 1. Nombre oficial

**Etapa 3 — Modelo Conceptual del Knowledge Engine**

---

## 2. Objetivo

Definir el **modelo conceptual del Knowledge Engine**, estableciendo cuál es su unidad conceptual fundamental y cómo se organiza el conocimiento empresarial que administrará, sin diseñar todavía la arquitectura técnica, las estructuras de datos, las APIs ni la implementación.

La Etapa 3 deberá producir un modelo conceptual suficientemente definido para que la Etapa 4 pueda diseñar la arquitectura del Knowledge Engine sobre una base conceptual estable.

---

## 3. Alcance

La Etapa 3 comprende exclusivamente la definición del **modelo conceptual del Knowledge Engine**.

Dentro de este alcance se incluye:

* definir la unidad conceptual fundamental que administrará el Knowledge Engine;
* definir los conceptos que componen dicha unidad;
* definir las relaciones conceptuales entre esos conceptos;
* definir los estados conceptuales y las transiciones válidas;
* definir las reglas conceptuales que gobernarán la evolución del conocimiento;
* producir un modelo conceptual coherente que sirva como línea base para el diseño posterior.

Queda expresamente fuera del alcance de la Etapa 3:

* el diseño de la arquitectura del Knowledge Engine;
* la definición de componentes de software;
* la definición de estructuras de datos;
* la definición de tablas o bases de datos;
* la definición de APIs;
* la implementación de código;
* la integración con Rule Engine, IA, parser o cualquier otro subsistema.

La Etapa 3 concluye con un **modelo conceptual**. La transformación de ese modelo en un motor pertenece a la etapa siguiente.

---

## 4. Entradas oficiales

| Fuente | Estado actual | Fuente |
|--------|---------------|--------|
| conocimiento-general.md v1.11 | Congelado — Contrato Conceptual Permanente | conocimiento-general.md v1.11, línea 6 |
| knowledge-engine-principles.md v3.0 | Borrador — pendiente aprobación | knowledge-engine-principles.md v3.0, línea 6 |
| Knowledge Engine Contract v0.1 | Borrador | Knowledge Engine Contract v0.1, línea 6 |
| Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07) | Consolidado | Mapa de Estado del Conocimiento — Etapa 2, línea 44 |

---

## 5. Restricciones heredadas

| Restricción | Fuente | Evidencia textual |
|-------------|--------|-------------------|
| knowledge-engine-principles.md v3.0 debe aprobarse antes de iniciar la Fase 2 (Modelo Conceptual) | knowledge-engine-principles.md v3.0 | Línea 502: "Hasta esa aprobación, no se inicia la Fase 2 (Modelo Conceptual)." |

---

## 6. Preguntas abiertas heredadas

| # | Pregunta | Fuente |
|---|----------|--------|
| 1 | ¿Cuál es la unidad conceptual mínima del conocimiento? | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07), §Pregunta central de la Etapa 2 |

---

## 7. Salida esperada

La Etapa 3 deberá producir el **Modelo Conceptual del Knowledge Engine**.

Ese modelo conceptual constituirá la línea base oficial para el diseño posterior del motor.

Como mínimo deberá definir:

* la unidad conceptual administrada por el Knowledge Engine;
* los conceptos que la componen;
* las relaciones entre dichos conceptos;
* los estados conceptuales posibles;
* las transiciones válidas entre estados;
* las reglas conceptuales que gobiernan la evolución del conocimiento.

La salida de la Etapa 3 es exclusivamente un **artefacto conceptual**.

No forma parte de esta salida:

* arquitectura del motor;
* componentes de software;
* estructuras de datos;
* tablas;
* clases;
* APIs;
* implementación;
* decisiones tecnológicas.

---

## 8. Criterio oficial de finalización

La **Etapa 3** se considerará oficialmente finalizada cuando se hayan cumplido todas las condiciones siguientes:

1. El **Modelo Conceptual del Knowledge Engine** esté completamente definido.
2. La unidad conceptual fundamental del Knowledge Engine esté definida.
3. Los conceptos que integran dicha unidad estén definidos.
4. Las relaciones conceptuales entre esos conceptos estén definidas.
5. Los estados conceptuales del conocimiento estén definidos.
6. Las transiciones válidas entre estados estén definidas.
7. Las reglas conceptuales de evolución del conocimiento estén definidas.
8. No existan contradicciones documentadas dentro del modelo conceptual.
9. El modelo conceptual haya sido revisado y aprobado por Dirección como línea base oficial para la Etapa 4.

---

## Observaciones metodológicas

### Observación 1 — Consistencia de nomenclatura

En este documento aparece la restricción:

> "knowledge-engine-principles.md v3.0 debe aprobarse antes de iniciar la Fase 2 (Modelo Conceptual)."

Mientras que el nombre oficial de este documento es:

> **Etapa 3 — Modelo Conceptual del Knowledge Engine**

Existe una inconsistencia de nomenclatura entre "Fase 2 (Modelo Conceptual)" y "Etapa 3 — Modelo Conceptual del Knowledge Engine". Conviene revisar la nomenclatura del proyecto para evitar confusión futura.

### Observación 2 — Congelación de la línea base

Este documento fue congelado como **Línea Base Oficial de la Etapa 3** el 2026-09-08. Cualquier modificación futura deberá tratarse como una nueva versión (v1.3 o superior), preservando la trazabilidad.

---

**Documento:** Stage 3 Definition v1.2
**Estado:** Aprobado — Línea Base Oficial de la Etapa 3
**Congelado:** 2026-09-08
