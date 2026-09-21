# Knowledge Engine — Contrato v0.1

**Versión:** 0.1
**Fecha:** 2026-09-07
**Estado:** Borrador
**Fuentes oficiales:** conocimiento-general.md v1.11, Resultados consolidados Etapa 2, Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07), knowledge-engine-principles.md v3.0

---

## 1. Propósito

| Función declarada | Fuente |
|-------------------|--------|
| "El Knowledge Engine es el subsistema responsable de adquirir, validar, almacenar, evolucionar, explicar y suministrar conocimiento empresarial persistente." | knowledge-engine-principles.md v3.0, línea 12 |
| "No es un motor de reglas. No es un sistema de inferencia. No es un cache. Es la memoria empresarial: aquello que el negocio sabe sobre sí mismo." | knowledge-engine-principles.md v3.0, líneas 14-20 |

---

## 2. Alcance

### 2.1 Funciones declaradas en las fuentes oficiales

| Función | Fuente |
|---------|--------|
| Adquirir conocimiento | knowledge-engine-principles.md v3.0, línea 12 |
| Validar conocimiento | knowledge-engine-principles.md v3.0, línea 12 |
| Almacenar conocimiento | knowledge-engine-principles.md v3.0, línea 12 |
| Evolucionar conocimiento | knowledge-engine-principles.md v3.0, línea 12 |
| Explicar conocimiento | knowledge-engine-principles.md v3.0, línea 12 |
| Suministrar conocimiento | knowledge-engine-principles.md v3.0, línea 12 |

### 2.2 Límites declarados en las fuentes oficiales

| Límite | Fuente |
|--------|--------|
| "No puede: tomar decisiones contables, aprobar transacciones, reemplazar el juicio humano en situaciones nuevas o ambiguas, predecir el futuro, aprender de datos que no existen, garantizar que todo conocimiento aprendido sea correcto, funcionar sin la supervisión de una autoridad humana." | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| "No pretende resolver: complejidad contable, cumplimiento regulatorio, decisiones estratégicas, situaciones sin precedentes." | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| "Su scope real: reducir la carga cognitiva al aprender patrones repetitivos y aplicarlos consistentemente, con explicabilidad y la posibilidad de corrección." | knowledge-engine-principles.md v3.0, §Pregunta 11 |

---

## 3. Dependencias conceptuales

El Knowledge Engine depende de los siguientes conceptos definidos en `conocimiento-general.md v1.11`:

| Concepto | Definición | Fuente |
|----------|-----------|--------|
| Conocimiento | "Una afirmación respaldada por evidencia dentro de un contexto determinado" | conocimiento-general.md v1.11, §Qué es conocimiento |
| Afirmación | "Una proposición evaluable cuya validez puede sostenerse o refutarse mediante evidencia dentro de un contexto determinado" | conocimiento-general.md v1.11, §Qué es una afirmación de negocio |
| Evidencia | "Toda información verificable que sostiene una afirmación de conocimiento" | conocimiento-general.md v1.11, §Qué es evidencia |
| Contexto | Condiciones bajo las cuales una afirmación es válida | conocimiento-general.md v1.11, §Qué es contexto |
| Unidad de Conocimiento | "La mínima entidad independiente que puede existir, evolucionar, tener identidad, evidencia, contexto, historia, trazabilidad y relaciones" | conocimiento-general.md v1.11, §Unidad de Conocimiento |
| Tipos de conocimiento | Hecho, Patrón, Preferencia, Política, Relación, Excepción, Hipótesis, Inferencia, Estadística | conocimiento-general.md v1.11, §Tipos de conocimiento |
| Ámbitos | Global, Grupo, Empresa, Usuario | conocimiento-general.md v1.11, §Ámbitos de conocimiento |
| Saber y Creer | Estados epistemológicos del conocimiento | conocimiento-general.md v1.11, §Saber y creer |
| Verdad vs. Autorización | "La verdad no depende de la autorización" | conocimiento-general.md v1.11, §Verdad y autorización |
| Evolución | "El conocimiento nunca se modifica; se crea una nueva versión" | conocimiento-general.md v1.11, §Evolución |

