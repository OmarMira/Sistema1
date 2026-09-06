# Conocimiento General

**Versión:** 1.5
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

**El propósito del Conocimiento General es preservar, organizar y reutilizar el conocimiento del negocio para que las decisiones futuras sean consistentes, explicables y acumulativas.**

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

## Qué es una afirmación de negocio

**El Knowledge Engine no almacena datos; almacena afirmaciones sobre el negocio.**

Una afirmación es la unidad mínima de significado.

Toda afirmación tiene:

- **Sujeto:** Sobre qué afirma.
- **Predicado:** Qué dice del sujeto.
- **Contexto:** Bajo qué condiciones es válida.
- **Evidencia:** Qué la sostiene.
- **Autoridad:** Quién la creó o validó.

**Ejemplo:**

| Componente | Valor |
|------------|-------|
| Sujeto | Amazon |
| Predicado | es clasificado como Gasto Operativo |
| Contexto | Empresa A, cuenta 5110, pagos a proveedores |
| Evidencia | 47 transacciones consistentes |
| Autoridad | Contador Juan Pérez, 15/03/2026 |

**Principio:**

El conocimiento es la comprensión acumulada de afirmaciones de negocio que se sostienen con evidencia suficiente y han sido validadas por una autoridad.

---

## Qué es conocimiento

Conocimiento es la comprensión acumulada y validada de cómo opera un negocio específico.

No es información cruda.

No es un dato aislado.

No es una regla.

Es la interpretación persistente de patrones, preferencias, excepciones y comportamientos que se repiten en el tiempo dentro de una empresa.

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

**La frontera:**

Un dato se convierte en conocimiento cuando demuestra un patrón que se espera que continúe en el tiempo.

---

## Qué es conocer

**Conocimiento** es la información persistida.

**Conocer** es el acto de poder responder preguntas sobre esa información.

Son cosas distintas.

**Ejemplo:**

- Tener almacenado: "Amazon → Gasto Operativo" → Eso es conocimiento (información persistida).
- Poder responder: "¿Por qué?", "¿Desde cuándo?", "¿Con qué evidencia?", "¿Quién lo validó?", "¿Cuándo dejaría de ser cierto?" → Eso es conocer.

**La diferencia:**

- Una base de datos almacena conocimiento.
- Un cerebro conoce.

**Principio:**

El Knowledge Engine no solo debe almacenar afirmaciones; debe poder razonar sobre ellas.

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
- **Validación:** Si una autoridad la ha confirmado.

**Principio:**

El nivel de confianza de una unidad nunca puede superar la fuerza de la evidencia que la respalda.

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

**Sabe:** Evidencia suficiente y validada para afirmar algo con confianza.

### La frontera

El sistema pasa de "creer" a "saber" cuando la evidencia es suficiente y una autoridad operativa ha validado la afirmación.

**Principio:**

El sistema nunca puede afirmar que sabe algo sin que una autoridad lo haya validado.

La evidencia sola no es suficiente.

---

## Qué significa creer

El sistema cree cuando tiene evidencia pero no cumple las condiciones para saber.

**Consecuencia operativa:**

El conocimiento en estado "creer" puede usarse como sugerencia, pero nunca como decisión automática.

Solo el conocimiento en estado "sabe" puede fundamentar decisiones automáticas.

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
| P3 | **Tres niveles** | **Los datos describen hechos. Las reglas describen acciones. El conocimiento describe comprensión.** |
| P4 | **Afirmación de negocio** | **El Knowledge Engine no almacena datos; almacena afirmaciones sobre el negocio** |
| P5 | **Conocer vs. Conocimiento** | **Conocimiento es información persistida; conocer es poder razonar sobre ella** |
| P6 | Conocimiento ≠ Dato ≠ Regla | Comprensión persistente, no datos aislados ni reglas binarias |
| P7 | Frontera del conocimiento | Solo persiste lo que representa un patrón estable |
| P8 | Unidad fundamental | Mínima entidad independiente con identidad, evidencia, confianza, autoridad, contexto, historia y relaciones |
| P9 | Identidad inmutable | La identidad es permanente; el contenido evoluciona |
| P10 | Evidencia verificable | Toda afirmación debe sostenerse con evidencia verificable |
| P11 | Fuerza de evidencia | Depende de origen, volumen, consistencia, actualidad y validación |
| P12 | Confianza proporcional | Nunca supera la fuerza de la evidencia |
| P13 | Contexto necesario | Toda afirmación debe tener contexto suficiente para determinar cuándo aplica |
| P14 | Saber vs. Creer | Solo sabe cuando una autoridad lo ha validado |
| P15 | Consecuencia operativa | Solo el conocimiento en estado "sabe" puede fundamentar decisiones automáticas |
| P16 | Aprendizaje por evidencia | Solo de evidencia suficiente para justificar persistencia |
| P17 | Desaprendizaje por contradicción | No por antigüedad, por contradicción demostrada |
| P18 | Corrección preserva coherencia | Toda corrección debe preservar la coherencia existente |
| P19 | Explicabilidad obligatoria | Si no se puede explicar, no se debería haber decidido |
| P20 | Autoridad jerárquica | Operativa > Aprendizaje > Contexto |
| P21 | Autoridad necesaria | Toda unidad requiere supervisión |
| P22 | Tipos de conocimiento | Diferentes tipos evolucionan diferente |
| P23 | Ámbitos de conocimiento | Global, grupo, empresa, usuario |
| P24 | Frontera conocimiento/configuración | Configuración = CÓMO; Conocimiento = QUÉ |
| P25 | Red de conocimiento | El conocimiento es una red de relaciones |
| P26 | Propagación | Toda propagación debe preservar coherencia, trazabilidad y explicabilidad |
| P27 | Origen y estado | Origen inmutable, estado evoluciona |
| P28 | Evolución, no modificación | Nunca se modifica; se crea nueva versión |
| P29 | Trazabilidad total | Origen, evidencia, historia y estado |
| P30 | **Razonamiento** | **El Knowledge Engine debe poder responder qué sabe, por qué lo sabe, y qué tan seguro está** |

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

Eso pertenece al diseño del Knowledge Engine (Fase 2).

---

## Criterio de Finalización

1. Propósito definido ✅
2. **Tres niveles de comprensión definidos** ✅
3. **Afirmación de negocio definida** ✅
4. **Conocer vs. Conocimiento definido** ✅
5. Qué es conocimiento definido ✅
6. Qué no es conocimiento definido ✅
7. Qué es evidencia definido ✅
8. Qué es contexto definido ✅
9. Unidad de Conocimiento definida ✅
10. Tipos de conocimiento definidos ✅
11. Ámbitos definidos ✅
12. Frontera conocimiento/configuración definida ✅
13. Qué significa aprender definido ✅
14. Qué significa desaprender definido ✅
15. Qué significa explicar definido ✅
16. Qué significa saber definido ✅
17. Qué significa creer definido ✅
18. Red de conocimiento definida ✅
19. Propagación como principio ✅
20. Evolución como principio ✅
21. Autoridad definida ✅
22. 30 principios definidos ✅
23. Sin diseño del motor ✅

**Documento listo para congelarse como contrato conceptual.**

---

**Documento:** conocimiento-general.md
**Versión:** 1.5
**Estado:** Borrador — listo para congelar
