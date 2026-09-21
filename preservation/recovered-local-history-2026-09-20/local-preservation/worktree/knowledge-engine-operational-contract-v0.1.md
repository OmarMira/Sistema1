# Knowledge Engine — Contrato Operativo v0.1

**Versión:** 0.1
**Fecha:** 2026-09-07
**Estado:** Borrador
**Fuentes oficiales:** conocimiento-general.md v1.11, knowledge-engine-principles.md v3.0, Knowledge Engine Contract v1.0, Mapa de Estado del Conocimiento — Etapa 2 (2026-09-07)

---

## 1. Propósito operativo

El Knowledge Engine debe operar como el subsistema responsable de **adquirir, validar, almacenar, evolucionar, explicar y suministrar conocimiento empresarial persistente**.

**Fuente:** knowledge-engine-principles.md v3.0, línea 12.

El Knowledge Engine no es un motor de reglas, no es un sistema de inferencia, no es un cache. Es la memoria empresarial: aquello que el negocio sabe sobre sí mismo.

**Fuente:** knowledge-engine-principles.md v3.0, líneas 14-20.

---

## 2. Responsabilidades operativas

| Responsabilidad | Fuente |
|-----------------|--------|
| Adquirir conocimiento (explícita o por aprendizaje) | knowledge-engine-principles.md v3.0, línea 12 |
| Validar conocimiento contra evidencia | knowledge-engine-principles.md v3.0, §Qué es evidencia; conocimiento-general.md v1.11, §Qué es evidencia |
| Almacenar conocimiento de forma persistente | knowledge-engine-principles.md v3.0, línea 12; knowledge-engine-principles.md v3.0, §Pregunta 3 |
| Evolucionar conocimiento (crear nueva versión, no modificar) | knowledge-engine-principles.md v3.0, línea 12; conocimiento-general.md v1.11, §Evolución |
| Explicar decisiones tomadas usando conocimiento | knowledge-engine-principles.md v3.0, línea 12; knowledge-engine-principles.md v3.0, §Pregunta 10; conocimiento-general.md v1.11, §Qué significa explicar |
| Suministrar conocimiento a otros subsistemas | knowledge-engine-principles.md v3.0, línea 12; knowledge-engine-principles.md v3.0, §Pregunta 1 |
| Desaprender conocimiento obsoleto o contradicho | knowledge-engine-principles.md v3.0, §Pregunta 7; conocimiento-general.md v1.11, §Qué significa desaprender |
| Mantener trazabilidad completa del conocimiento | knowledge-engine-principles.md v3.0, §Trazabilidad; conocimiento-general.md v1.11, §Trazabilidad |

---

## 3. Entradas permitidas

El Knowledge Engine puede recibir los siguientes tipos de información:

| Tipo de entrada | Descripción | Fuente |
|-----------------|-------------|--------|
| Observaciones | Percepción de un aspecto del negocio: PDF importado, CSV bancario, API financiera, acción de usuario, declaración de contador | conocimiento-general.md v1.11, §Observación |
| Datos aislados | Hechos extraídos de observaciones sin contexto | conocimiento-general.md v1.11, §Dato |
| Afirmaciones de negocio | Proposiciones evaluables sobre el negocio con sujeto, predicado, contexto y evidencia | conocimiento-general.md v1.11, §Qué es una afirmación de negocio |
| Declaraciones explícitas de autoridad | Normas fiscales, políticas contables, preferencias declaradas por autoridad operativa | knowledge-engine-principles.md v3.0, §Pregunta 5; conocimiento-general.md v1.11, §Adquisición explícita |
| Correcciones de autoridad | Correcciones inmediatas aplicadas por autoridad operativa | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| Patrones observados | Comportamientos que se repiten con consistencia suficiente | knowledge-engine-principles.md v3.0, §Pregunta 6; conocimiento-general.md v1.11, §Patrón |

---

## 4. Salidas permitidas

El Knowledge Engine puede producir los siguientes tipos de resultados:

