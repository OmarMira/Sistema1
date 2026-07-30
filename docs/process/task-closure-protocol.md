# Protocolo de Cierre de Tareas (Task Closure Protocol)

**Document ID:** PRO-002
**Status:** Stable
**Last Updated:** 2026-07-30

---

## Objetivo

Garantizar que ninguna tarea o sprint se dé por terminado sin la debida consolidación documental, asegurando la trazabilidad, la integridad del repositorio y previniendo regresiones silenciosas.

---

## 1. Requisitos Previos al Cierre

Antes de declarar una tarea o hito como "completado" o "done", el agente **debe** verificar físicamente:

1. **Estado de Git:** `git status` limpio, sin cambios locales pendientes ni archivos temporales sueltos.
2. **Pipeline de Verificación:** 
   - Compilación exitosa (`npx tsc --noEmit`)
   - Linter sin errores (`npm run lint`)
   - Suite de tests pasando al 100% (`npm test` o similar)
3. **Persistencia Física:** Toda la evidencia o estado debe estar en el filesystem del repositorio, nunca únicamente en la memoria (Engram) del agente.

---

## 2. Consolidación Documental Obligatoria

Toda etapa o cambio significativo (N3 a N5) requiere actualizar o crear tres tipos de documentos:

### A. Architectural Decision Records (ADRs)
Si se tomó alguna decisión arquitectónica, de seguridad o de diseño:
- Debe registrarse en `docs/adr/ADR-[XXX]-[nombre-descriptivo].md`.
- Debe seguir el formato estándar: Status, Context, Decision, Consequences, Rationale, Related.

### B. Registro de Incidentes (INC)
Si ocurrió algún error, regresión, bloqueo de herramientas o desvío durante el desarrollo:
- Debe registrarse en `docs/incidents/INC-[XXX]-[nombre].md` (crear el directorio si no existe).
- Debe responder al esquema de Incident Management (`docs/runbooks/incident-management.md`).

### C. Sprint/History Consolidation
- Actualizar el historial del sprint correspondiente (ej. `docs/history/2026-07-stabilization.md`) detallando qué se hizo, qué decisiones clave se tomaron y qué queda pendiente.

---

## 3. Protocolo de Commit y Publicación

Los commits de documentación deben ser independientes de los commits de lógica de negocio o infraestructura para mantener la claridad de la historia de Git.

1. **Commit de Código/Fixes:** Commit enfocado con mensaje convencional.
2. **Commit de Documentación:** Confirmar físicamente la existencia de los nuevos archivos de docs, hacer un commit exclusivo para ellos:
   - `git add docs/`
   - `git commit -m "docs: consolidación documental sprint [X]"`
3. **Push & Sync:** Publicar los cambios a la rama de trabajo autorizada.

---

## 4. Regla de Oro del Cierre

> **"Un sprint no termina cuando el código funciona; termina cuando la documentación refleja fielmente por qué y cómo funciona, y toda evidencia está físicamente committeada y persistida."**

---

## Historial de Cambios

### v1.0 (2026-07-30)
- Creación del protocolo de cierre documental tras la finalización de la etapa de estabilización del Operation Controller.
