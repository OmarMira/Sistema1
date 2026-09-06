# Conocimiento General

**Versión:** 1.9
**Fecha:** 2026-09-06
**Estado:** Borrador
**Fase:** 1 — Conocimiento General (Disciplina Fundacional)

---

## Definición

**Conocimiento General es la disciplina que define qué constituye conocimiento empresarial, cómo nace, cómo evoluciona, cómo se valida, cómo se explica y cómo se descarta.**

Es la teoría.

No es el motor.

No es la implementación.

Es el contrato que sobrevive incluso si el motor cambia completamente.

---

## Propósito

**El propósito del Conocimiento General es organizar y hacer reutilizable el conocimiento del negocio para que las decisiones futuras sean consistentes, explicables y acumulativas.**

---

## Los tres niveles de comprensión

**Los datos describen hechos.**

**Las reglas describen acciones.**

**El conocimiento describe comprensión.**

| Nivel | Qué hace | Ejemplo |
|-------|----------|---------|
| Dato | Registra un hecho aislado | "Amazon — $500 — 05/09/2026" |
| Regla | Define qué hacer ante una condición | "Si contiene 'Amazon', clasificar como Gasto Operativo" |
| Conocimiento | Explica por qué | "Esta empresa usa Amazon para compras de oficina; siempre se clasifica como Gasto Operativo" |

La regla dice qué hacer.

El conocimiento dice por qué.

---

## La jerarquía del conocimiento

El conocimiento no aparece de la nada.

Una forma habitual de maduración es:

```
Observación
  ↓
Dato
  ↓
Afirmación
  ↓
Conocimiento
```

### Observación

La percepción de un aspecto del negocio.

Puede provenir de:

- Un PDF importado.
- Un CSV bancario.
- Una API financiera.
- Una acción de un usuario.
- Una declaración de un contador.

La observación es el punto de entrada de la información al sistema.

### Dato

Un hecho aislado, extraído de una observación, sin contexto.

- Ejemplo: "Amazon"
- Ejemplo: "$500"
- Ejemplo: "05/09/2026"

El dato por sí mismo no significa nada.

### Afirmación

Una proposición evaluable cuya validez puede sostenerse o refutarse mediante evidencia dentro de un contexto determinado.

- Ejemplo: "Amazon se clasifica como Gasto Operativo."
- Ejemplo: "Amazon es proveedor de esta empresa."

La afirmación es el objeto sobre el cual recae la evidencia.

### Conocimiento

Una afirmación respaldada por evidencia suficiente para justificarla dentro de un contexto determinado.

- Ejemplo: "En esta empresa Amazon representa compras operativas y nunca activos. Esto se sostiene con 47 transacciones consistentes."

**Nota importante:**

Esta secuencia describe una ruta frecuente, no una ley.

Existen otras rutas:

- Una **política** definida por un contador nace directamente como afirmación.
- Una **norma fiscal** nace como conocimiento externo.
- Una **preferencia explícita** del usuario no pasa por observaciones.

El modelo debe admitir múltiples rutas de maduración.

---

## Qué es una afirmación de negocio

**La unidad fundamental del conocimiento es una afirmación sobre el negocio.**

Una afirmación es una proposición evaluable cuya validez puede sostenerse o refutarse mediante evidencia dentro de un contexto determinado.

Toda afirmación tiene:

- **Sujeto:** Sobre qué afirma.
- **Predicado:** Qué dice del sujeto.
- **Contexto:** Bajo qué condiciones es válida.
- **Evidencia:** Qué la sostiene.

**Ejemplo:**

| Componente | Valor |
|------------|-------|
| Sujeto | Amazon |
| Predicado | es clasificado como Gasto Operativo |
| Contexto | Empresa A, cuenta 5110, pagos a proveedores |
| Evidencia | 47 transacciones consistentes |

---

## Identidad de una afirmación

¿Qué hace que dos afirmaciones sean la misma afirmación?