| Tipo de salida | Descripción | Fuente |
|----------------|-------------|--------|
| Unidades de Conocimiento validadas | Afirmaciones respaldadas por evidencia dentro de un contexto determinado, con identidad, tipo, origen, evidencia, contexto, ámbito, historia, trazabilidad, relaciones | conocimiento-general.md v1.11, §Unidad de Conocimiento; conocimiento-general.md v1.11, §Trazabilidad |
| Explicaciones de decisiones | Qué se decidió, por qué, con qué evidencia, cuándo se aprendió, si hubo excepciones | knowledge-engine-principles.md v3.0, §Pregunta 10; conocimiento-general.md v1.11, §Qué significa explicar |
| Niveles de confianza | Nivel de confianza que nunca supera la fuerza de la evidencia que lo respalda | knowledge-engine-principles.md v3.0, §Pregunta 8; conocimiento-general.md v1.11, §Qué es evidencia |
| Estados epistemológicos | Clasificación entre "saber" (respaldado por evidencia) y "creer" (evidencia insuficiente) | conocimiento-general.md v1.11, §Saber y creer |
| Propuestas de conocimiento nuevo | Hipótesis o inferencias derivadas para validación por autoridad | knowledge-engine-principles.md v3.0, §Pregunta 5 (Autoridad de Aprendizaje); conocimiento-general.md v1.11, §Hipótesis; conocimiento-general.md v1.11, §Inferencia |
| Alertas de contradicción | Detección de evidencia que contradice conocimiento existente | knowledge-engine-principles.md v3.0, §Pregunta 7; conocimiento-general.md v1.11, §Qué significa desaprender |

---

## 5. Operaciones permitidas

| Operación | Descripción | Fuente |
|-----------|-------------|--------|
| Adquirir conocimiento por declaración explícita de autoridad | Incorporación directa de conocimiento por autoridad operativa (normas fiscales, políticas, preferencias) | knowledge-engine-principles.md v3.0, §Pregunta 5; conocimiento-general.md v1.11, §Adquisición explícita |
| Adquirir conocimiento por aprendizaje | Detectar patrones en evidencia y proponer como conocimiento (requiere validación) | knowledge-engine-principles.md v3.0, §Pregunta 6; conocimiento-general.md v1.11, §Adquisición por aprendizaje |
| Validar conocimiento contra evidencia | Verificar que la evidencia sostiene la afirmación dentro del contexto | knowledge-engine-principles.md v3.0, §Pregunta 8; conocimiento-general.md v1.11, §Qué es evidencia |
| Aplicar corrección inmediata de autoridad | Aplicar corrección de autoridad operativa de inmediato para la transacción específica | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| Registrar corrección como evidencia | Toda corrección de autoridad se registra como evidencia | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| Evolucionar conocimiento | Crear nueva versión manteniendo versión anterior (nunca modificar) | conocimiento-general.md v1.11, §Evolución |
| Explicar decisión | Responder: qué se decidió, por qué, con qué evidencia, cuándo se aprendió, si hubo excepciones | knowledge-engine-principles.md v3.0, §Pregunta 10; conocimiento-general.md v1.11, §Qué significa explicar |
| Desaprender por contradicción | Dejar de considerar válida una afirmación cuando evidencia reciente y consistente la contradice | knowledge-engine-principles.md v3.0, §Pregunta 7; conocimiento-general.md v1.11, §Qué significa desaprender |
| Clasificar entre saber y creer | Diferenciar estados epistemológicos según fuerza de evidencia | conocimiento-general.md v1.11, §Saber y creer |
| Mantener red de relaciones | Conectar unidades de conocimiento entre sí | conocimiento-general.md v1.11, §Red de conocimiento |

---

## 6. Operaciones prohibidas