---

## 4. Restricciones heredadas

### 4.1 Del contrato conceptual (conocimiento-general.md v1.11)

| Restricción | Fuente |
|-------------|--------|
| "El conocimiento nunca se modifica; se crea una nueva versión" | §Evolución |
| "La identidad es permanente e inmutable" | §Identidad de una afirmación |
| "La verdad no depende de la autorización" | §Verdad y autorización |
| "Existe una diferencia conceptual entre creer y saber" | §Saber y creer |
| "Conocer implica poder responder: por qué, desde cuándo, con qué evidencia, quién lo validó, cuándo dejaría de ser cierta, qué otras afirmaciones entran en conflicto" | §Qué es conocer |
| "La fuerza de la evidencia depende de origen, volumen, consistencia y actualidad" | §Qué es evidencia |
| "El nivel de confianza nunca puede superar la fuerza de la evidencia" | §Qué es evidencia |
| "Toda afirmación debe tener contexto suficiente para determinar cuándo aplica" | §Qué es contexto |
| "Si no se puede explicar, no se debería haber decidido" | §Qué significa explicar |
| "El conocimiento forma una red de relaciones" | §Red de conocimiento |
| "El origen es inmutable" | §Origen |
| "La configuración define CÓMO funciona el sistema; el conocimiento define QUÉ sabe el sistema; nunca deben mezclarse" | §Ámbitos de conocimiento |

### 4.2 De knowledge-engine-principles.md v3.0

| Restricción | Fuente |
|-------------|--------|
| "Autoridad Operativa > Autoridad de Aprendizaje > Autoridad de Contexto" | §Pregunta 5 |
| "Ninguna autoridad puede contradecir a una superior" | §Pregunta 5 |
| "El conocimiento no se elimina por antigüedad; se elimina por contradicción" | §Pregunta 4 |
| "El sistema no aprende de datos aislados; aprende de repeticiones consistentes" | §Pregunta 6 |
| "La consistencia es más importante que la frecuencia" | §Pregunta 6 |
| "El desaprendizaje requiere la misma evidencia que el aprendizaje" | §Pregunta 7 |
| "Toda corrección de una autoridad se aplica de inmediato" | §Pregunta 9 |
| "No toda corrección implica un cambio de patrón" | §Pregunta 9 |
| "El sistema debe distinguir entre excepción (corrección aislada) y cambio de patrón (corrección consistente)" | §Pregunta 9 |

### 4.3 De la Etapa 2 (Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07))

| Restricción | Fuente |
|-------------|--------|
| Observación, Dato, Conocimiento y Relación: DESCARTADO bajo las estrategias aplicadas | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07) |
| Afirmación y Unidad de Conocimiento: CANDIDATO | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07) |
| Evidencia: INDETERMINADO | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07) |
| No se encontró articulación explícita entre Afirmación y Unidad de Conocimiento | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07) |
| La pregunta central de la Etapa 2 no fue resuelta | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07) |

---

## 5. Supuestos

Este contrato no introduce supuestos adicionales.

---

## 6. Preguntas abiertas heredadas

La siguiente pregunta proviene directamente de las fuentes oficiales.

| # | Pregunta | Fuente |
|---|----------|--------|
| 1 | ¿Cuál es la unidad conceptual mínima del conocimiento? | Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07), §Pregunta central de la Etapa 2 |

---

## 7. Rastreo de contradicciones

Durante la consolidación de este borrador no se identificaron contradicciones entre las cuatro fuentes oficiales.

---

**Documento:** knowledge-engine-contract-v0.1.md
**Versión:** 0.1
**Estado:** Borrador — sexto borrador (identificadores únicos completados)