**Ejemplo:**

- "Amazon → Gasto Operativo"
- "Amazon Marketplace → Gasto Operativo"

¿Son dos unidades distintas?

¿Son versiones?

¿Son afirmaciones relacionadas?

¿Son sinónimos?

**Principio:**

Dos afirmaciones representan la misma unidad de conocimiento cuando mantienen la misma identidad semántica dentro de su contexto.

El cálculo de esa identidad semántica pertenece al diseño del motor.

---

## Verdad y autorización

Son conceptos distintos.

### Verdad / evidencia

Una afirmación puede ser verdadera antes de que nadie la valide.

Ejemplo:

- "IVA = 21%" es verdadero independientemente de que un usuario lo apruebe.
- "Amazon apareció 47 veces como Gasto Operativo" es un hecho observable.

La verdad depende de la evidencia, no de la autoridad.

### Autorización operacional

La autorización define si el sistema está autorizado a utilizar una afirmación automáticamente.

Ejemplo:

- "IVA = 21%" puede ser verdadero, pero el sistema quizás no esté autorizado a aplicarlo sin supervisión.
- "Amazon siempre es Gasto Operativo" puede ser verdadero y estar autorizado.

**Principio:**

La verdad de una afirmación no depende de la autorización.

La autorización operacional es un concepto separado que determina si el sistema puede usar esa afirmación para decidir automáticamente.

---

## Qué es conocimiento

**Conocimiento es una afirmación respaldada por evidencia suficiente para justificarla dentro de un contexto determinado.**

No es información cruda.

No es un dato aislado.

No es una regla.

No es simplemente información persistida.

La persistencia es una propiedad técnica del sistema.

Lo que define al conocimiento es que tiene evidencia suficiente y contexto adecuado para justificarse.

---

## Qué no es conocimiento

Todo lo que sea temporal, transitorio, accidental o no represente un patrón del negocio.

**No es conocimiento:**

- Estados temporales.
- Errores pasajeros.
- Datos de ejecución.
- Caches.
- Resultados de importes aislados.
- Decisiones únicas que nunca se repiten.
- Información sin evidencia ni contexto.

**La frontera:**

Una afirmación se convierte en conocimiento cuando tiene evidencia suficiente para justificarse y contexto adecuado.

---

## Qué es conocer

**Conocimiento** es la afirmación respaldada.

**Conocer** es el acto de poder razonar sobre esa afirmación.

Son cosas distintas.

**Ejemplo:**

- Tener almacenado: "Amazon → Gasto Operativo" → Eso es conocimiento (afirmación respaldada).
- Poder responder: "¿Por qué?", "¿Desde cuándo?", "¿Con qué evidencia?", "¿Quién lo validó?", "¿Cuándo dejaría de ser cierta?" → Eso es conocer.

**La diferencia:**

- Una base de datos almacena conocimiento.
- Un cerebro conoce.

**Principio:**

El sistema no solo debe almacenar afirmaciones; debe poder razonar sobre ellas.

Conocer implica poder responder:

1. **Por qué** es cierta esta afirmación.
2. **Desde cuándo** se sostiene.
3. **Con qué evidencia** se sostiene.
4. **Quién** la validó.
5. **Cuándo** dejaría de ser cierta.
6. **Qué** otras afirmaciones entran en conflicto con ella.

---

## Qué es evidencia

**Evidencia es toda información verificable que sostiene una afirmación de conocimiento.**

No toda evidencia tiene el mismo peso.

La fuerza de la evidencia depende de:

- **Origen:** De dónde proviene.
- **Volumen:** Cuántas observaciones la sostienen.
- **Consistencia:** Qué tan uniforme es.
- **Actualidad:** Qué tan reciente es.

**Principio:**

El nivel de confianza de una afirmación nunca puede superar la fuerza de la evidencia que la respalda.

---

## Qué es contexto

Sin contexto, el conocimiento puede ser verdadero y falso al mismo tiempo.

