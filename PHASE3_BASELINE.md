# Phase 3 — Operation Controller Integration

## Objetivo del flujo protegido
Interceptar TODAS las escrituras de archivos que realiza la IA, incluyendo tanto las herramientas nativas de OpenCode (edit/write/apply_patch) como comandos shell que escriban archivos.

## Fecha
2026-07-28

## Commit inicial
<!-- SHA del primer commit de Fase 3 (solo este documento) -->

---

# Phase 3 Baseline — Before Integration

## Flujo actual

```
AI Model (LLM)
 ↓  llama tool nativo
OpenCode built-in tool (edit | write | apply_patch)
 ↓  escritura directa sobre filesystem (sin fs.writeFileSync confirmado)
Archivo escrito en disco
```

**Además:** la IA puede escribir mediante shell:
```
AI Model (LLM)
 ↓  invoca bash
OpenCode bash tool (Set-Content, echo, Out-File, etc.)
 ↓  escritura directa sobre filesystem
Archivo escrito en disco
```

## Evidencia

- **Operación concreta:** Crear y modificar archivos `.tsx`, `.ts`, `.css`, etc. durante el desarrollo asistido por IA.
- **Herramientas que escriben:**
  - `edit` — modifica archivos existentes
  - `write` — crea o sobrescribe archivos
  - `apply_patch` — aplica parches
  - `bash` — cualquier comando que escriba (Set-Content, echo>, Out-File, etc.)
- **Call stack (OpenCode nativo):**
  ```
  AI model
   → OpenCode tool call (edit/write/apply_patch)
   → escritura directa sobre filesystem
  ```
- **Call stack (shell bypass):**
  ```
  AI model
   → OpenCode bash tool
   → Set-Content | echo | Out-File
   → escritura directa sobre filesystem
  ```
- **No existe código JavaScript intermedio.** El SDK `@opencode-ai/sdk` es solo thin HTTP client y no contiene writeFile ni ninguna lógica de escritura.
- **No se inspeccionó el binario de OpenCode.** No se puede afirmar que use `fs.writeFileSync()` internamente. Se documenta como "escritura directa sobre filesystem mediante herramientas integradas".

### Configuración actual de permisos

| Tool   | Config        | Efecto                              |
|--------|---------------|-------------------------------------|
| `edit` | no definido   | Default `"ask"` (pregunta al usuario) |
| `bash` | `"*": "allow"`| **Sin restricción** — bypass total  |
| `read` | granular      | Restricciones solo para secrets     |

## OperationController
NO INTERVIENE

- `src/internal/operation-controller/resources/file-resource.ts` es código **muerto**: exporta `FileResource` con `execute()` que hace `fs.writeFileSync`, pero **ningún archivo en `src/` lo importa ni lo llama**.
- `controller.ts` solo se ejecuta en tests (`tests/operation-controller/controller.test.ts`).

## Conclusión
Existe un **doble bypass** en este flujo:
1. Herramientas nativas de edición (edit/write/apply_patch) sin control.
2. Shell con permisos `allow` que permite escritura arbitraria.

---

# Plan de Integración Propuesto

## Mecanismo: Custom Tool local de OpenCode

OpenCode permite herramientas personalizadas en `.opencode/tools/` como archivos TypeScript que usan el helper `tool()` de `@opencode-ai/plugin`. No requiere levantar un servidor MCP separado.

## Cambios realizados

### 1. Crear `.opencode/tools/operation-controller-write.ts`

Tool custom que:
- Recibe `filePath`, `content` y `operation` (create | modify)
- Construye un `Intent` con `observedPaths: [filePath]` y lo envía al `OperationController`
- Ejecuta el pipeline completo: Policy → Contract → Execute → Verify → Evidence
- Devuelve resultado exitoso o error

### 2. Snapshot — dos métodos, decisión explícita

`FileResource` expone dos métodos de snapshot:

| Método | Alcance | Uso |
|--------|---------|-----|
| `snapshot()` | Workspace completo | Tests, auditoría FULL futura |
| `snapshotObserved(paths)` | Solo rutas indicadas | Producción (vía Controller) |

`verificationScope` es **obligatorio** en `Intent` (no hay default silencioso — cada herramienta declara explícitamente `'scoped'` o `'full'`).

El Controller decide según `contract.verificationScope`:

- **`'scoped'`** (usado en esta iteración): usa `snapshotObserved(contract.observedPaths)` — rápido, no toca `node_modules`.
- **`'full'`** (no implementado aún): el Controller lo rechaza con `"FULL verification not implemented yet — use scoped"`. `snapshot()` (full workspace) existe como método en `FileResource` y funciona en entornos controlados (tests con tempdirs pequeños), pero no es operativo sobre workspaces reales por el problema de `node_modules`/symlinks. Se implementará cuando exista un mecanismo de exclusión de carpetas conocidas.

**Decisión arquitectónica explícita:** Esta iteración usa `verificationScope: 'scoped'`. La reducción de cobertura (pérdida de detección de mutaciones laterales fuera de `observedPaths`) es **deliberada y aceptada**. El campo `verificationScope` queda en el tipo como hook para cuando FULL esté implementado.

### 3. Modificar `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "deny",
    "bash": "deny",
    "task": "deny",
    "operation-controller-write": "allow"
  }
}
```

### 4. Verificar
- Tool nativo `edit` → bloqueado (deny)
- Tool nativo `write` → bloqueado (por `edit: deny`)
- Shell → bloqueado (deny)
- Custom tool `operation-controller-write` → disponible (los tools custom no son restringidos por `permission`)

## Riesgos y limitaciones
1. `bash: deny` bloquea también comandos inofensivos (ls, cat, grep, etc.). Esto es intencional como punto de partida seguro; en una iteración posterior se puede abrir un subconjunto de solo-lectura.
2. La verificación lateral solo cubre las rutas en `observedPaths`. La detección de mutaciones laterales sobre archivos no observados queda fuera del alcance de esta iteración.

---

# Phase 3 Result — After Integration

## Flujo final

```
AI Model (LLM)
 ↓  llama custom tool
operation-controller-write (custom tool en .opencode/tools/)
 ↓
OperationController.run()
 ↓
Policy.evaluate(intent) → granted | denied
 ↓
ContractFactory.create(...)
 ↓
Execute.run(contract, FileResource)
 ↓
FileResource.write(content, targetPath)
 ↓
Verify.verify(before, after) → detecta mutación lateral
 ↓
Evidence.record(...)
 ↓
fs.writeFileSync(targetPath, content, 'utf-8')
 ↓
Archivo escrito en disco
```

## Evidencia

- **Tests ejecutados:**
- **Suite global:**
- **tsc --noEmit:**
- **npm run build:**
- **Commit final:**

## Resultado
Los 7 criterios de aceptación fueron demostrados conforme al contrato de Fase 3.