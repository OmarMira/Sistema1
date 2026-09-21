# Knowledge Engine — Principios Fundacionales

**Versión:** 3.0
**Fecha:** 2026-09-06
**Estado:** Borrador
**Fase:** 1 — Principios

---

## Definición del Knowledge Engine

**El Knowledge Engine es el subsistema responsable de adquirir, validar, almacenar, evolucionar, explicar y suministrar conocimiento empresarial persistente.**

No es un motor de reglas.

No es un sistema de inferencia.

No es un cache.

Es la memoria empresarial: aquello que el negocio sabe sobre sí mismo.

---

## Pregunta 1: ¿Qué es conocimiento dentro de Sistema1?

Conocimiento es la comprensión acumulada y validada de cómo opera un negocio específico.

No es información cruda.

No es un dato aislado.

No es una regla.

Es la interpretación persistente de patrones, preferencias, excepciones y comportamientos que se repiten en el tiempo dentro de una empresa.

**Diferencia fundamental:**

- **Dato:** "Hoy se importaron 47 transacciones." (Hecho aislado, sin contexto)
- **Regla:** "Si la descripción contiene 'Amazon', clasificar como Gasto Operativo." (Condición → Acción)
- **Conocimiento:** "Esta empresa usa Amazon exclusivamente para compras de oficina y logística, nunca para equipos." (Comprensión del comportamiento)

La regla dice qué hacer.

El conocimiento dice por qué.

---

## Pregunta 2: ¿Qué no constituye conocimiento?

Todo lo que sea temporal, transitorio, accidental o no represente un patrón del negocio.

**No es conocimiento:**

- Estados temporales (una sesión de usuario, un import en curso).
- Errores pasajeros (una transacción mal clasificada que fue corregida).
- Datos de ejecución (cuántos registros procesó un job).
- Caches (resultados temporales de un cálculo).
- Resultados de un import aislado (una importación específica no define un patrón).
- Decisiones únicas (una excepción que nunca se repite).

**La frontera fundamental:**

Un dato se convierte en conocimiento cuando demuestra un patrón que se espera que continúe en el tiempo.

---

## Pregunta 3: ¿Qué información merece persistir permanentemente?

Aquella que describe el funcionamiento estable de una empresa.

**Merece persistir:**

- Preferencias contables (cómo esta empresa categoriza sus gastos).
- Patrones de comportamiento (qué proveedores usa, con qué frecuencia, en qué montos).
- Excepciones conocidas (situaciones que se desvían de la regla general pero son legítimas).
- Vocabulario propio (cómo esta empresa denomina sus cuentas, proveedores, categorías).
- Políticas internas (reglas de negocio que esta empresa aplica consistentemente).
- Relaciones (cómo se relacionan entidades entre sí).
- Hábitos (cómo se realizan las cosas, no solo qué cosa se hace).
- Procesos (secuencias de pasos que se repiten).

**No debe persistir:**

- Datos de sesión.
- Estados de importación.
- Errores temporales.
- Resultados de cómputo intermedios.
- Información que fue explícitamente eliminada por una autoridad.

---

## Pregunta 4: ¿Qué información debe olvidarse?

Aquella que ya no representa la realidad del negocio.

**Debe olvidarse:**

- Patrones que fueron contradichos por evidencia reciente y consistente.
- Conocimiento que una autoridad declaró como obsoleto.
- Preferencias que cambiaron.
- Excepciones que ya no aplican.
- Información que fue aprendida por error (un patrón que parecía real pero era coincidencia).

**La regla del olvido:**

El conocimiento no se elimina por antigüedad.

Se elimina por contradicción.

---

## Pregunta 5: ¿Quién puede modificar el conocimiento?

Hay tres niveles de autoridad, cada uno con diferentes alcances.

**Autoridad Operativa (máxima):**

- Puede crear, modificar o eliminar conocimiento explícitamente.
- Sus decisiones siempre prevalecen sobre el aprendizaje automático.
- No requiere justificación para modificar.