| Operación prohibida | Motivo | Fuente |
|---------------------|--------|--------|
| Tomar decisiones contables | Responsabilidad del contador | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Aprobar transacciones | Responsabilidad de una autoridad | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Reemplazar el juicio humano | En situaciones nuevas o ambiguas | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Predecir el futuro | Solo puede extrapolar del pasado | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Aprender de datos que no existen | Requiere evidencia existente | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Garantizar que todo conocimiento aprendido sea correcto | No puede garantizar corrección absoluta | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Funcionar sin supervisión de autoridad humana | Requiere supervisión | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Resolver complejidad contable | Responsabilidad del motor contable | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Resolver cumplimiento regulatorio | Responsabilidad de auditoría | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Tomar decisiones estratégicas | Responsabilidad de la dirección | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Resolver situaciones sin precedentes | No puede aprender lo que nunca vio | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Compensar errores de datos | Si el dato viene mal parseado, el conocimiento no puede compensarlo | knowledge-engine-principles.md v3.0, §Pregunta 12 |
| Resolver conflictos entre empresas | Conocimiento de una empresa no se aplica a otra sin autorización | knowledge-engine-principles.md v3.0, §Pregunta 12 |
| Modificar conocimiento existente | Nunca se modifica; se crea nueva versión | conocimiento-general.md v1.11, §Evolución |
| Eliminar conocimiento por antigüedad | Solo se elimina por contradicción | knowledge-engine-principles.md v3.0, §Pregunta 4; conocimiento-general.md v1.11, §Qué significa desaprender |
| Mezclar configuración con conocimiento | La configuración define CÓMO; el conocimiento define QUÉ | conocimiento-general.md v1.11, §Ámbitos de conocimiento |
| Aplicar conocimiento sin autorización operacional | La verdad no depende de la autorización, pero la aplicación sí | conocimiento-general.md v1.11, §Verdad y autorización |

---

## 7. Invariantes operativos

| Invariante | Descripción | Fuente |
|------------|-------------|--------|
| Identidad inmutable | La identidad de una unidad de conocimiento es permanente e inmutable; si el contenido cambia, se crea nueva versión | conocimiento-general.md v1.11, §Identidad de una afirmación; §Origen |
| Evolución, no modificación | El conocimiento nunca se modifica; se crea una nueva versión | conocimiento-general.md v1.11, §Evolución |
| Origen inmutable | El origen de una unidad de conocimiento no cambia | conocimiento-general.md v1.11, §Origen |
| Confianza proporcional a evidencia | El nivel de confianza nunca supera la fuerza de la evidencia que lo respalda | knowledge-engine-principles.md v3.0, §Pregunta 8; conocimiento-general.md v1.11, §Qué es evidencia |
| Evidencia verificable | Toda afirmación de conocimiento debe sostenerse con evidencia verificable | conocimiento-general.md v1.11, §Qué es evidencia |
| Contexto suficiente | Toda afirmación debe tener contexto suficiente para determinar cuándo aplica | conocimiento-general.md v1.11, §Qué es contexto |
| Explicabilidad obligatoria | Si no se puede explicar, no se debería haber decidido | knowledge-engine-principles.md v3.0, §Pregunta 10; conocimiento-general.md v1.11, §Qué significa explicar |
| Jerarquía de autoridades | Autoridad Operativa > Autoridad de Aprendizaje > Autoridad de Contexto; ninguna puede contradecir a una superior | knowledge-engine-principles.md v3.0, §Pregunta 5 |
| Corrección inmediata de autoridad | Toda corrección de una autoridad se aplica de inmediato | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| Distinción excepción vs cambio de patrón | El sistema debe distinguir entre excepción (corrección aislada) y cambio de patrón (corrección consistente) | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| No eliminación por antigüedad | El conocimiento no se elimina por antigüedad; se elimina por contradicción | knowledge-engine-principles.md v3.0, §Pregunta 4; conocimiento-general.md v1.11, §Qué significa desaprender |
| Desaprendizaje requiere misma evidencia | El desaprendizaje requiere la misma evidencia que el aprendizaje | knowledge-engine-principles.md v3.0, §Pregunta 7 |
| Separación configuración/conocimiento | La configuración define CÓMO funciona el sistema; el conocimiento define QUÉ sabe el sistema; nunca deben mezclarse | conocimiento-general.md v1.11, §Ámbitos de conocimiento |
| Trazabilidad completa | Toda unidad debe poder reconstruir su historia completa | knowledge-engine-principles.md v3.0, §P17; conocimiento-general.md v1.11, §Trazabilidad |
| Red de conocimiento | El conocimiento forma una red de relaciones donde cada unidad puede conectarse con otras | conocimiento-general.md v1.11, §Red de conocimiento |
| Conocimiento empresa-específico | Lo que es verdad para una empresa no es necesariamente verdad para otra | knowledge-engine-principles.md v3.0, §P16; conocimiento-general.md v1.11, §Ámbitos de conocimiento |

