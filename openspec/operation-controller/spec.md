# Operation Controller — Spec

## 1. Recursos protegidos

| Categoría | Definición |
|---|---|
| **Control de versiones** | Historial, ramas, etiquetas, worktrees, remotos, configuración de versionado |
| **Sistema de archivos** | Archivos de código fuente, configuraciones, documentación, artefactos, archivos temporales con valor |
| **Persistencia** | Bases de datos, esquemas, migraciones, estados persistentes, archivos de datos |
| **Secretos** | Credenciales, tokens, claves, variables de entorno con valor sensible, archivos .env |
| **Configuración del sistema** | Archivos de proyecto, policies del Controller, archivos de orquestación |
| **Procesos** | Binarios, scripts, shells, instaladores, gestores de paquetes |
| **Red** | APIs externas, servicios, endpoints, conexiones de red |
| **Herramientas externas** | CLIs, SDKs, wrappers, programas de terceros |
| **Estado del sistema** | Consistencia entre recursos — divergencias entre estado real y registro de evidencia |

## 2. Operaciones

| Operación | Símbolo | Definición |
|---|---|---|
| **Read** | R | Obtener estado o contenido sin modificar el recurso |
| **Create** | C | Introducir un nuevo recurso o instancia dentro de un recurso |
| **Modify** | M | Alterar el estado o contenido de un recurso existente |
| **Delete** | D | Eliminar un recurso o instancia existente |
| **Execute** | X | Ejecutar un proceso, script, comando o pipeline sobre un recurso |
| **Connect** | K | Establecer conexión de red, montaje o enlace con un recurso externo |

## 3. Capacidades (Capabilities)

Capability: `(requester, tipo_recurso, operación, modo_aprobación)`.

**Modos de aprobación:** granted, requires-approval, requires-dual, denied.

**NO existen perfiles predefinidos.** Policy solo pregunta: ¿el requester tiene esta capability? SI → continúa. NO → rechaza.

**NO existe Admin como bypass.** Todo requester, incluido el operador con máximos privilegios, pasa por el mismo pipeline. Admin tiene más capabilities que otros requesters, pero nunca elude el proceso.

**Asignación:** policy de asignación inmutable durante el plan de trabajo. Solo un requester con capability `Configuración.Modify` puede modificarla. No existe autoconcesión.

## 4. Pipeline único

```
Intent → Policy → Execution Contract → Execute → Verify
                                                        ↑
                                                 Evidence (transversal, append-only)
```

Evidence Logger es transversal: registra en cada etapa. No es una etapa más.

### Etapa 0: Requester
Formula una solicitud. Nunca tiene acceso directo al recurso.

### Etapa 1: Intent
El Intent es la declaración explícita del estado deseado aprobada para una operación. Es la fuente de verdad de lo que se debe ejecutar. No prescribe cómo lograrlo. Toda la cadena posterior está subordinada al Intent.

### Etapa 2: Policy
Determina el modo de autorización aplicable según las capabilities vigentes del requester sobre el recurso target. Si no existe una capability válida, el resultado es `denied`. Resuelve un modo: granted, requires-approval, requires-dual, denied.

### Etapa 3: Execution Contract
Describe exactamente qué quedó autorizado: target del recurso, operaciones permitidas, efectos permitidos, efectos prohibidos, budget, estado esperado. El Contract nunca puede ampliar el Intent. Solo puede detallarlo. Sin Contract → no hay ejecución.

### Etapa 4: Execute
Execute solicita la ejecución del Execution Contract sobre el recurso protegido.

### Etapa 5: Verify
Confirma que el estado real cumple exactamente el Execution Contract autorizado y que no existen efectos fuera de su alcance. Si la verificación falla, la operación se marca como fallida y escala a humano.

### Evidence Logger (transversal)
Registra en cada etapa del pipeline: Intent original, Contract, resolución de política, ejecución, verificación. Registro oficial, ordenado e inmutable de la operación; debe poder contrastarse con el estado real del recurso. Registro incompleto → operación fallida.

## 5. Reglas invariantes

| ID | Invariante |
|---|---|
| I1 | **No bypass**: ninguna operación sobre un recurso protegido ocurre fuera del pipeline único |
| I2 | **No ejecución sin evidencia**: registro completo en cada etapa |
| I3 | **No escalamiento implícito**: sin capability explícita → rechazo |
| I4 | **Fail closed**: incertidumbre en política, autorización o verificación → rechazo |
| I5 | **Idempotencia o declaración**: toda operación idempotente o declara no serlo. Las no idempotentes requieren requires-approval mínimo |
| I6 | **Toda operación mutable requiere verificación posterior** |
| I7 | **Toda operación irreversible requiere aprobación reforzada** (requires-dual mínimo) |
| I8 | **No auto-modificación del Controller** |
| I9 | **Orden estricto**: etapas secuenciales, no saltables, no reordenables |
| I10 | **Una operación, un registro completo** |
| I11 | **Policy antes que Execute**: toda ejecución requiere un Contract autorizado |
| I12 | **Intent antes que Contract**: toda ejecución requiere un Intent aprobado |
| I13 | **El Contract nunca amplía el Intent**: solo lo detalla. Si el Contract excede el Intent → rechazo |
| I14 | **El Controller debe garantizar que cualquier violación del Budget sea detectada y produzca una operación fallida** |
| I15 | Verify debe confirmar que el estado real cumple exactamente el Execution Contract autorizado y que no existen efectos fuera de su alcance |