- "Amazon" → No significa nada.
- "Amazon en la Empresa A" → Comienza a tener sentido.
- "Amazon en la Empresa A, como proveedor, en la cuenta 5110" → Ya es conocimiento útil.

**Principio:**

Toda afirmación de conocimiento debe tener contexto suficiente para determinar cuándo aplica.

---

## Unidad de Conocimiento

### Definición

**Una Unidad de Conocimiento es la mínima entidad independiente que puede existir, evolucionar, tener identidad, evidencia, contexto, historia y relaciones.**

### Identidad

La identidad es permanente e inmutable.

Si el contenido cambia pero la identidad se mantiene → evolución (nueva versión).

Si la identidad cambia → otra unidad completamente diferente.

### Propiedades

- **Identidad:** Referencia permanente.
- **Enunciado:** Qué afirma sobre el mundo.
- **Tipo:** A qué categoría pertenece.
- **Origen:** Cómo nació.
- **Evidencia:** Qué la sostiene.
- **Contexto:** En qué condiciones aplica.
- **Ámbito:** A qué nivel de alcance pertenece.
- **Historia:** Cómo evolucionó.
- **Relaciones:** Con qué otras unidades se relaciona.

---

## Tipos de conocimiento

### Hecho

Afirmación verificable sobre una entidad o evento.

### Patrón

Comportamiento que se repite con consistencia suficiente.

### Preferencia

Elección explícita sobre cómo hacer algo.

### Política

Regla de negocio que la empresa aplica consistentemente.

### Relación

Asociación entre entidades que el sistema reconoce.

### Excepción

Situación que se desvía de la regla general pero es legítima.

### Hipótesis

Conocimiento propuesto que aún no tiene suficiente evidencia.

### Inferencia

Conocimiento derivado de otras unidades de conocimiento.

### Estadística

Propiedad cuantitativa observada de un conjunto de datos.

---

## Ámbitos de conocimiento

### Global

Conocimiento que aplica a todas las empresas del sistema.

### Grupo

Conocimiento que aplica a un grupo de empresas.

### Empresa

Conocimiento que aplica a una empresa específica.

### Usuario

Conocimiento que aplica a una persona específica.

### Frontera conocimiento vs. configuración

**La configuración define CÓMO funciona el sistema.**

**El conocimiento define QUÉ sabe el sistema.**

Nunca deben mezclarse.

---

## Qué significa aprender

El sistema aprende cuando una afirmación sobre el negocio pasa de no tener evidencia a estar respaldada por evidencia suficiente.

**No aprende de datos aislados.**

Aprende de repeticiones consistentes.

---

## Qué significa desaprender

El sistema desaprende cuando una afirmación que tenía evidencia pierde esa evidencia por contradicción.

**No se olvida por antigüedad.**

Se olvida por contradicción demostrada.

---

## Qué significa explicar

Toda decisión tomada usando conocimiento debe poder justificarse respondiendo:

1. **Qué se decidió.**
2. **Por qué se decidió.**
3. **Con qué evidencia.**
4. **Cuándo se aprendió.**
5. **Si hubo excepciones.**

**Principio:**

Si no se puede explicar, no se debería haber decidido.

---

## Red de conocimiento

El conocimiento casi nunca existe aislado.

Una unidad sin relaciones es un dato muerto.

El conocimiento forma una red de relaciones donde cada unidad puede conectarse con otras.

**Principio:**

El modelo conceptual debe admitir relaciones de primer nivel entre unidades de conocimiento.

---

## Evolución

El conocimiento nunca se modifica; evoluciona.

No se reemplaza una unidad.

Se crea una nueva versión.

La versión anterior se conserva.

Esto permite:

- Auditoría completa.
- Comparación entre versiones.
- Reversión si es necesario.
- Trazabilidad de por qué cambió.

---

## Origen

El origen describe cómo nació la unidad.

Es inmutable.

---

## Principios Fundacionales

