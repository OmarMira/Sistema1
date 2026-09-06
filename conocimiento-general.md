# Conocimiento General

**Versión:** 1.7
**Fecha:** 2026-09-06
**Estado:** Borrador
**Fase:** 1 — Conocimiento General (Disciplina Fundacional)

---

## Definición

**Conocimiento General es la disciplina que define qué constituye conocimiento empresarial, cómo nace, cómo evoluciona, cómo se valida, cómo se explica y cómo se elimina dentro de Sistema1.**

Es la teoría.

No es el motor.

No es la implementación.

Es el contrato que sobrevive incluso si el motor cambia completamente.

---

## Propósito

**El propósito del Conocimiento General es preservar, organizar y reutilizar el conocimiento del negocio para que las decisiones futuras sean consistentes, explicables y acumulatives.**

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
Realidad
  ↓
Observación
  ↓
Dato
  ↓
Afirmación
  ↓
Conocimiento
```

### Realidad

El mundo tal como es.

No es accesible directamente.

Solo puede ser observado.

### Observación

La percepción de un aspecto de la realidad.

No es el dato en sí, sino el acto de percibirlo.

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

Una afirmación que ha acumulado evidencia suficiente, ha sido contextualizada y puede sostenerse con confianza.

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

## Verdad y autorización

Son conceptos distintos.

### Verdad / evidencia

Una afirmación puede ser verdadera antes de que nadie la valide.

Ejemplo:

- "IVA = 21%" es verdadero independientemente de que un usuario lo apruebe.
- "Amazon apareció 47 veces como Gasto Operativo" es un hecho observable.

La verdad depende de la evidencia, no de la autoridad.

### Autorización operacional

La autorización define si Sistema1 está autorizado a utilizar una afirmación automáticamente.

Ejemplo:

- "IVA = 21%" puede ser verdadero, pero Sistema1 quizás no esté autorizado a aplicarlo sin supervisión.
- "Amazon siempre es Gasto Operativo" puede ser verdadero y estar autorizado.

**Principio:**

La verdad de una afirmación no depende de la autorización.

La autorización operacional es un concepto separado que determina si el sistema puede usar esa afirmación para decidir automáticamente.

---

## Qué es conocimiento

**Conocimiento es una afirmación que ha acumulado evidencia suficiente, ha sido contextualizada y puede sostenerse con confianza.**

No es información cruda.

No es un dato aislado.

No es una regla.

No es simplemente información persistida.

La persistencia es una propiedad técnica.

Lo que define al conocimiento es su madurez: tiene evidencia suficiente y contexto adecuado.

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
- Información persistida sin validación ni contexto.

**La frontera:**

Un dato se convierte en conocimiento cuando ha acumulado evidencia suficiente y ha sido contextualizado.

---

## Qué es conocer

**Conocimiento** es la afirmación madura.

**Conocer** es el acto de poder razonar sobre esa afirmación.

Son cosas distintas.

**Ejemplo:**

- Tener almacenado: "Amazon → Gasto Operativo" → Eso es conocimiento (afirmación madura).
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

**Una Unidad de Conocimiento es la mínima entidad independiente que puede existir, evolucionar, tener identidad, evidencia, confianza, autoridad, contexto, historia y relaciones.**

### Identidad

La identidad es permanente e inmutable.

Si el contenido cambia pero la identidad se mantiene → evolución (nueva versión).

Si la identidad cambia → otra unidad completamente diferente.

### Propiedades

- **Identidad:** Referencia permanente.
- **Enunciado:** Qué afirma sobre el mundo.
- **Tipo:** A qué categoría pertenece.
- **Origen:** Cómo nació.
- **Confianza:** Qué tan seguro está el sistema.
- **Evidencia:** Qué la sostiene.
- **Contexto:** En qué condiciones aplica.
- **Ámbito:** A qué nivel de alcance pertenece.
- **Autoridad:** Quién la creó o validó.
- **Historia:** Cómo evolucionó.
- **Relaciones:** Con qué otras unidades se relaciona.

---

## Tipos de conocimiento

### Hecho

Afirmación verificable sobre una entidad o evento.

### Patrón

Comportamiento que se repite con consistencia suficiente.

### Preferencia

Elección explícita de una autoridad sobre cómo hacer algo.

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

El sistema aprende cuando una afirmación sobre el mundo pasa de no tener evidencia a tener evidencia suficiente para justificar su persistencia.

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

## Qué significa saber

### El espectro

```
No sabe → Cree → Sabe
```

**No sabe:** Sin información suficiente para afirmar nada.

**Cree:** Evidencia parcial que sugiere algo, pero no es concluyente.

**Sabe:** Evidencia suficiente y contextualizada para afirmar algo con confianza.

### La frontera

El sistema pasa de "creer" a "saber" cuando la evidencia es suficiente y la afirmación ha sido contextualizada adecuadamente.

**Principio:**

El sistema puede afirmar que sabe algo cuando la evidencia es suficiente y la afirmación está contextualizada.

La autorización para usar esa afirmación automáticamente es un concepto separado.

---

## Qué significa creer

El sistema cree cuando tiene evidencia pero no cumple las condiciones para saber.

**Consecuencia operativa:**

El conocimiento en estado "creer" puede usarse como sugerencia, pero nunca como decisión automática.

Solo el conocimiento en estado "sabe" puede fundamentar decisiones automáticas, y solo cuando está autorizado.

---

## Red de conocimiento

El conocimiento casi nunca existe aislado.

Una unidad sin relaciones es un dato muerto.

El conocimiento forma una red de relaciones donde cada unidad puede conectarse con otras.

**Principio:**

El modelo conceptual debe admitir relaciones de primer nivel entre unidades de conocimiento.

---

## Propagación

Cuando una unidad cambia, puede afectar a unidades conectadas.

**Principio:**

Toda propagación debe preservar coherencia, trazabilidad y explicabilidad.

---

## Evolución

El conocimiento nunca se modifica; evoluciona.

No se reemplaza una unidad.

Se crea una nueva versión.

La versión anterior se archiva.

Esto permite:

- Auditoría completa.
- Comparación entre versiones.
- Reversión si es necesario.
- Trazabilidad de por qué cambió.

---

## Origen y estado

El origen describe cómo nació la unidad.

El estado describe en qué punto de su ciclo se encuentra.

Son conceptos distintos.

El origen es inmutable.

El estado evoluciona.

---

## Autoridad

Hay tres niveles de autoridad.

**Autoridad Operativa:** Puede crear, modificar o eliminar conocimiento. Sus decisiones prevalecen.

**Autoridad de Aprendizaje:** Puede proponer conocimiento. No puede aplicarlo sin validación.

**Autoridad de Contexto:** Conocimiento heredado de otras empresas. Nunca se aplica automáticamente.

**Principio:**

Ninguna autoridad puede contradecir a una superior.

---

## Principios Fundacionales

| # | Principio | Enunciado |
|---|-----------|-----------|
| P1 | Definición | Conocimiento General es la disciplina que define qué constituye conocimiento empresarial |
| P2 | Propósito | Preservar, organizar y reutilizar para que las decisiones sean consistentes, explicables y acumulativas |
| P3 | Tres niveles | Los datos describen hechos. Las reglas describen acciones. El conocimiento describe comprensión |
| P4 | Jerarquía del conocimiento | Realidad → Observación → Dato → Afirmación → Conocimiento (una ruta habitual, no la única) |
| P5 | Afirmación de negocio | La unidad fundamental del conocimiento es una afirmación sobre el negocio |
| P6 | Definición de afirmación | Una proposición evaluable cuya validez puede sostenerse o refutarse mediante evidencia dentro de un contexto determinado |
| P7 | Conocer vs. Conocimiento | Conocimiento es una afirmación madura; conocer es poder razonar sobre ella |
| P8 | Conocimiento ≠ Dato ≠ Regla | Comprensión persistente, no datos aislados ni reglas binarias |
| P9 | **Definición de conocimiento** | **Una afirmación que ha acumulado evidencia suficiente, ha sido contextualizada y puede sostenerse con confianza** |
| P10 | Frontera del conocimiento | Solo persiste lo que representa un patrón estable |
| P11 | Unidad fundamental | Mínima entidad independiente con identidad, evidencia, confianza, autoridad, contexto, historia y relaciones |
| P12 | Identidad inmutable | La identidad es permanente; el contenido evoluciona |
| P13 | Evidencia verificable | Toda afirmación debe sostenerse con evidencia verificable |
| P14 | Fuerza de evidencia | Depende de origen, volumen, consistencia y actualidad |
| P15 | Confianza proporcional | Nunca supera la fuerza de la evidencia |
| P16 | Contexto necesario | Toda afirmación debe tener contexto suficiente para determinar cuándo aplica |
| P17 | **Verdad vs. Autorización** | **La verdad de una afirmación no depende de la autorización; la autorización es un concepto separado** |
| P18 | Saber vs. Creer | Solo sabe cuando la evidencia es suficiente y la afirmación está contextualizada |
| P19 | Consecuencia operativa | Solo el conocimiento en estado "sabe" puede fundamentar decisiones automáticas, y solo cuando está autorizado |
| P20 | Aprendizaje por evidencia | Solo de evidencia suficiente para justificar persistencia |
| P21 | Desaprendizaje por contradicción | No por antigüedad, por contradicción demostrada |
| P22 | Corrección preserva coherencia | Toda corrección debe preservar la coherencia existente |
| P23 | Explicabilidad obligatoria | Si no se puede explicar, no se debería haber decidido |
| P24 | Autoridad jerárquica | Operativa > Aprendizaje > Contexto |
| P25 | Autoridad necesaria | Toda unidad requiere supervisión |
| P26 | Tipos de conocimiento | Diferentes tipos evolucionan diferente |
| P27 | Ámbitos de conocimiento | Global, grupo, empresa, usuario |
| P28 | Frontera conocimiento/configuración | Configuración = CÓMO; Conocimiento = QUÉ |
| P29 | Red de conocimiento | El conocimiento es una red de relaciones |
| P30 | Propagación | Toda propagación debe preservar coherencia, trazabilidad y explicabilidad |
| P31 | Origen y estado | Origen inmutable, estado evoluciona |
| P32 | Evolución, no modificación | Nunca se modifica; se crea nueva versión |
| P33 | Trazabilidad total | Origen, evidencia, historia y estado |
| P34 | **Razonamiento** | **El sistema debe poder responder qué sabe, por qué lo sabe, y qué tan seguro está** |

---

## Qué no está en este documento

Este documento define principios permanentes.

No define:

- Estados del ciclo de vida.
- Transiciones válidas o prohibidas.
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
3. **Jerarquía no lineal (una ruta habitual, no la única)** ✅
4. Afirmación de negocio definida ✅
5. **Definición fuerte de afirmación** ✅
6. Conocer vs. Conocimiento definido ✅
7. Definición de conocimiento refinada ✅
8. **Verdad vs. Autorización separados** ✅
9. Qué no es conocimiento definido ✅
10. Qué es evidencia definido ✅
11. Qué es contexto definido ✅
12. Unidad de Conocimiento definida ✅
13. Tipos de conocimiento definidos ✅
14. Ámbitos definidos ✅
15. Frontera conocimiento/configuración definida ✅
16. Qué significa aprender definido ✅
17. Qué significa desaprender definido ✅
18. Qué significa explicar definido ✅
19. Qué significa saber definido ✅
20. Qué significa creer definido ✅
21. Red de conocimiento definida ✅
22. Propagación como principio ✅
23. Evolución como principio ✅
24. Autoridad definida ✅
25. 34 principios definidos ✅
26. Sin referencia al motor ✅
27. Sin dependencia de persistencia técnica ✅

**Documento listo para congelarse como contrato conceptual permanente.**

---

**Documento:** conocimiento-general.md
**Versión:** 1.7
**Estado:** Borrador — listo para congelar
