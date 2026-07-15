# Gentle AI — Sistema de Desarrollo Asistido

Gentle AI es un agente orquestador basado en OpenCode que coordina equipos de sub-agentes especializados para desarrollar features complejas mediante SDD (Spec-Driven Development). Está configurado con personalidad de arquitecto senior, memoria persistente (Engram), y un workflow estructurado de 8 fases operativas.

---
<!-- TABLE_OF_CONTENTS -->
1. [Arquitectura](#arquitectura)
2. [Workflow SDD](#workflow-sdd)
3. [Personalidad y Reglas](#personalidad-y-reglas)
4. [Memoria Persistente (Engram)](#memoria-persistente-engram)
5. [Sistema de Skills](#sistema-de-skills)
6. [Configuración](#configuracion)
7. [Flujo de Trabajo Típico](#flujo-de-trabajo-tipico)

---

## Arquitectura

```
Usuario
  │
  ▼
┌─────────────────────────────────────────────────┐
│          gentle-orchestrator (PRIMARY)          │
│  Coordina, delega, sintetiza. NO ejecuta inline │
└──────┬──────┬──────┬──────┬──────┬──────┬──────┘
       │      │      │      │      │      │
       ▼      ▼      ▼      ▼      ▼      ▼
    ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
    │sdd-│ │sdd-│ │sdd-│ │sdd-│ │sdd-│ │sdd-│
    │init│ │expl│ │prop│ │spec│ │desi│ │task│
    └────┘ └────┘ └────┘ └────┘ └────┘ └────┘
                               │      │
                               ▼      ▼
                            ┌────┐ ┌────┐
                            │sdd-│ │sdd-│
                            │appl│ │veri│
                            └────┘ └────┘
                               │
                               ▼
                            ┌──────┐
                            │sdd-  │
                            │archiv│
                            └──────┘
```

| Rol | Agente | Responsabilidad |
|-----|--------|-----------------|
| **Orquestador** | `gentle-orchestrator` | Decisiones, coordinación, delegación. Nunca escribe código inline si hay 2+ archivos involucrados. |
| **Explorador** | `sdd-explore` | Investiga el codebase, mapea archivos, compara enfoques. |
| **Proponente** | `sdd-propose` | Redacta propuestas de cambio con criterios de éxito. |
| **Especificador** | `sdd-spec` | Escribe specs delta por dominio. |
| **Diseñador** | `sdd-design` | Documenta arquitectura y approach técnico. |
| **Planificador** | `sdd-tasks` | Desglosa en tareas atómicas. |
| **Implementador** | `sdd-apply` | Escribe código, tests, y documenta progreso. |
| **Validador** | `sdd-verify` | Corre tests y verifica criterios contra código real. |
| **Archivador** | `sdd-archive` | Cierra el cambio y sincroniza delta specs. |

---

## Workflow SDD

Flujo de trabajo de 8 fases operativas. La inicialización (`sdd-init`) ocurre previamente al primer cambio:

```
explore → propose → spec → design → tasks → apply → verify → archive
```

### Fases

| Fase | Qué produce | Gatillante |
|------|-------------|------------|
| **explore** | Mapeo del codebase, opciones | `/sdd-explore <topic>` |
| **propose** | PRD con criterios de éxito | `/sdd-new <change>` |
| **spec** | Specs delta por dominio | `sdd-continue` |
| **design** | Documento de arquitectura | `sdd-continue` |
| **tasks** | Lista de tareas atómicas con estimación | `sdd-continue` |
| **apply** | Código implementado + tests verdes | `/sdd-apply <change>` |
| **verify** | Reporte de verificación contra código real | `/sdd-verify <change>` |
| **archive** | Artefactos archivados, specs sincronizados | `/sdd-archive <change>` |

### Meta-comandos

| Comando | Efecto |
|---------|--------|
| `/sdd-new <change>` | Crea un cambio nuevo: explora + propone |
| `/sdd-ff <name>` | Fast-forward: propone → spec → design → tasks |
| `/sdd-continue` | Ejecuta la siguiente fase lista |
| `/sdd-status` | Muestra estado del cambio activo |

---

## Personalidad y Reglas

Gentle AI tiene una personalidad de **arquitecto senior** con 15+ años de experiencia.

### Cómo habla

- **Directo**: respuestas cortas, al punto. Expande solo si el usuario pide más.
- **Exigente pero por cuidado**: corrige errores explicando el POR QUÉ técnico, no por ego.
- **Conceptos > Código**: prioriza que el usuario entienda el fundamento antes que escribir código.
- **Contra lo inmediato**: no toma atajos. El aprendizaje real requiere esfuerzo.
- **Una pregunta por vez**: pregunta una cosa, espera respuesta. No hace menús enormes.

### Reglas del orquestador

| Regla | Descripción |
|-------|-------------|
| **4-file rule** | Si hay que leer 4+ archivos para entender algo, delega. |
| **Multi-file write** | Si toca 2+ archivos no triviales, delega la escritura. |
| **Fresh review** | Antes de commit/PR, corre una revisión fresh (contexto nuevo). |
| **Incident rule** | Si hubo error de directorio, merge, o workaround, frena y audita. |
| **Long-session rule** | ~20 tool calls sin delegación → pausa y delega. |
| **Size:exception** | Si el cambio estima >400 líneas, requiere aprobación. |

---

## Memoria Persistente (Engram)

Engram es el sistema de memoria que permite a Gentle AI recordar entre sesiones y compactiones.

### Qué guarda automáticamente

Sin esperar a que el usuario lo pida:

- Decisiones de arquitectura
- Bugs encontrados y cómo se arreglaron
- Convenciones del equipo
- Preferencias del usuario
- Patrones establecidos
- Configuraciones y setup del entorno
- Descubrimientos no obvios del codebase

### Formato de guardado

```markdown
**What**: Una línea - qué se hizo
**Why**: Motivación (bug, request, performance)
**Where**: Archivos afectados
**Learned**: Gotchas, edge cases, sorpresas
```

### Cierre de sesión

Antes de terminar, Gentle AI llama obligatoriamente a `mem_session_summary` con:
- Goal, Discoveries, Accomplished, Next Steps, Relevant Files

Esto evita que la próxima sesión arranque ciega.

---

## Sistema de Skills

Skills son instrucciones especializadas que Gentle AI carga según la tarea.

### Skills del Sistema / Orquestador

Estas son las instrucciones y roles del sistema que Gentle AI carga automáticamente según la fase o tarea de desarrollo (algunas de estas son provistas de forma global por la configuración del orquestador y no residen en el directorio local `skills/`):

| Skill | Cuándo se usa |
|-------|---------------|
| `sdd-apply` | Implementar tareas SDD |
| `sdd-verify` | Validar contra specs |
| `sdd-archive` | Archivar cambios |
| `sdd-design` | Diseñar arquitectura |
| `sdd-explore` | Investigar codebase |
| `sdd-init` | Inicializar SDD |
| `sdd-propose` | Redactar propuestas |
| `sdd-spec` | Escribir especificaciones |
| `sdd-tasks` | Planificar tareas |
| `cognitive-doc-design` | Documentación con baja carga cognitiva |
| `work-unit-commits` | Commits como unidades revisables |
| `chained-pr` | PRs encadenados (>400 líneas) |
| `branch-pr` | Crear PRs |
| `judgment-day` | Revisión adversarial dual |
| `comment-writer` | Comentarios en PRs/issues |
| `issue-creation` | Crear issues |
| `skill-creator` / `skill-improver` | Crear/mejorar skills |
| `skill-registry` | Indexar skills |

---

## Configuración

Gentle AI puede recibir configuración desde estas ubicaciones:

| Archivo / Ubicación | Qué define |
|---------|------------|
| `~/.config/opencode/opencode.json` | MCP y reglas locales de permisos |
| Configuración interna del orquestador | Persona, protocolo Engram e instrucciones SDD; su ubicación depende de la instalación |
| `./AGENTS.md` (project root, optional) | Overrides específicos del proyecto |

### Modelos asignados

> **Nota de configuración**: La asignación de modelos depende de la configuración del orquestador y puede variar según la instalación. Los siguientes son los modelos asignados de referencia por defecto:

| Fase | Modelo | Motivo |
|------|--------|--------|
| orchestrator | opus | Coordinación, decisiones |
| sdd-explore | sonnet | Mapeo y lectura de código (estructural) |
| sdd-propose | opus | Decisiones de arquitectura y alcance |
| sdd-spec | sonnet | Escritura estructurada de specs delta |
| sdd-design | opus | Decisiones de arquitectura técnica |
| sdd-tasks | sonnet | Desglose mecánico de tareas |
| sdd-apply | sonnet | Implementación y escritura de código |
| sdd-verify | sonnet | Validación automática contra specs |
| sdd-archive | haiku | Cierre y movimiento de artefactos (liviano) |
| default | sonnet | Delegación general no relacionada con SDD |

---

## Flujo de Trabajo Típico

### Ejemplo: migración de SQLite a PostgreSQL

```
1. Usuario: "haceme un SDD para migrar a PostgreSQL"
2. Orchestrator: preflight (modo, artifact store, estrategia)
3. sdd-init (preliminar) → detecta stack (TypeScript, Vitest, Prisma)
4. sdd-explore → mapea ~25 archivos
5. sdd-propose → 6 criterios de éxito
6. sdd-spec → 3 specs delta
7. sdd-design → arquitectura con mitigaciones
8. sdd-tasks → 27 tareas en 5 fases
9. sdd-apply (x6) → implementación por batches
10. sdd-verify → suite completa, criterios de éxito verificados
11. sdd-archive → artefactos movidos a archive/
12. Commit + push → GitHub
```

### Modos de ejecución

| Modo | Comportamiento |
|------|----------------|
| **Interactive** | Frena después de cada fase, muestra resumen, pregunta antes de seguir |
| **Automatic** | Corre fases seguidas, frena solo si hay riesgo alto |

---

## Referencias

- `~/.config/opencode/opencode.json` — configuración local de agentes, herramientas y permisos; no versionada en este repositorio
- [`skills/`](https://github.com/OmarMira/Account-Express-New-Gen/tree/main/skills) — Skills disponibles
- [`openspec/`](https://github.com/OmarMira/Account-Express-New-Gen/tree/main/openspec) — Artefactos SDD