---

## 8. Precondiciones operativas

| Precondición | Descripción | Fuente |
|--------------|-------------|--------|
| Existencia de autoridad operativa | Debe existir al menos una autoridad operativa para validar conocimiento | knowledge-engine-principles.md v3.0, §Pregunta 5 |
| Evidencia verificable disponible | Para validar conocimiento, debe existir evidencia verificable | conocimiento-general.md v1.11, §Qué es evidencia |
| Contexto definido | Para almacenar conocimiento, debe existir contexto suficiente | conocimiento-general.md v1.11, §Qué es contexto |
| Identidad semántica definida | Para detectar duplicados, debe poder calcularse identidad semántica | conocimiento-general.md v1.11, §Identidad de una afirmación |
| Autoridad de aprendizaje condicionada | La autoridad de aprendizaje solo puede proponer, no aplicar sin validación | knowledge-engine-principles.md v3.0, §Pregunta 5 |
| Configuración separada | La configuración del sistema debe estar separada del conocimiento | conocimiento-general.md v1.11, §Ámbitos de conocimiento |

---

## 9. Postcondiciones operativas

| Postcondición | Descripción | Fuente |
|---------------|-------------|--------|
| Trazabilidad completa registrada | Cada transición de conocimiento queda registrada con timestamp y autoridad | knowledge-engine-principles.md v3.0, §P17; conocimiento-general.md v1.11, §Trazabilidad |
| Versión anterior conservada | Al evolucionar conocimiento, la versión anterior se conserva | conocimiento-general.md v1.11, §Evolución |
| Explicación disponible | Cualquier decisión tomada usando conocimiento puede ser explicada | knowledge-engine-principles.md v3.0, §Pregunta 10; conocimiento-general.md v1.11, §Qué significa explicar |
| Evidencia registrada | Correcciones y validaciones quedan registradas como evidencia | knowledge-engine-principles.md v3.0, §Pregunta 9; conocimiento-general.md v1.11, §Qué es evidencia |
| Confianza actualizada | Nivel de confianza refleja fuerza de evidencia actual | knowledge-engine-principles.md v3.0, §Pregunta 8; conocimiento-general.md v1.11, §Qué es evidencia |
| Estado epistemológico actualizado | Clasificación saber/creer refleja evidencia actual | conocimiento-general.md v1.11, §Saber y creer |
| Red de relaciones actualizada | Relaciones entre unidades de conocimiento se mantienen | conocimiento-general.md v1.11, §Red de conocimiento |

---

## 10. Errores contractuales

