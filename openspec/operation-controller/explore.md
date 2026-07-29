# Operation Controller — Explore

## Problema exacto
La IA puede ejecutar comandos destructivos sobre el sistema porque no existe una capa determinista que intercepte, autorice y verifique cada operación antes de que alcance un recurso protegido.

## Principio rector
La IA nunca interactúa directamente con un recurso protegido. Toda interacción ocurre exclusivamente mediante el Controller.

## Objetivo medible
Toda operación sobre un recurso protegido debe pasar por el Controller. Ninguna operación ejecutada sobre un recurso protegido puede carecer de evidencia, autorización y verificación.

## Activos protegidos (por categoría)
- **Control de versiones**: historial Git, ramas, worktrees, remotos
- **Persistencia**: base de datos, schema, migraciones, datos
- **Sistema de archivos**: código fuente, configuraciones, documentación, artefactos
- **Configuración**: archivos de proyecto, variables de entorno, policies del Controller
- **Secretos**: credenciales, tokens, claves, .env
- **Procesos**: binarios, scripts, shell, npm, npx
- **Red**: APIs externas, servicios, endpoints
- **Herramientas externas**: Prisma, Docker, SSH, CLI tools
- **Estado del sistema**: consistencia entre recursos (ej: archivos vs Git vs BD no deben divergir sin registro)

## Incidentes que debe prevenir
1. Destrucción o modificación no autorizada de metadatos de migraciones (_prisma_migrations).
2. Contaminación del repositorio con artefactos no trackeados.
3. Improvisación de workarounds ante resultados inesperados.
4. Ejecución de cualquier operación fuera del alcance delimitado por el Execution Contract vigente.

## Actores
- **IA** (modelo de lenguaje) — Solicita operaciones de alto nivel. Nunca accede directamente a recursos protegidos.
- **Operador humano** — Autoriza operaciones fuera del alcance automático. Revisa evidencia. Decide abortar.
- **Controller** — Autoriza la operación contra las políticas vigentes. No ejecuta directamente sobre recursos.
- **Executor** — Ejecuta la operación autorizada contra el recurso protegido siguiendo las instrucciones del Controller.
- **Verifier** — Verifica el resultado post-ejecución contra el estado esperado.
- **Evidence Logger** — Registra toda operación con su plan, autorización, ejecución, verificación y resultado. Debe poder contrastarse con el estado real del recurso.
- **Recursos protegidos** — Las categorías definidas arriba.

## Restricciones (qué NO hace el sistema)
- NO decide qué código modificar ni genera cambios por iniciativa propia; solo ejecuta operaciones delimitadas por un Execution Contract autorizado.
- NO interpreta intención ni adivina lo que el operador "quiere decir"
- NO decide prioridades ni secuencia de operaciones
- NO corrige errores lógicos en el código generado
- NO ejecuta heurísticas ni aproximaciones
- NO reemplaza al operador humano en decisiones de alto riesgo
- NO reemplaza Git, Prisma ni PostgreSQL — los orquesta bajo reglas
- NO amplía el Intent ni el Execution Contract; ejecuta exclusivamente los límites autorizados.
- NO valida lógica de negocio
- NO garantiza consistencia del estado del sistema — solo la registra y la expone

## Límites de confianza
**Confiamos en:** el Controller (código determinista con pruebas, revisable en PR), el operador humano, el audit log como fuente única de verdad post-mortem.

**NO confiamos en:** el modelo de IA para seguir instrucciones, evaluar sus propios límites, detectar consecuencias no deseadas, autocorregirse sin el Controller. Ningún system prompt, fine-tuning o mensaje de sistema como mecanismo de control.

## Amenazas
| Amenaza | Probabilidad | Impacto |
|---|---|---|
| Destrucción de datos (DELETE/UPDATE masivo sin filtro) | Alta | Crítico |
| Contaminación del repositorio (archivos no trackeados, node_modules en worktree) | Alta | Alto |
| Exfiltración de secretos (leer .env, enviar a externo) | Media | Crítico |
| Ejecución de binarios no autorizados (npm, npx, scripts shell) | Alta | Alto |
| Bypass del Controller (invocar recursos directamente sin pasar por el Controller) | Baja | Crítico |
| Escalamiento de operación (solicitar lectura pero ejecutar escritura) | Media | Alto |
| Loop de bypass (variaciones sucesivas hasta encontrar un agujero) | Media | Medio |
| Operaciones parcialmente ejecutadas (estado inconsistente entre recursos) | Alta | Alto |
| Divergencia entre plan aprobado y ejecución real | Alta | Alto |
| Divergencia entre evidencia registrada y estado real del sistema | Media | Crítico |
| Modificación de archivos del Controller por parte de la IA | Baja | Crítico |

## Decisiones fuera de alcance
- No mejora la calidad del código generado por la IA
- No valida lógica de negocio
- No reemplaza code review humano
- No previene errores lógicos, bugs o regresiones en el código generado
- No gestiona secretos ni credenciales (solo bloquea su exposición)
- No es un orquestador de CI/CD ni reemplaza las gates del SOP
- No valida el comportamiento interno del modelo de IA
- No detecta jailbreaks — el canal IA→Controller es el único punto de interacción
- No resuelve conflictos de merge automáticamente
- No decide qué operaciones ejecutar — solo valida y ejecuta lo autorizado
- No garantiza consistencia del estado — la expone para decisión humana