| # | Principio | Enunciado |
|---|-----------|-----------|
| P1 | Definición | Conocimiento General es la disciplina que define qué constituye conocimiento empresarial |
| P2 | Propósito | Organizar y hacer reutilizable para que las decisiones sean consistentes, explicables y acumulativas |
| P3 | Tres niveles | Los datos describen hechos. Las reglas describen acciones. El conocimiento describe comprensión |
| P4 | Jerarquía | Observación → Dato → Afirmación → Conocimiento (una ruta habitual, no la única) |
| P5 | Afirmación de negocio | La unidad fundamental del conocimiento es una afirmación sobre el negocio |
| P6 | Definición de afirmación | Una proposición evaluable cuya validez puede sostenerse o refutarse mediante evidencia dentro de un contexto determinado |
| P7 | Identidad semántica | Dos afirmaciones representan la misma unidad cuando mantienen la misma identidad semántica dentro de su contexto |
| P8 | Conocimiento ≠ Dato ≠ Regla | Comprensión, no datos aislados ni reglas binarias |
| P9 | Definición de conocimiento | Una afirmación respaldada por evidencia suficiente para justificarla dentro de un contexto determinado |
| P10 | Verdad vs. Autorización | La verdad no depende de la autorización |
| P11 | Conocer vs. Conocimiento | Conocimiento es afirmación respaldada; conocer es poder razonar sobre ella |
| P12 | Evidencia verificable | Toda afirmación debe sostenerse con evidencia verificable |
| P13 | Fuerza de evidencia | Depende de origen, volumen, consistencia y actualidad |
| P14 | Confianza proporcional | Nunca supera la fuerza de la evidencia |
| P15 | Contexto necesario | Toda afirmación debe tener contexto suficiente |
| P16 | Explicabilidad obligatoria | Si no se puede explicar, no se debería haber decidido |
| P17 | Identidad inmutable | La identidad es permanente; el contenido evoluciona |
| P18 | Red de conocimiento | El conocimiento es una red de relaciones |
| P19 | Evolución, no modificación | Nunca se modifica; se crea nueva versión |
| P20 | Origen inmutable | El origen no cambia |
| P21 | Trazabilidad | Toda unidad debe poder reconstruir su historia |

---

## Qué no está en este documento

Este documento define principios permanentes.

No define:

- Estados del ciclo de vida.
- Transiciones válidas o prohibidas.
- Niveles de autoridad.
- Consecuencias operativas de saber vs. creer.
- Algoritmos de ponderación.
- Mecanismos de propagación.
- Estructuras de datos.
- APIs.
- Eventos.
- Nombre del motor.

Eso pertenece al diseño del Knowledge Engine (Fase 2).

---

## Criterio de Finalización

1. Propósito definido ✅
2. Tres niveles de comprensión definidos ✅
3. Jerarquía sin "Realidad" ✅
4. Afirmación de negocio definida ✅
5. Definición fuerte de afirmación ✅
6. Identidad semántica definida ✅
7. Definición de conocimiento refinada ✅
8. Verdad vs. Autorización separados ✅
9. Conocer vs. Conocimiento definido ✅
10. Qué no es conocimiento definido ✅
11. Qué es evidencia definido ✅
12. Qué es contexto definido ✅
13. Unidad de Conocimiento definida ✅
14. Tipos de conocimiento definidos ✅
15. Ámbitos definidos ✅
16. Frontera conocimiento/configuración definida ✅
17. Qué significa aprender definido ✅
18. Qué significa desaprender definido ✅
19. Qué significa explicar definido ✅
20. Red de conocimiento definida ✅
21. Evolución como principio ✅
22. 21 principios definidos ✅
23. Sin comportamiento del motor ✅
24. Sin duplicación entre capítulos y principios ✅

**Documento listo para congelarse como contrato conceptual permanente.**

---

**Documento:** conocimiento-general.md
**Versión:** 1.9
**Estado:** Borrador — listo para congelar