**Autoridad de Aprendizaje (condicionada):**

- Puede proponer nuevo conocimiento basado en patrones observados.
- No puede aplicar conocimiento nuevo sin validación.
- Todo conocimiento propuesto debe pasar por un proceso de verificación.
- Nunca puede ignorar una corrección de la Autoridad Operativa.

**Autoridad de Contexto (derivada):**

- El conocimiento heredado de otras empresas del mismo grupo puede servir como punto de partida.
- Nunca se aplica automáticamente.
- Siempre requiere validación explícita.

**Regla fundamental:**

Ninguna autoridad puede contradecir a una superior.

---

## Pregunta 6: ¿Cuándo debe aprender el sistema?

El sistema debe aprender cuando detecta evidencia suficiente de un patrón.

**Debe aprender cuando:**

- Un patrón se repite con consistencia suficiente para justificar su persistencia.
- Un comportamiento se repite con consistencia suficiente.
- Una autoridad enseña explícitamente una regla.

**No debe aprender cuando:**

- La evidencia es ambigua o inconsistente.
- La clasificación fue una excepción (la autoridad indicó que no se repetirá).
- El patrón es demasiado específico para generalizar.
- No hay suficientes observaciones para establecer confianza.

**El umbral de aprendizaje:**

El sistema no aprende de datos aislados.

Aprende de repeticiones consistentes.

La consistencia es más importante que la frecuencia.

---

## Pregunta 7: ¿Cuándo debe desaprender?

El sistema debe desaprender cuando el conocimiento existente ya no representa la realidad.

**Debe desaprender cuando:**

- Un patrón que tenía alta confianza recibe correcciones múltiples y consistentes.
- Una autoridad declara explícitamente que una preferencia cambió.
- La evidencia reciente contradice el conocimiento histórico.

**No debe desaprender cuando:**

- Hay una única corrección (puede ser una excepción, no un cambio de patrón).
- La corrección es sobre un dato específico, no sobre un patrón general.
- No hay evidencia suficiente de que el cambio es permanente.

**La regla del desaprendizaje:**

El desaprendizaje requiere la misma evidencia que el aprendizaje.

No se elimina conocimiento por una sola excepción.

Se elimina por un cambio demostrado y consistente.

---

## Pregunta 8: ¿Qué nivel de evidencia requiere una nueva pieza de conocimiento?

El conocimiento requiere evidencia proporcional a su impacto.

**Principio:**

El nivel de confianza de una pieza de conocimiento nunca puede superar el nivel de evidencia que la respalda.

**Jerarquía de evidencia:**

1. Declaración explícita de una autoridad (máxima confianza).
2. Patrón observado y confirmado (alta confianza).
3. Patrón observado sin confirmar (confianza media).
4. Inferencia del sistema (confianza baja).
5. Suposición (sin confianza).

**Principio:**

El umbral de evidencia debe ser proporcional al impacto de la decisión.

---

## Pregunta 9: ¿Cómo se corrige conocimiento incorrecto?

La corrección es un proceso de dos pasos: corrección inmediata + verificación de patrón.

**Paso 1 — Corrección inmediata:**

Cuando una autoridad corrige una clasificación, el sistema debe:
1. Aplicar la corrección de inmediato para esa transacción específica.
2. Registrar la corrección como evidencia.
3. No esperar a que se acumule evidencia para actuar.

**Paso 2 — Verificación de patrón:**

Después de la corrección, el sistema debe:
1. Evaluar si la corrección afecta un patrón existente.
2. Si el patrón tenía alta confianza y la corrección es aislada → mantener el patrón pero registrar la excepción.
3. Si el patrón recibe múltiples correcciones → reducir confianza y marcar para revisión.
4. Si el patrón pierde confianza → proponer eliminación o actualización.

**La regla de la corrección:**

Una corrección de una autoridad siempre es válida.

Pero no toda corrección implica un cambio de patrón.