| Error contractual | Descripción | Fuente |
|-------------------|-------------|--------|
| CONTRADICTION_DETECTED | Evidencia nueva contradice conocimiento establecido; requiere desaprendizaje o evolución | knowledge-engine-principles.md v3.0, §Pregunta 7; conocimiento-general.md v1.11, §Qué significa desaprender |
| AUTHORITY_VIOLATION | Autoridad de menor jerarquía intenta contradecir a superior | knowledge-engine-principles.md v3.0, §Pregunta 5 |
| INSUFFICIENT_EVIDENCE | Intento de validar conocimiento sin evidencia suficiente | knowledge-engine-principles.md v3.0, §Pregunta 8; conocimiento-general.md v1.11, §Qué es evidencia |
| CONTEXT_MISSING | Intento de almacenar conocimiento sin contexto suficiente | conocimiento-general.md v1.11, §Qué es contexto |
| IDENTITY_CONFLICT | Dos afirmaciones con identidad semántica distinta intentan usar misma identidad | conocimiento-general.md v1.11, §Identidad de una afirmación |
| UNAUTHORIZED_OPERATION | Intento de operación prohibida (ver §6) | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| CONFIDENCE_EXCEEDS_EVIDENCE | Nivel de confianza supera fuerza de evidencia | knowledge-engine-principles.md v3.0, §Pregunta 8; conocimiento-general.md v1.11, §Qué es evidencia |
| EXPLANATION_UNAVAILABLE | Decisión no puede ser explicada | knowledge-engine-principles.md v3.0, §Pregunta 10; conocimiento-general.md v1.11, §Qué significa explicar |
| TRACEABILITY_BROKEN | Imposible reconstruir historia completa de una unidad | knowledge-engine-principles.md v3.0, §P17; conocimiento-general.md v1.11, §Trazabilidad |
| CONFIG_KNOWLEDGE_MIXED | Configuración y conocimiento mezclados | conocimiento-general.md v1.11, §Ámbitos de conocimiento |
| AUTHORITY_HIERARCHY_VIOLATED | Autoridad inferior contradecía a superior | knowledge-engine-principles.md v3.0, §Pregunta 5 |

---

## 11. Límites de autoridad

| Lo que PUEDE decidir el Knowledge Engine | Fuente |
|------------------------------------------|--------|
| Clasificar una transacción según conocimiento validado | knowledge-engine-principles.md v3.0, §Pregunta 1 |
| Proponer nuevo conocimiento basado en patrones observados | knowledge-engine-principles.md v3.0, §Pregunta 5 (Autoridad de Aprendizaje) |
| Detectar contradicciones y alertar | knowledge-engine-principles.md v3.0, §Pregunta 7 |
| Aplicar corrección inmediata de autoridad operativa | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| Distinguir entre excepción y cambio de patrón | knowledge-engine-principles.md v3.0, §Pregunta 9 |
| Calcular nivel de confianza basado en evidencia | knowledge-engine-principles.md v3.0, §Pregunta 8 |
| Explicar decisiones tomadas | knowledge-engine-principles.md v3.0, §Pregunta 10 |
| Clasificar estado epistemológico (saber/creer) | conocimiento-general.md v1.11, §Saber y creer |
| Evolucionar conocimiento (crear nueva versión) | conocimiento-general.md v1.11, §Evolución |
| Mantener red de relaciones entre unidades | conocimiento-general.md v1.11, §Red de conocimiento |

| Lo que NUNCA puede decidir el Knowledge Engine | Fuente |
|------------------------------------------------|--------|
| Tomar decisiones contables | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Aprobar transacciones | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Reemplazar el juicio humano en situaciones nuevas o ambiguas | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Predecir el futuro | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Aprobar conocimiento nuevo sin validación de autoridad operativa | knowledge-engine-principles.md v3.0, §Pregunta 5 |
| Ignorar corrección de autoridad operativa | knowledge-engine-principles.md v3.0, §Pregunta 5; §Pregunta 9 |
| Contradecir a una autoridad superior | knowledge-engine-principles.md v3.0, §Pregunta 5 |
| Eliminar conocimiento por antigüedad | knowledge-engine-principles.md v3.0, §Pregunta 4 |
| Mezclar configuración con conocimiento | conocimiento-general.md v1.11, §Ámbitos de conocimiento |
| Aplicar conocimiento sin autorización operacional | conocimiento-general.md v1.11, §Verdad y autorización |
| Interpretar nuevas regulaciones | knowledge-engine-principles.md v3.0, §Pregunta 11 |
| Detectar intención fraudulenta | knowledge-engine-principles.md v3.0, §Pregunta 12 |
| Compensar errores de datos de entrada | knowledge-engine-principles.md v3.0, §Pregunta 12 |

---

**Documento:** knowledge-engine-operational-contract-v0.1.md
**Versión:** 0.1
**Estado:** Borrador — primer borrador operativo