## 6. Requisitos funcionales

| ID | Requisito |
|---|---|
| RF01 | Interceptar toda solicitud sobre un recurso protegido antes de que alcance el recurso |
| RF02 | Exigir un Intent aprobado antes de cualquier procesamiento |
| RF03 | Validar que la solicitud pueda representarse mediante un Intent válido |
| RF04 | Generar un Execution Contract que detalle el Intent sin ampliarlo |
| RF05 | Rechazar cualquier Contract que exceda el Intent |
| RF06 | El Controller debe garantizar que cualquier violación del Budget sea detectada y produzca una operación fallida |
| RF07 | Resolver capabilities del requester contra la policy activa |
| RF08 | Soportar cuatro modos de aprobación: granted, requires-approval, requires-dual, denied |
| RF09 | Ejecutar exactamente el Contract autorizado sin interpretación ni desviación |
| RF10 | Verificar que el estado real cumpla exactamente el Execution Contract autorizado y que no existan efectos fuera de su alcance |
| RF11 | Registrar evidencia en cada etapa del pipeline (transversal) |
| RF12 | Detener el pipeline si una etapa falla; no continuar sin intervención |
| RF13 | Soportar políticas de asignación configurables |
| RF14 | Garantizar que ningún requester puede modificar sus propias capabilities |

## 7. Requisitos no funcionales

| ID | Requisito |
|---|---|
| RNF01 | Determinismo: misma solicitud + misma política + mismo estado → misma decisión |
| RNF02 | Audibilidad: toda operación reconstruible desde el registro sin ambigüedad |
| RNF03 | Integridad del registro: inmutable, no modificable ni eliminable |
| RNF04 | Aislamiento: el Controller no depende del requester para determinar sus reglas |
| RNF05 | Latencia acotada: resolución de política en tiempo independiente de la operación |
| RNF06 | Disponibilidad: el Controller no falla por falla de un recurso externo |
| RNF07 | Seguridad por diseño: asumir todo requester hostil hasta que sus capabilities demuestren lo contrario |
| RNF08 | Portabilidad: sin dependencia de lenguaje, framework, SO o herramienta concreta |
| RNF09 | Verificabilidad: conjunto de pruebas que demuestre cada invariante |
| RNF10 | Recuperabilidad: reportar último estado conocido tras interrupción |

## 8. Estados de operación

```
requested → [denied | authorized] → executing → executed → [verified | failed]
                                                               ↓
                                                           completed
```

| Estado | Significado | Terminal |
|---|---|---|
| **requested** | Solicitud emitida y recibida | No |
| **denied** | Policy rechazó la operación | Sí |
| **authorized** | Policy aprobó. Contract generado | No |
| **executing** | Ejecutándose sobre el recurso | No |
| **executed** | Ejecución completada. Pendiente de verificación | No |
| **verified** | Verify confirmó el estado contra el Contract | No |
| **completed** | Operación exitosa | Sí |
| **failed** | Fallo en cualquier etapa | Sí |

## 9. Manejo de fallos

**Policy:** solicitud inválida, Intent inconsistente, capability no encontrada → denied.
**Execute:** error del recurso → failed. Budget excedido → failed.
**Verify:** divergencia Intent/Contract → failed. Divergencia Contract/Real → failed. Efectos secundarios no declarados → failed.
**Evidence Logger:** no se puede escribir → pipeline detenido. Registro incompleto → operación fallida.
**Escalamiento humano:** toda operación failed escala con registro completo, divergencia detectada y estado del sistema.

## 10. Criterios de aceptación

| ID | Criterio |
|---|---|
| CA01 | Recursos como categorías abstractas |
| CA02 | Operaciones como conjunto completo (R, C, M, D, X, K) |
| CA03 | Capabilities como único mecanismo de permisos. Sin perfiles, sin Admin bypass |
| CA04 | Intent como concepto explícito: fuente de verdad de lo aprobado |
| CA05 | Contract nunca amplía el Intent |
| CA06 | Controller detecta violaciones de Budget y produce operación fallida |
| CA07 | Evidence Logger como capa transversal |
| CA08 | Pipeline completo: Intent → Policy → Execution Contract → Execute → Verify con Evidence transversal |
| CA09 | Policy unifica validación + autorización |
| CA10 | Verify confirma que el estado real cumple exactamente el Execution Contract autorizado y que no existen efectos fuera de su alcance |
| CA11 | Invariantes I1-I15 |
| CA12 | Estados de operación con transiciones y terminalidad explícita |
| CA13 | Manejo de fallos por etapa |
| CA14 | Sin herramientas concretas, comandos, clases, interfaces, estructura de carpetas |
| CA15 | Sin decisiones de implementación |
| CA16 | Sin ampliación del alcance MVP |
| CA17 | Autocontenido |
| CA18 | RF y RNF separados |