El sistema debe distinguir entre:
- Una excepción (corrección aislada, patrón se mantiene).
- Un cambio de patrón (corrección consistente, patrón se actualiza).

---

## Pregunta 10: ¿Cómo se explica cualquier decisión tomada usando ese conocimiento?

Toda decisión debe ser explicable en lenguaje humano, no técnico.

**Estructura de una explicación:**

1. **Qué se decidió:** "La transacción se clasificó como Gasto Operativo."
2. **Por qué se decidió:** "Porque transacciones anteriores con la misma descripción se clasificaron de la misma manera."
3. **Con qué confianza:** "Confianza alta."
4. **Cuándo se aprendió:** "Este patrón se estableció hace 6 meses."
5. **Cuál fue la última confirmación:** "La última vez que se aplicó correctamente fue hace 3 días."
6. **Si hubo excepciones:** "Ha habido 2 excepciones en los últimos 6 meses."

**Niveles de explicación:**

- **Nivel simple:** "Clasificado por regla automática."
- **Nivel medio:** "Clasificado porque este proveedor siempre se asocia con esta categoría."
- **Nivel detallado:** "Clasificado porque transacciones anteriores con 'AMZN MKTPLACE' se clasificaron como Gasto Operativo con alta consistencia."

**Regla fundamental:**

Si el sistema no puede explicar por qué tomó una decisión, no debería haberla tomado.

---

## Pregunta 11: ¿Cuáles son los límites del Knowledge Engine?

El Knowledge Engine tiene límites claros que deben ser respetados.

**No puede:**

- Tomar decisiones contables (eso es responsabilidad del contador).
- Aprobar transacciones (eso es responsabilidad de una autoridad).
- Reemplazar el juicio humano en situaciones nuevas o ambiguas.
- Predecir el futuro (solo puede extrapolar del pasado).
- Aprender de datos que no existen.
- Garantizar que todo conocimiento aprendido sea correcto.
- Funcionar sin la supervisión de una autoridad humana.

**No pretende resolver:**

- Complejidad contable (eso es responsabilidad del motor contable).
- Cumplimiento regulatorio (eso es responsabilidad de auditoría).
- Decisiones estratégicas (eso es responsabilidad de la dirección).
- Situaciones sin precedentes (el sistema no puede aprender lo que nunca vio).

**Su scope real:**

Reducir la carga cognitiva al aprender patrones repetitivos y aplicarlos consistentemente, con explicabilidad y la posibilidad de corrección.

---

## Pregunta 12: ¿Qué problemas resuelve y cuáles no pretende resolver?

**Problemas que SÍ resuelve:**

1. **Repetición tediosa:** No hay que clasificar la misma transacción 100 veces.
2. **Inconsistencia:** Diferentes personas clasifican la misma transacción de manera diferente.
3. **Olvido:** Se olvidó cómo se clasificó una transacción similar hace 3 meses.
4. **Falta de explicabilidad:** No se sabe por qué una transacción se clasificó de cierta manera.
5. **Curva de aprendizaje:** Una persona nueva no sabe las preferencias contables de la empresa.
6. **Corrección sin aprendizaje:** Se corrige una clasificación pero el sistema no aprende.

**Problemas que NO resuelve:**

1. **Complejidad contable:** El sistema no reemplaza al contador.
2. **Decisiones nuevas:** Si nunca vio algo similar, no puede clasificarlo automáticamente.
3. **Cambios regulatorios:** El sistema no interpreta nuevas regulaciones.
4. **Fraude:** El sistema no detecta intención fraudulenta.
5. **Errores de datos:** Si el PDF viene mal parseado, el conocimiento no puede compensarlo.
6. **Conflictos entre empresas:** El conocimiento de una empresa no se aplica a otra sin autorización.

---

## Tipos de Conocimiento

El conocimiento no es homogéneo. Existen tipos diferentes que evolucionan, se validan y caducan de manera diferente.

### Hecho

Afirmación verificable sobre una entidad o evento.

- Ejemplo: "Amazon Inc. tiene NIT 123456789."
- Validación: Verificación contra fuente oficial.
- Caducidad: Cuando la fuente cambia.
- Dueño: Autoridad Operativa.

### Patrón

Comportamiento que se repite con consistencia suficiente.

- Ejemplo: "Los pagos a Amazon siempre se clasifican como Gasto Operativo."
- Validación: Evidencia de repeticiones consistentes.
- Caducidad: Cuando la evidencia lo contradice.
- Dueño: Autoridad de Aprendizaje (propuesto), Autoridad Operativa (validado).

### Preferencia

Elección explícita de una autoridad sobre cómo hacer algo.

- Ejemplo: "Esta empresa prefiere agrupar todos los gastos de oficina en una sola categoría."
- Validación: Declaración explícita.
- Caducidad: Cuando la autoridad cambia de opinión.
- Dueño: Autoridad Operativa.

### Política

Regla de negocio que la empresa aplica consistentemente.

- Ejemplo: "Todo cierre contable requiere revisión de dos personas."
- Validación: Declaración explícita + cumplimiento observado.
- Caducidad: Cuando la empresa cambia la política.
- Dueño: Autoridad Operativa.

### Relación

Asociación entre entidades que el sistema reconoce.

- Ejemplo: "MercadoPago es un medio de pago, no un proveedor."
- Validación: Evidencia de uso consistente.
- Caducidad: Cuando la relación cambia.
- Dueño: Autoridad de Aprendizaje (propuesto), Autoridad Operativa (validado).

### Excepción

Situación que se desvía de la regla general pero es legítima.

- Ejemplo: "Amazon a veces se compra como Activo cuando es equipo nuevo."
- Validación: Declaración explícita + evidencia.
- Caducidad: Cuando la excepción ya no aplica.
- Dueño: Autoridad Operativa.

### Hipótesis

Conocimiento propuesto que aún no tiene suficiente evidencia.

- Ejemplo: "Podría ser que esta empresa use MercadoPago para gastos operativos."
- Validación: Pendiente.
- Caducidad: Se convierte en otro tipo o se descarta.
- Dueño: Autoridad de Aprendizaje.

### Inferencia

Conocimiento derivado de otras piezas de conocimiento.

- Ejemplo: "Si Amazon siempre es Gasto Operativo y Starbucks es similar, entonces Starbucks también podría serlo."
- Validación: Solidez de las piezas de las que deriva.
- Caducidad: Cuando las piezas base cambian.
- Dueño: Autoridad de Aprendizaje.

### Estadística

Propiedad cuantitativa observada de un conjunto de datos.

- Ejemplo: "El 95% de las transacciones de Amazon se clasifican como Gasto Operativo."
- Validación: Cálculo verificable.
- Caducidad: Se recalcula periódicamente.
- Dueño: Sistema.

### Configuración

Parámetro que define cómo funciona el sistema.

- Ejemplo: "El motor de clasificación usa umbrales de confianza del 80%."
- Validación: Declaración de autoridad.
- Caducidad: Cuando la autoridad cambia la configuración.
- Dueño: Autoridad Operativa.

---

## Ciclo de Vida del Conocimiento

Toda pieza de conocimiento tiene un ciclo de vida que comienza con su origen y termina con su archivado.

### Estados del ciclo de vida

1. **Propuesto:** Una autoridad de aprendizaje sugiere nuevo conocimiento.
2. **Observado:** El sistema detecta evidencia que lo sostiene.
3. **Validado:** Una autoridad operativa confirma que es correcto.
4. **Estable:** El conocimiento se aplica consistentemente.
5. **Cuestionado:** Evidencia nueva lo contradice.
6. **Obsoleto:** Una autoridad lo declara no vigente.
7. **Archivado:** Se preserva para referencia futura pero no se aplica.

### Propiedades del ciclo de vida

- **Transiciones:** Solo pueden ocurrir en el orden establecido (no se puede ir de Propuesto a Estable sin pasar por Observado y Validado).
- **Reversibilidad:** Un conocimiento archivado puede reactivarse si reaparece la evidencia.
- **Auditoría:** Cada transición queda registrada con timestamp y autoridad.

---

## El Conocimiento Nunca se Modifica; Evoluciona

Esta es una propiedad fundamental.

No se reemplaza una pieza de conocimiento.

Se crea una nueva versión.

**Ejemplo:**

- Versión 1 (2026-01-15): "Amazon siempre es Gasto Operativo." (Confianza: 95%)
- Versión 2 (2026-06-20): "Amazon es Gasto Operativo excepto cuando se compra equipo." (Confianza: 90%)

La versión 1 no desaparece.

Se archiva.

Esto permite:

- Auditoría completa de la evolución del conocimiento.
- Comparación entre versiones.
- Reversión si la versión nueva resulta incorrecta.
- Trazabilidad de por qué cambió.

---

## Resumen de Principios

| # | Principio | Enunciado |
|---|-----------|-----------|
| P1 | Definición | El Knowledge Engine es el subsistema responsable de adquirir, validar, almacenar, evolucionar, explicar y suministrar conocimiento empresarial persistente |
| P2 | Conocimiento ≠ Dato ≠ Regla | Conocimiento es comprensión persistente, no datos aislados ni reglas binarias |
| P3 | Frontera del conocimiento | Solo persiste lo que representa un patrón estable del negocio |
| P4 | Autoridad jerárquica | Autoridad Operativa > Autoridad de Aprendizaje > Autoridad de Contexto |
| P5 | Aprendizaje por evidencia | No se aprende de datos aislados, solo de repeticiones consistentes |
| P6 | Desaprendizaje por contradicción | No se olvida por antigüedad, se olvida por contradicción |
| P7 | Confianza proporcional | El nivel de confianza nunca supera el nivel de evidencia |
| P8 | Corrección inmediata | Toda corrección de una autoridad se aplica de inmediato |
| P9 | Explicabilidad obligatoria | Si no se puede explicar, no se debería haber decidido |
| P10 | Límites explícitos | El sistema tiene un scope claro que no puede exceder |
| P11 | Autoridad necesaria | Todo conocimiento requiere supervisión de una autoridad |
| P12 | Pieza fundamental = Pieza de conocimiento | Todo conocimiento se almacena como unidades con confianza y evidencia |
| P13 | Tipos de conocimiento | El conocimiento tiene tipos diferentes que evolucionan de manera diferente |
| P14 | Ciclo de vida | Todo conocimiento tiene un ciclo de vida: propuesto → observado → validado → estable → cuestionado → obsoleto → archivado |
| P15 | Evolución, no modificación | El conocimiento nunca se modifica; se crea una nueva versión |
| P16 | Conocimiento empresa-específico | Lo que es verdad para una empresa no es necesariamente verdad para otra |
| P17 | Trazabilidad total | Todo conocimiento tiene origen, evidencia, historia y estado |
| P18 | Razonamiento | El Knowledge Engine debe poder responder qué sabe, por qué lo sabe, y qué tan seguro está |

---

## Criterio de Finalización

Este documento está completo cuando:

1. Las 12 preguntas originales tienen respuesta.
2. Los 18 principios están definidos.
3. La pieza fundamental (Pieza de conocimiento) está definida formalmente.
4. Los tipos de conocimiento (Hecho, Patrón, Preferencia, Política, Relación, Excepción, Hipótesis, Inferencia, Estadística, Configuración) están definidos formalmente.
5. El ciclo de vida del conocimiento está definido formalmente.
6. La evolución del conocimiento (no modificación) está definida como principio.
7. El usuario aprueba el documento como contrato para fases posteriores.

Hasta esa aprobación, no se inicia la Fase 2 (Modelo Conceptual).

---

**Documento:** knowledge-engine-principles.md
**Versión:** 3.0
**Estado:** Borrador — pendiente aprobación
